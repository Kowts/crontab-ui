'use strict';

// Integration test for container recreation, restart and the optional read-only root filesystem.
//   RESILIENCE_IMAGE   image under test (default: crontab-ui-resilience-test, built from this checkout)
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const assert = require('assert/strict');

const suffix = crypto.randomUUID().slice(0, 8);
const image = process.env.RESILIENCE_IMAGE || 'crontab-ui-resilience-test';
const volume = `cui-res-${suffix}`;
const containers = [];
const dataPath = '/crontab-ui/crontabs';
const readOnlyArgs = [
  '--read-only',
  '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
  '--tmpfs', '/var/log:rw,noexec,nosuid,size=16m',
  '--tmpfs', '/etc/crontabs:rw,noexec,nosuid,uid=1000,gid=1000,mode=0700,size=1m',
];

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitHealthy(name) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      docker(['exec', name, 'curl', '-fsS', 'http://localhost:8000/healthz']);
      return;
    } catch (_error) {
      sleep(500);
    }
  }
  throw new Error(`Container ${name} did not become healthy: ${docker(['logs', name])}`);
}

function start(extraArgs = []) {
  const name = `cui-res-svc-${crypto.randomUUID().slice(0, 6)}`;
  containers.push(name);
  docker(['run', '-d', '--name', name, '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
    '--security-opt', 'no-new-privileges:true', '-v', `${volume}:${dataPath}`,
    '-e', 'BASIC_AUTH_USERS_JSON={"admin":"x"}', '-e', 'AUTHZ_ROLE_MAP_JSON={"admin":"admin"}',
    '-e', `CSRF_SECRET=${'a'.repeat(40)}`, '-e', 'ALLOW_HTTP=true', ...extraArgs, image]);
  waitHealthy(name);
  return name;
}

function installedSchedule(name) {
  return docker(['exec', '-u', 'node', name, 'cat', '/etc/crontabs/node']);
}

function publish(name) {
  const script = `
    const c=require('/crontab-ui/crontab');
    c.create_new('resilience','echo resilient','*/7 * * * *',false,{},{},()=>{
      c.set_crontab('',(e)=>{ if(e){console.error(e.message);process.exit(1);} console.log('published'); c.close_db(); process.exit(0); });
    });`;
  assert.match(docker(['exec', '-u', 'node', name, 'node', '-e', script]), /published/);
}

function remove(name) {
  docker(['rm', '-f', name]);
}

try {
  if (!process.env.RESILIENCE_IMAGE) docker(['build', '--tag', image, '.'], { stdio: 'inherit' });
  docker(['volume', 'create', volume]);

  // Publish, then recreate the container: the schedule must come back from the data volume.
  let name = start();
  publish(name);
  assert.match(installedSchedule(name), /\*\/7 \* \* \* \*/);
  remove(name);
  name = start();
  assert.match(installedSchedule(name), /\*\/7 \* \* \* \*/, 'schedule lost after recreating the container');

  // A plain restart keeps the schedule and the service.
  docker(['restart', name]);
  waitHealthy(name);
  assert.match(installedSchedule(name), /\*\/7 \* \* \* \*/, 'schedule lost after restart');
  remove(name);

  // Read-only root filesystem with tmpfs mounts: same guarantee, and publishing still works.
  name = start(readOnlyArgs);
  assert.match(installedSchedule(name), /\*\/7 \* \* \* \*/, 'schedule not restored on a read-only root');
  publish(name);
  remove(name);
  console.log('Docker resilience test passed.');
} finally {
  containers.forEach((name) => { try { docker(['rm', '-f', name]); } catch (_error) { /* already removed */ } });
  try { docker(['volume', 'rm', '-f', volume]); } catch (_error) { /* already removed */ }
}
