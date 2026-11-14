'use strict';

const fs = require('fs');
const path = require('path');
const { CgroupManager } = require('../lib/agent-cgroups');
const { LocalAgentStore } = require('../lib/agent-store');
const { validateAgentPolicy } = require('../lib/local-agent-policy');
const { createAgentServer } = require('../agent/server');

function readPolicy(filename) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('unsafe');
    const text = fs.readFileSync(filename, 'utf8');
    if (text.length > 1024 * 1024) throw new Error('large');
    return validateAgentPolicy(JSON.parse(text));
  } catch (_error) {
    throw new Error('The local execution policy is missing, invalid, or not root-managed');
  }
}

function configuredSecret() {
  const raw = process.env.CRONTAB_UI_AGENT_HMAC_SECRET;
  if (typeof raw !== 'string' || !/^[0-9a-f]{64,}$/i.test(raw)) {
    throw new Error('The local execution agent requires a 256-bit HMAC secret');
  }
  const secret = Buffer.from(raw, 'hex');
  if (secret.length < 32) throw new Error('The local execution agent HMAC secret is too short');
  delete process.env.CRONTAB_UI_AGENT_HMAC_SECRET;
  return secret;
}

function start() {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0) {
    throw new Error('The local execution agent requires Linux and a non-root service account');
  }
  const policyFile = process.env.CRONTAB_UI_AGENT_POLICY_FILE || '/etc/crontab-ui-agent/policy.json';
  const stateDirectory = process.env.CRONTAB_UI_AGENT_STATE_DIR || '/var/lib/crontab-ui-agent';
  const logDirectory = process.env.CRONTAB_UI_AGENT_LOG_DIR || '/var/log/crontab-ui-agent';
  const socketPath = process.env.CRONTAB_UI_AGENT_SOCKET || '/run/crontab-ui-agent/agent.sock';
  const wrapperPath = process.env.CRONTAB_UI_AGENT_EXEC_WRAPPER || '/usr/local/libexec/crontab-ui-agent-exec';
  const policy = readPolicy(policyFile);
  const secret = configuredSecret();
  const store = new LocalAgentStore({ filename: path.join(stateDirectory, 'agent.db') });
  const cgroups = new CgroupManager({
    memoryMaxBytes: policy.memory_max_bytes,
    cpuQuotaPercent: policy.cpu_quota_percent,
    pidsMax: policy.pids_max,
  });
  const socketGid = process.env.CRONTAB_UI_AGENT_SOCKET_GID === undefined
    ? process.getgid() : Number(process.env.CRONTAB_UI_AGENT_SOCKET_GID);
  if (!Number.isSafeInteger(socketGid) || socketGid < 0) throw new Error('Invalid local agent socket group');
  const agent = createAgentServer({
    cgroups,
    killGraceMs: Number(process.env.CRONTAB_UI_AGENT_KILL_GRACE_MS || 5000),
    logDirectory,
    policy,
    secret,
    socketGid,
    socketPath,
    store,
    wrapperPath,
  });
  const server = agent.listen();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    agent.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { agent, server, store };
}

if (require.main === module) {
  try {
    start();
  } catch (error) {
    console.error(`Crontab UI local agent refused to start: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { readPolicy, start };
