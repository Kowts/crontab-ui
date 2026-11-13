'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The published schedule is mirrored on the data volume so that recreating the container, or
// mounting the image root read-only, does not lose what the scheduler is running.
function persistedScheduleFile(dataDir, user) {
  return path.join(dataDir, 'schedule', user);
}

function writeAtomic(destination, contents) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function persistSchedule(dataDir, user, cronFile) {
  writeAtomic(persistedScheduleFile(dataDir, user), fs.readFileSync(cronFile));
}

// Returns 'restored', 'unchanged' or 'absent'. A copy that supercronic cannot parse is never
// installed, so a corrupted volume file cannot stop the scheduler from starting.
function restoreSchedule(dataDir, user, cronFile, { validate = () => {} } = {}) {
  const source = persistedScheduleFile(dataDir, user);
  if (!fs.existsSync(source)) return 'absent';
  const contents = fs.readFileSync(source);
  if (fs.existsSync(cronFile) && fs.readFileSync(cronFile).equals(contents)) return 'unchanged';
  validate(source);
  writeAtomic(cronFile, contents);
  return 'restored';
}

module.exports = { persistSchedule, persistedScheduleFile, restoreSchedule };
