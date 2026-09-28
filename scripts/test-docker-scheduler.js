'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');

const image = 'crontab-ui-scheduler-test';
const container = `crontab-ui-scheduler-test-${crypto.randomUUID().slice(0, 8)}`;

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
    image,
  ]);
  waitForHealthyContainer();

  const publishScript = [
    "const crontab = require('/crontab-ui/crontab');",
    "const create = () => new Promise((resolve, reject) => crontab.create_new('scheduler-uid-check', 'id -u > /tmp/crontab-ui-scheduled-uid.txt', '* * * * *', false, {}, {}, (error) => error ? reject(error) : resolve()));",
    'const publish = () => new Promise((resolve, reject) => crontab.set_crontab({}, (error) => error ? reject(error) : resolve()));',
    'create().then(publish).catch((error) => { console.error(error); process.exitCode = 1; });',
  ].join(' ');
  docker(['exec', '--user', 'node', container, 'node', '-e', publishScript], { stdio: 'inherit' });

  const deadline = Date.now() + 90000;
  let uid = '';
  while (Date.now() < deadline && !uid) {
    wait(1000);
    uid = readScheduledUid();
  }
  if (uid !== '1000') throw new Error(`Scheduled task ran as ${uid || 'no user'} instead of node (1000)`);
  console.log('Docker scheduler integration test passed: scheduled task ran as uid=1000(node).');
} finally {
  try {
    docker(['stop', container]);
  } catch (_error) {
    // The container may not have been created if the build failed.
  }
}
