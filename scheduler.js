'use strict';

const path = require('path');
const { spawn } = require('child_process');
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

function startScheduler({ spawnProcess = spawn } = {}) {
  const cronPath = process.env.CRON_PATH;
  if (!cronPath) throw new Error('CRON_PATH is required in Docker');
  const cronFile = path.join(cronPath, configuredCronUser());
  const scheduler = spawnProcess('supercronic', ['-inotify', '-passthrough-logs', cronFile], {
    env: schedulerEnvironment(),
    stdio: 'inherit',
  });

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

module.exports = { configuredCronUser, schedulerEnvironment, startScheduler };
