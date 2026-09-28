'use strict';

const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const { buildTaskEnvironment } = require('./config/task-environment');

function configuredCronUser() {
  const user = process.env.CRON_USER || 'node';
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)) {
    throw new Error('CRON_USER is invalid');
  }
  return user;
}

function schedulerEnvironment() {
  const user = configuredCronUser();
  return {
    ...buildTaskEnvironment(),
    HOME: '/home/node',
    LOGNAME: user,
    USER: user,
  };
}

function schedulerReloadStateFile(cronFile) {
  return `${cronFile}.reload.json`;
}

function writeReloadState(cronFile) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(cronFile)).digest('hex');
  const destination = schedulerReloadStateFile(cronFile);
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify({ digest, reloadedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(temporary, destination);
}

function forwardSchedulerOutput(stream, destination, cronFile) {
  let pending = '';
  stream.on('data', (chunk) => {
    destination.write(chunk);
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (line.includes('read crontab:')) {
        try {
          writeReloadState(cronFile);
        } catch (error) {
          console.error(`Unable to record scheduler reload: ${error.message}`);
        }
      }
    }
  });
}

function startScheduler({ spawnProcess = spawn } = {}) {
  const cronPath = process.env.CRON_PATH;
  if (!cronPath) throw new Error('CRON_PATH is required in Docker');
  const cronFile = path.join(cronPath, configuredCronUser());
  const scheduler = spawnProcess('supercronic', ['-inotify', '-passthrough-logs', cronFile], {
    env: schedulerEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  forwardSchedulerOutput(scheduler.stdout, process.stdout, cronFile);
  forwardSchedulerOutput(scheduler.stderr, process.stderr, cronFile);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => scheduler.kill(signal));
  }
  scheduler.once('exit', (code, signal) => {
    process.exitCode = code === null ? 1 : code;
    if (signal) process.exitCode = 1;
  });
  return scheduler;
}

if (require.main === module) startScheduler();

module.exports = { configuredCronUser, schedulerEnvironment, schedulerReloadStateFile, startScheduler, writeReloadState };
