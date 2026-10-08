'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const assert = require('assert/strict');

const image = 'crontab-ui-scheduler-test';
const container = `crontab-ui-scheduler-test-${crypto.randomUUID().slice(0, 8)}`;
const databasePath = '/tmp/crontab-ui integration data';

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readScheduledUid() {
  try {
    return docker(['exec', container, 'cat', '/tmp/crontab-ui-scheduled-uid.txt']).trim();
  } catch (_error) {
    return '';
  }
}

function readExecutionResults() {
  const script = [
    "const crontab = require('/crontab-ui/crontab');",
    'crontab.crontabs(jobs => {',
    "const success = jobs.find(job => job.name === 'scheduler-uid-check');",
    "const timeout = jobs.find(job => job.name === 'scheduler-timeout-check');",
    'crontab.get_installed_crontab((error, installed) => {',
    'if (error) throw error;',
    'console.log(JSON.stringify({ databasePath: crontab.db_folder, installed,',
    'success: success && crontab.getExecutionPanel(success).lastRun,',
    'timeout: timeout && crontab.getExecutionPanel(timeout).lastRun }));',
    'crontab.close_db(); }); });',
  ].join(' ');
  try {
    const output = docker(['exec', '--user', 'node', container, 'node', '-e', script]);
    return JSON.parse(output.trim().split(/\r?\n/).at(-1));
  } catch (_error) {
    return null;
  }
}

function waitForHealthyContainer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const health = docker(['inspect', '--format', '{{.State.Health.Status}}', container]).trim();
    if (health === 'healthy') return;
    wait(500);
  }
  throw new Error('Docker scheduler test container did not become healthy');
}

try {
  docker(['build', '--tag', image, '.'], { stdio: 'inherit' });
  docker([
    'run', '--detach', '--rm', '--name', container,
    '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--security-opt', 'no-new-privileges:true',
    '--env', 'BASIC_AUTH_USERS_JSON={"admin":"test-only"}',
    '--env', 'AUTHZ_ROLE_MAP_JSON={"admin":"admin"}',
    '--env', 'CSRF_SECRET=test-only-csrf-secret',
    '--env', 'TRUSTED_PROXY=127.0.0.1',
    '--env', `CRON_DB_PATH=${databasePath}`,
    '--env', 'COMMAND_TIMEOUT_MS=5000',
    '--env', 'TASK_ENV_ALLOWLIST=PATH,LANG,LC_ALL,TZ,MAILTO',
    image,
  ]);
  waitForHealthyContainer();

  const publishScript = [
    "const crontab = require('/crontab-ui/crontab');",
    "const create = (name, command) => new Promise((resolve, reject) => crontab.create_new(name, command, '* * * * *', false, {}, {}, (error) => error ? reject(error) : resolve()));",
    'const publish = () => new Promise((resolve, reject) => crontab.set_crontab({}, (error) => error ? reject(error) : resolve()));',
    "create('scheduler-uid-check', 'sleep 2; id -u > /tmp/crontab-ui-scheduled-uid.txt')",
    ".then(() => create('scheduler-timeout-check', 'sleep 30'))",
    '.then(publish).catch((error) => { console.error(error); process.exitCode = 1; });',
  ].join(' ');
  docker(['exec', '--user', 'node', container, 'node', '-e', publishScript], { stdio: 'inherit' });

  const deadline = Date.now() + 90000;
  let uid = '';
  let results = null;
  while (Date.now() < deadline) {
    wait(1000);
    uid = readScheduledUid();
    if (uid === '1000') {
      results = readExecutionResults();
      if (results?.success && results?.timeout) break;
    }
  }
  if (uid !== '1000') throw new Error(`Scheduled task ran as ${uid || 'no user'} instead of node (1000)`);
  assert.ok(results?.success && results?.timeout, 'Scheduled execution history was not persisted');
  assert.equal(results.databasePath, databasePath);
  assert.equal(results.installed.confirmed, true);
  assert.ok(results.installed.content.includes(`CRON_DB_PATH='${databasePath}' COMMAND_TIMEOUT_MS=5000`));
  assert.equal(results.success.status, 'completed');
  assert.equal(results.success.exitCode, 0);
  assert.equal(results.timeout.status, 'failed');
  assert.equal(results.timeout.terminationReason, 'timeout');
  assert.equal(results.timeout.signal, 'SIGTERM');
  assert.ok(results.timeout.durationMs >= 5000 && results.timeout.durationMs < 15000);
  for (const run of [results.success, results.timeout]) {
    assert.equal(run.runtime.timeoutMs, 5000);
    assert.equal(run.runtime.version, require('../package.json').version);
    assert.match(run.runtime.codeHash, /^[a-f0-9]{64}$/);
    assert.ok(run.runtime.hostname && run.runtime.pid > 0);
  }
  assert.notEqual(results.success.runtime.pid, results.timeout.runtime.pid);
  console.log('Docker scheduler integration passed: uid=1000, custom database, confirmed reload and effective 5000ms timeout.');
} finally {
  try {
    docker(['stop', container]);
  } catch (_error) {
    // The container may not have been created if the build failed.
  }
}
