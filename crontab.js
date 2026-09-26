'use strict';

const Datastore = require('@seald-io/nedb');
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { CronExpressionParser } = require('cron-parser');
const cronstrue = require('cronstrue/i18n');
const { getProfile } = require('./config/mail-profiles');
const { execute } = require('./execution');
const { parseEnvironment, serialiseEnvironment } = require('./config/environment');

const humanCronLocale = process.env.HUMANCRON ?? 'en';

const dbFolder = process.env.CRON_DB_PATH || path.join(__dirname, 'crontabs');
console.log(`Cron db path: ${dbFolder}`);

const logFolder = path.join(dbFolder, 'logs');
const auditFile = path.join(logFolder, 'operations.jsonl');
const envFile = path.join(dbFolder, 'env.db');
const crontabDbFile = path.join(dbFolder, 'crontab.db');

const db = new Datastore({ filename: crontabDbFile, autocompactionInterval: 60000 });
const commandTimeoutMs = Number(process.env.COMMAND_TIMEOUT_MS || 300000);
const commandMaxBuffer = Number(process.env.COMMAND_MAX_BUFFER || 1024 * 1024);
const commandKillGraceMs = Number(process.env.COMMAND_KILL_GRACE_MS || 5000);
const maxLogBytes = Number(process.env.LOG_MAX_BYTES || 10 * 1024 * 1024);
const logRotationCount = Number(process.env.LOG_ROTATION_COUNT || 5);
const logRetentionDays = Number(process.env.LOG_RETENTION_DAYS || 30);
const backupRetentionCount = Number(process.env.BACKUP_RETENTION_COUNT || 30);
const backupRetentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 90);

let cronPath = '/tmp';
let databaseOperationActive = false;
if (process.env.CRON_PATH !== undefined) {
  console.log(`Path to crond files set using env variables ${process.env.CRON_PATH}`);
  cronPath = process.env.CRON_PATH;
}

db.loadDatabase((err) => {
  if (err) throw err;
});

if (!fs.existsSync(logFolder)) {
  fs.mkdirSync(logFolder);
}

function buildCrontab(name, command, schedule, stopped, logging, mailing, ownership = {}) {
  return {
    name,
    command,
    schedule,
    ...(stopped !== null && { stopped }),
    timestamp: new Date().toString(),
    logging,
    mailing: mailing || {},
    ...(ownership.owner && { owner: ownership.owner }),
    ...(ownership.createdBy && { createdBy: ownership.createdBy }),
  };
}

function makeCommand(tab) {
  return `"${process.execPath}" "${path.join(__dirname, 'bin', 'crontab-ui-runner.js')}" ${tab._id}`;
}

exports.db_folder = dbFolder;
exports.log_folder = logFolder;
exports.audit_file = auditFile;
exports.env_file = envFile;
exports.crontab_db_file = crontabDbFile;

exports.create_new = (name, command, schedule, logging, mailing, ownership = {}, callback = () => {}) => {
  const tab = buildCrontab(name, command, schedule, false, logging, mailing, ownership);
  tab.created = Date.now();
  tab.saved = false;
  db.insert(tab, callback);
};

exports.update = (_id, data, callback = () => {}) => {
  if (typeof _id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(_id)) {
    return callback(new Error('Invalid job id'));
  }
  const tab = buildCrontab(data.name, data.command, data.schedule, null, data.logging, data.mailing);
  tab.saved = false;
  db.update({ _id }, { $set: tab }, callback);
};

exports.status = (_id, stopped, callback = () => {}) => {
  db.update({ _id }, { $set: { stopped, saved: false } }, callback);
};

exports.remove = (_id, callback = () => {}) => {
  db.remove({ _id }, {}, callback);
};

exports.crontabs = (callback) => {
  db.find({}).sort({ created: -1 }).exec((err, docs) => {
    if (err) {
      console.error(err);
      return callback([]);
    }
    for (const doc of docs) {
      if (doc.schedule === '@reboot') {
        doc.next = 'Next Reboot';
      } else {
        try {
          doc.human = cronstrue.toString(doc.schedule, { locale: humanCronLocale });
          doc.next = CronExpressionParser.parse(doc.schedule).next().toString();
        } catch (e) {
          console.error(e);
          doc.next = 'invalid';
        }
      }
    }
    callback(docs);
  });
};

exports.get_crontab = (_id, callback) => {
  db.find({ _id }).exec((err, docs) => {
    callback(docs[0]);
  });
};

function audit(event) {
  try {
    rotateLog(auditFile);
    const entry = `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`;
    let writeError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.appendFileSync(auditFile, entry, { encoding: 'utf8', mode: 0o600 });
        return;
      } catch (error) {
        writeError = error;
        if (error.code !== 'EBUSY' || attempt === 2) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    throw writeError;
  } catch (error) {
    // Audit failures must not make a scheduled job unavailable, but must remain visible.
    console.error('Unable to write audit record:', error.message);
  }
}

exports.audit = audit;

function rotateLog(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size < maxLogBytes) return;
  if (logRotationCount < 1) return;
  const oldest = `${file}.${logRotationCount}`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  for (let index = logRotationCount - 1; index >= 1; index -= 1) {
    const source = `${file}.${index}`;
    const destination = `${file}.${index + 1}`;
    if (fs.existsSync(source)) {
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
      fs.renameSync(source, destination);
    }
  }
  if (fs.existsSync(`${file}.1`)) fs.unlinkSync(`${file}.1`);
  fs.renameSync(file, `${file}.1`);
}

function writeOutput(file, content) {
  rotateLog(file);
  const remaining = Math.max(0, maxLogBytes - (fs.existsSync(file) ? fs.statSync(file).size : 0));
  if (remaining) fs.appendFileSync(file, content.subarray(0, remaining));
}

function recordOutput(tab, result) {
  const stdout = path.join(cronPath, `${tab._id}.stdout`);
  const stderr = path.join(cronPath, `${tab._id}.stderr`);
  fs.writeFileSync(stdout, result.stdout);
  fs.writeFileSync(stderr, result.stderr);
  if (tab.logging === true || tab.logging === 'true') {
    writeOutput(path.join(logFolder, `${tab._id}.stdout.log`), result.stdout);
    writeOutput(path.join(logFolder, `${tab._id}.log`), result.stderr);
  }
  return { stdout, stderr };
}

function sendMail(tab, files) {
  if (!tab.mailing?.profileId) return;
  const child = spawn(process.execPath, [path.join(__dirname, 'bin', 'crontab-ui-mailer.js'), tab._id, files.stdout, files.stderr], {
    detached: false,
    stdio: 'ignore',
  });
  child.unref();
}

function applyRetention() {
  const cutoff = Date.now() - (logRetentionDays * 24 * 60 * 60 * 1000);
  try {
    for (const file of fs.readdirSync(logFolder)) {
      const fullPath = path.join(logFolder, file);
      const stat = fs.lstatSync(fullPath);
      if (file !== path.basename(auditFile) && stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(fullPath);
    }
  } catch (error) {
    audit({ type: 'retention', status: 'failed', scope: 'logs', error: error.message });
  }

  try {
    const backupCutoff = Date.now() - (backupRetentionDays * 24 * 60 * 60 * 1000);
    const backups = exports.get_backup_names();
    const expired = backups.filter((backup, index) => {
      const ageExpired = fs.statSync(path.join(dbFolder, backup)).mtimeMs < backupCutoff;
      return index >= backupRetentionCount || ageExpired;
    });
    for (const backup of expired) fs.unlinkSync(path.join(dbFolder, backup));
  } catch (error) {
    audit({ type: 'retention', status: 'failed', scope: 'backups', error: error.message });
  }
}

exports.runjob = (_id, auditContext = {}, callback = () => {}) => {
  if (typeof auditContext === 'function') {
    callback = auditContext;
    auditContext = {};
  }
  db.find({ _id }).exec((err, docs) => {
    if (err || !docs.length) return callback(err || new Error('Job not found'));
    const res = docs[0];
    let jobEnvironment;
    try {
      jobEnvironment = parseEnvironment(exports.get_env());
    } catch (environmentError) {
      return callback(environmentError);
    }
    const cmd = res.command;

    const operationId = crypto.randomUUID();
    audit({ operationId, type: 'runjob', jobId: _id, status: 'started', ...auditContext });

    execute(cmd, { timeoutMs: commandTimeoutMs, maxOutputBytes: commandMaxBuffer, killGraceMs: commandKillGraceMs, env: { ...process.env, ...jobEnvironment } }, (error, result) => {
      const files = recordOutput(res, result);
      sendMail(res, files);
      applyRetention();
      audit({ operationId, type: 'runjob', jobId: _id, status: error ? 'failed' : 'completed', exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, terminationReason: result.terminationReason, outputExceeded: result.outputExceeded, error: error?.message, ...auditContext });
      callback(error, { operationId, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, terminationReason: result.terminationReason });
    });
  });
};

exports.set_crontab = (environment, callback) => {
  const envVars = serialiseEnvironment(environment);
  exports.crontabs((tabs) => {
    let crontabString = '';
    if (envVars) {
      crontabString += `${envVars}\n`;
    }
    for (const tab of tabs) {
      if (!tab.stopped) {
        crontabString += `${tab.schedule} ${makeCommand(tab)}\n`;
      }
    }

    fs.writeFile(envFile, envVars, (err) => {
      if (err) {
        console.error(err);
        return callback(err);
      }
      const fileName = process.env.CRON_IN_DOCKER !== undefined ? 'root' : 'crontab';
      fs.writeFile(path.join(cronPath, fileName), crontabString, (err) => {
        if (err) {
          console.error(err);
          return callback(err);
        }
        exec(`crontab ${path.join(cronPath, fileName)}`, (err) => {
          if (err) {
            console.error(err);
            return callback(err);
          }
          db.update({}, { $set: { saved: true } }, { multi: true });
          callback();
        });
      });
    });
  });
};

exports.get_backup_names = () => {
  if (!fs.existsSync(dbFolder)) return [];
  const backups = fs.readdirSync(dbFolder)
    .filter((file) => /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/.test(file))
    .filter((file) => {
      try {
        return fs.statSync(path.join(dbFolder, file)).isFile();
      } catch (_error) {
        return false;
      }
    });

  const backupDate = (name) => {
    const t = name.split('backup')[1];
    return new Date(t.substring(0, t.length - 3)).valueOf();
  };

  backups.sort((a, b) => backupDate(b) - backupDate(a));
  return backups;
};

function writeAtomicFile(destination, contents, callback) {
  const temporaryFile = path.join(dbFolder, `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  fs.open(temporaryFile, 'wx', 0o600, (openError, descriptor) => {
    if (openError) return callback(openError);
    return fs.writeFile(descriptor, contents, (writeError) => {
      if (writeError) {
        fs.close(descriptor, () => fs.unlink(temporaryFile, () => callback(writeError)));
        return;
      }
      return fs.fsync(descriptor, (syncError) => fs.close(descriptor, (closeError) => {
        if (syncError || closeError) {
          return fs.unlink(temporaryFile, () => callback(syncError || closeError));
        }
        return fs.rename(temporaryFile, destination, (renameError) => {
          if (renameError) return fs.unlink(temporaryFile, () => callback(renameError));
          return callback(null);
        });
      }));
    });
  });
}

function backupDatabase(callback) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dbFolder, `backup-${timestamp}.db`);
  const copyDatabase = () => fs.mkdir(dbFolder, { recursive: true }, (mkdirErr) => {
    if (mkdirErr) return callback(mkdirErr);
    return writeAtomicFile(
      dest,
      db.getAllData().map((document) => JSON.stringify(document)).join('\n'),
      (err) => {
        if (err) {
          console.error(err);
          return callback(err);
        }
        applyRetention();
        return callback(null, path.basename(dest));
      }
    );
  });

  db.compactDatafile((err) => {
    if (err) return callback(err);
    return copyDatabase();
  });
}

function withDatabaseLock(operation, callback) {
  if (databaseOperationActive) {
    const error = new Error('Another database operation is already in progress');
    error.statusCode = 409;
    return callback(error);
  }
  databaseOperationActive = true;
  return operation((...args) => {
    databaseOperationActive = false;
    callback(...args);
  });
}

exports.backup = (callback = () => {}) => withDatabaseLock(backupDatabase, callback);

function validateDatabaseFile(fileName, callback) {
  const candidate = new Datastore({ filename: fileName });
  candidate.loadDatabase((err) => {
    if (err) return callback(err);
    return candidate.find({}).exec((findErr) => callback(findErr));
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validateImportedJob(document) {
  if (!isPlainObject(document)) throw new Error('Imported record must be an object');
  for (const key of Object.keys(document)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new Error('Imported record contains a dangerous property');
    }
  }

  const accepted = new Set(['_id', 'name', 'command', 'schedule', 'stopped', 'logging', 'mailing', 'timestamp', 'created', 'saved', 'hook', 'owner', 'createdBy']);
  for (const key of Object.keys(document)) {
    if (!accepted.has(key)) throw new Error(`Unsupported imported field: ${key}`);
  }

  if (typeof document.name !== 'string' || document.name.length > 128 || /[\r\n]/.test(document.name)) {
    throw new Error('Imported job has an invalid name');
  }
  if (typeof document.command !== 'string' || !document.command.trim() || document.command.length > 2000 || /[\r\n]/.test(document.command)) {
    throw new Error('Imported job has an invalid command');
  }
  if (typeof document.schedule !== 'string' || document.schedule.length > 128 || /[\r\n]/.test(document.schedule)) {
    throw new Error('Imported job has an invalid schedule');
  }
  if (document.schedule !== '@reboot') CronExpressionParser.parse(document.schedule);
  if (document.stopped !== undefined && document.stopped !== null && typeof document.stopped !== 'boolean') {
    throw new Error('Imported job has an invalid stopped state');
  }
  if (document.logging !== undefined && typeof document.logging !== 'boolean' && document.logging !== 'true' && document.logging !== 'false') {
    throw new Error('Imported job has an invalid logging setting');
  }
  if (document.mailing !== undefined) {
    if (!isPlainObject(document.mailing) || Object.keys(document.mailing).some((key) => key !== 'profileId')) {
      throw new Error('Imported job has invalid mail settings');
    }
    if (document.mailing.profileId !== undefined) {
      if (typeof document.mailing.profileId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(document.mailing.profileId)) {
        throw new Error('Imported job has an invalid mail profile');
      }
      getProfile(document.mailing.profileId);
    }
  }

  return {
    name: document.name,
    command: document.command,
    schedule: document.schedule,
    stopped: document.stopped === true,
    logging: document.logging === true || document.logging === 'true',
    mailing: document.mailing?.profileId ? { profileId: document.mailing.profileId } : {},
    created: Date.now(),
    saved: false,
    timestamp: new Date().toString(),
  };
}

function replaceTemporaryFile(source, destination, callback) {
  fs.unlink(destination, (unlinkError) => {
    if (unlinkError && unlinkError.code !== 'ENOENT') return callback(unlinkError);
    return fs.rename(source, destination, callback);
  });
}

exports.normalise_database = (temporaryFile, callback) => {
  const candidate = new Datastore({ filename: temporaryFile });
  candidate.loadDatabase((loadError) => {
    if (loadError) return callback(loadError);
    return candidate.find({}).exec((findError, documents) => {
      if (findError) return callback(findError);
      let jobs;
      try {
        jobs = documents.map(validateImportedJob);
      } catch (validationError) {
        return callback(validationError);
      }

      const normalisedFile = `${temporaryFile}.normalised-${crypto.randomUUID()}`;
      const normalised = new Datastore({ filename: normalisedFile });
      return normalised.loadDatabase((normalisedLoadError) => {
        if (normalisedLoadError) return callback(normalisedLoadError);
        return normalised.insert(jobs, (insertError) => {
          if (insertError) return callback(insertError);
          return normalised.compactDatafile((compactError) => {
            if (compactError) return callback(compactError);
            return replaceTemporaryFile(normalisedFile, temporaryFile, callback);
          });
        });
      });
    });
  });
};

function replaceDatabase(temporaryFile, done) {
  const fail = (error) => fs.unlink(temporaryFile, () => done(error));
  const loadReplacement = (rollbackFile) => db.loadDatabase((loadError) => {
    if (!loadError) {
      if (rollbackFile) fs.unlink(rollbackFile, () => {});
      return done();
    }
    if (!rollbackFile) return fail(loadError);
    return fs.rename(rollbackFile, crontabDbFile, () => db.loadDatabase(() => fail(loadError)));
  });

  const replaceFile = () => {
    if (process.platform !== 'win32') {
      return fs.rename(temporaryFile, crontabDbFile, (error) => {
        if (error) return fail(error);
        return loadReplacement();
      });
    }

    const rollbackFile = path.join(dbFolder, `.rollback-${crypto.randomUUID()}.db`);
    return fs.rename(crontabDbFile, rollbackFile, (moveError) => {
      if (moveError && moveError.code !== 'ENOENT') return fail(moveError);
      return fs.rename(temporaryFile, crontabDbFile, (replaceError) => {
        if (!replaceError) return loadReplacement(moveError ? null : rollbackFile);
        if (moveError) return fail(replaceError);
        return fs.rename(rollbackFile, crontabDbFile, () => fail(replaceError));
      });
    });
  };

  validateDatabaseFile(temporaryFile, (validationError) => {
    if (validationError) return fail(validationError);
    return backupDatabase((backupError) => {
      if (backupError) return fail(backupError);
      return replaceFile();
    });
  });
}

exports.replace_database = (temporaryFile, callback) => withDatabaseLock(
  (done) => replaceDatabase(temporaryFile, done),
  callback
);

exports.restore = (dbName, callback = () => {}) => withDatabaseLock((done) => {
  if (!exports.get_backup_names().includes(dbName)) {
    const error = new Error('Backup not found');
    error.statusCode = 404;
    return done(error);
  }
  const source = path.join(dbFolder, dbName);
  const temporaryFile = path.join(dbFolder, `.restore-${crypto.randomUUID()}.db`);
  fs.copyFile(source, temporaryFile, (copyError) => {
    if (copyError) return done(copyError);
    return replaceDatabase(temporaryFile, (error) => {
      if (error) fs.unlink(temporaryFile, () => {});
      done(error);
    });
  });
}, callback);

exports.delete_backup = (dbName, callback = () => {}) => withDatabaseLock((done) => {
  if (!exports.get_backup_names().includes(dbName)) {
    const error = new Error('Backup not found');
    error.statusCode = 404;
    return done(error);
  }
  return fs.unlink(path.join(dbFolder, dbName), done);
}, callback);

exports.reload_db = () => {
  db.loadDatabase();
};

exports.get_env = () => {
  if (fs.existsSync(envFile)) {
    return fs.readFileSync(envFile, 'utf8').replace('\n', '\n');
  }
  return '';
};

exports.import_crontab = () => {
  exec('crontab -l', (error, stdout) => {
    const lines = stdout.split('\n');
    const namePrefix = Date.now();

    lines.forEach((line, index) => {
      line = line.replace(/\t+/g, ' ');
      const regex = /^((@[a-zA-Z]+\s+)|(([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+))/;
      const command = line.replace(regex, '').trim();
      const schedule = line.replace(command, '').trim();

      let isValid = false;
      try {
        isValid = CronExpressionParser.parse(schedule) !== null;
      } catch (_e) { /* ignore */ }

      if (command && schedule && isValid) {
        const name = `${namePrefix}_${index}`;
        db.findOne({ command, schedule }, (err, doc) => {
          if (err) throw err;
          if (!doc) {
            exports.create_new(name, command, schedule, null);
          } else {
            doc.command = command;
            doc.schedule = schedule;
            exports.update(doc._id, doc);
          }
        });
      }
    });
  });
};

exports.preview_crontab = (envVars, callback) => {
  try {
    envVars = serialiseEnvironment(parseEnvironment(envVars));
  } catch (_error) {
    return callback('# Invalid environment configuration');
  }
  exports.crontabs((tabs) => {
    let crontabString = '';
    if (envVars) {
      crontabString += `${envVars}\n`;
    }
    for (const tab of tabs) {
      if (!tab.stopped) {
        crontabString += `${tab.schedule} ${makeCommand(tab)}\n`;
      }
    }
    callback(crontabString);
  });
};

exports.autosave_crontab = (callback) => {
  try {
    exports.set_crontab(parseEnvironment(exports.get_env()), callback);
  } catch (error) {
    callback(error);
  }
};
