'use strict';

// Integration test for disaster recovery and rollback with real images.
//   RECOVERY_OLD_IMAGE   image of the previous release (default: build not attempted, test skipped)
//   RECOVERY_NEW_IMAGE   image under test (default: crontab-ui-recovery-test, built from this checkout)
// Scenarios: (1) restore a backup into a clean volume and start the service on it;
// (2) roll the data volume back to the previous release image and read the task again.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const assert = require('assert/strict');

const suffix = crypto.randomUUID().slice(0, 8);
const newImage = process.env.RECOVERY_NEW_IMAGE || 'crontab-ui-recovery-test';
const oldImage = process.env.RECOVERY_OLD_IMAGE;
const volumes = [`cui-rec-src-${suffix}`, `cui-rec-clean-${suffix}`];
const containers = [];
const dataPath = '/crontab-ui/crontabs';

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function runNode(image, volume, script) {
  const out = docker(['run', '--rm', '--user', 'node', '-v', `${volume}:${dataPath}`, '--entrypoint', 'node', image, '-e', script]);
  return out.trim().split(/\r?\n/).at(-1);
}

const listJobs = "const c=require('/crontab-ui/crontab');c.crontabs(j=>{console.log(JSON.stringify(j.map(x=>x.name)));c.close_db();});";

function startService(image, volume) {
  const name = `cui-rec-svc-${crypto.randomUUID().slice(0, 6)}`;
  containers.push(name);
  docker(['run', '-d', '--name', name, '-v', `${volume}:${dataPath}`,
    '-e', 'BASIC_AUTH_USERS_JSON={"admin":"x"}', '-e', 'AUTHZ_ROLE_MAP_JSON={"admin":"admin"}',
    '-e', `CSRF_SECRET=${'a'.repeat(40)}`, '-e', 'ALLOW_HTTP=true', image]);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      docker(['exec', name, 'curl', '-fsS', 'http://localhost:8000/healthz']);
      return name;
    } catch (_error) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  throw new Error(`Service on ${image} did not become healthy: ${docker(['logs', name])}`);
}

try {
  if (!process.env.RECOVERY_NEW_IMAGE) docker(['build', '--tag', newImage, '.'], { stdio: 'inherit' });
  volumes.forEach((volume) => docker(['volume', 'create', volume]));

  // Source installation: create a task and a backup.
  const backupName = runNode(newImage, volumes[0], `
    const c=require('/crontab-ui/crontab');
    c.create_new('recovery-check','echo ok','* * * * *',false,{},{},()=>{
      c.backup(()=>{console.log(c.get_backup_names()[0]);c.close_db();});
    });`);
  assert.match(backupName, /^backup-.*\.db$/);

  // (1) Clean installation: copy only the backup file, restore it and start the service.
  const holder = `cui-rec-copy-${suffix}`;
  containers.push(holder);
  docker(['create', '--name', holder, '-v', `${volumes[0]}:/src`, '-v', `${volumes[1]}:/dst`, '--entrypoint', 'sh', newImage, '-c',
    `chown node:node /dst && cp /src/${backupName} /dst/${backupName} && chown node:node /dst/${backupName}`]);
  docker(['start', '-a', holder]);
  runNode(newImage, volumes[1], `
    const c=require('/crontab-ui/crontab');
    c.restore(${JSON.stringify(backupName)},(e)=>{ if(e) throw e; console.log('restored'); c.close_db(); });`);
  const restored = runNode(newImage, volumes[1], listJobs);
  assert.deepEqual(JSON.parse(restored), ['recovery-check']);
  const cleanService = startService(newImage, volumes[1]);
  docker(['rm', '-f', cleanService]);

  // (2) Rollback: the previous release reads the data written by the new one.
  if (oldImage) {
    const old = runNode(oldImage, volumes[0], listJobs);
    assert.deepEqual(JSON.parse(old), ['recovery-check']);
    const oldService = startService(oldImage, volumes[0]);
    docker(['rm', '-f', oldService]);
    console.log('Rollback to previous release verified.');
  } else {
    console.log('RECOVERY_OLD_IMAGE not set: rollback scenario skipped.');
  }
  console.log('Docker recovery test passed.');
} finally {
  containers.forEach((name) => { try { docker(['rm', '-f', name]); } catch (_error) { /* already removed */ } });
  volumes.forEach((volume) => { try { docker(['volume', 'rm', '-f', volume]); } catch (_error) { /* already removed */ } });
}
