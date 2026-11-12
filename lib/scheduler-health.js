'use strict';

const fs = require('fs');

// Looks for a running process by executable name through /proc (Linux only).
function processRunning(name, procRoot = '/proc') {
  let entries;
  try {
    entries = fs.readdirSync(procRoot);
  } catch (_error) {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv0 = fs.readFileSync(`${procRoot}/${entry}/cmdline`, 'utf8').split('\0')[0];
      if (argv0.split('/').pop() === name) return true;
    } catch (_error) { /* the process exited while scanning */ }
  }
  return false;
}

// Scheduler health is reported separately from web health: the web process answering says
// nothing about whether scheduled tasks are being fired. `running` is null when the scheduler
// cannot be observed from this process (native cron), never a guess.
function schedulerHealth({ inDocker, procRoot, readReloadState }) {
  const lastReload = readReloadState ? readReloadState() : null;
  if (!inDocker) return { mode: 'native', running: null, monitored: false, lastReload };
  const running = processRunning('supercronic', procRoot);
  return { mode: 'docker', running, monitored: running !== null, lastReload };
}

module.exports = { schedulerHealth, processRunning };
