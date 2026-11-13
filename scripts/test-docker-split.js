'use strict';

// Integration test for the optional split deployment (web and scheduler in separate containers).
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const assert = require('assert/strict');

const project = `cui-split-${crypto.randomUUID().slice(0, 6)}`;
const env = {
  ...process.env,
  BASIC_AUTH_USERS_JSON: '{"admin":"x"}',
  AUTHZ_ROLE_MAP_JSON: '{"admin":"admin"}',
  CSRF_SECRET: 'a'.repeat(40),
  ALLOW_HTTP: 'true',
};
const files = ['-f', 'docker-compose.yml', '-f', 'docker-compose.split.yml'];

function compose(args, options = {}) {
  return execFileSync('docker', ['compose', '-p', project, ...files, ...args],
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function web(args) {
  return compose(['exec', '-T', 'crontab-ui', ...args]);
}

function schedulerState() {
  const script = `
    const http=require('http');
    http.get('http://127.0.0.1:8000/diagnostics',(r)=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log(b));}).on('error',e=>{console.error(e.message);process.exit(1);});`;
  return JSON.parse(web(['node', '-e', script])).scheduler;
}

function waitFor(predicate, message) {
  const deadline = Date.now() + 45000;
  let last;
  while (Date.now() < deadline) {
    try {
      last = predicate();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    sleep(1000);
  }
  throw new Error(`${message}: ${last}`);
}

try {
  compose(['up', '-d', '--build'], { stdio: 'inherit' });
  waitFor(() => schedulerState().running === true, 'web never saw the scheduler heartbeat');

  const publish = `
    const c=require('/crontab-ui/crontab');
    c.create_new('split','echo split','*/9 * * * *',false,{},{},()=>{
      c.set_crontab('',(e)=>{ if(e){console.error(e.message);process.exit(1);} console.log('published'); c.close_db(); process.exit(0); });
    });`;
  assert.match(web(['node', '-e', publish]), /published/);
  const installed = compose(['exec', '-T', 'scheduler', 'cat', '/crontab-ui/crontabs/schedule-live/node']);
  assert.match(installed, /\*\/9 \* \* \* \*/, 'scheduler container did not receive the published schedule');

  compose(['stop', 'scheduler']);
  waitFor(() => schedulerState().running === false, 'web did not notice the scheduler stopping');
  console.log('Docker split deployment test passed.');
} finally {
  try { compose(['down', '-v', '--remove-orphans']); } catch (_error) { /* already removed */ }
}
