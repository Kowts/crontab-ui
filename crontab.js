'use strict';

const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { CronExpressionParser } = require('cron-parser');
const cronstrue = require('cronstrue/i18n');
const { getProfile } = require('./config/mail-profiles');
const { execute } = require('./execution');
const { parseEnvironment, serialiseEnvironment } = require('./config/environment');
const { buildTaskEnvironment } = require('./config/task-environment');
const { SqliteDatastore, createDatabaseFile, isSqliteFile, readJobsFromFile } = require('./lib/database');

const humanCronLocale = process.env.HUMANCRON ?? 'en';

const dbFolder = process.env.CRON_DB_PATH || path.join(__dirname, 'crontabs');
console.log(`Cron db path: ${dbFolder}`);

const logFolder = path.join(dbFolder, 'logs');
const auditFile = path.join(logFolder, 'operations.jsonl');
const envFile = path.join(dbFolder, 'env.db');
const crontabDbFile = path.join(dbFolder, 'crontab.db');

const db = new SqliteDatastore({ filename: crontabDbFile });
const commandTimeoutMs = Number(process.env.COMMAND_TIMEOUT_MS || 300000);
const commandMaxBuffer = Number(process.env.COMMAND_MAX_BUFFER || 1024 * 1024);
const commandKillGraceMs = Number(process.env.COMMAND_KILL_GRACE_MS || 5000);
const maxLogBytes = Number(process.env.LOG_MAX_BYTES || 10 * 1024 * 1024);
const logRotationCount = Number(process.env.LOG_ROTATION_COUNT || 5);
const logRetentionDays = Number(process.env.LOG_RETENTION_DAYS || 30);
const backupRetentionCount = Number(process.env.BACKUP_RETENTION_COUNT || 30);
const backupRetentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 90);
const systemCrontabImportTimeoutMs = Number(process.env.SYSTEM_CRONTAB_IMPORT_TIMEOUT_MS || 30000);
const systemCrontabImportMaxBuffer = Number(process.env.SYSTEM_CRONTAB_IMPORT_MAX_BUFFER || 256 * 1024);

const cronPath = process.env.CRON_PATH || path.join(dbFolder, 'crontab-staging');
let databaseOperationActive = false;
const manualRuns = new Map();
let activeManualRunId = null;
if (process.env.CRON_PATH !== undefined) {
  console.log(`Path to crond files set using env variables ${process.env.CRON_PATH}`);
}

db.loadDatabase((err) => {
  if (err) throw err;
});

fs.mkdirSync(logFolder, { recursive: true, mode: 0o700 });
fs.mkdirSync(cronPath, { recursive: true, mode: 0o700 });

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

function applySystemCrontab(filePath, callback) {
  return execFile('crontab', [filePath], {
    timeout: commandTimeoutMs,
    maxBuffer: commandMaxBuffer,
    windowsHide: true,
  }, callback);
}

exports.db_folder = dbFolder;
exports.log_folder = logFolder;
exports.output_folder = logFolder;
exports.audit_file = auditFile;
exports.env_file = envFile;
exports.crontab_db_file = crontabDbFile;

exports.create_new = (name, command, schedule, logging, mailing, ownership = {}, callback = () => {}) => {
  const tab = buildCrontab(name, command, schedule, false, logging, mailing, ownership);
  tab._id = crypto.randomUUID();
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

function recordOutput(tab, result, operationId) {
  try {
    fs.mkdirSync(logFolder, { recursive: true, mode: 0o700 });
    const stdout = path.join(logFolder, `${tab._id}.stdout`);
    const stderr = path.join(logFolder, `${tab._id}.stderr`);
    fs.writeFileSync(stdout, result.stdout, { mode: 0o600 });
    fs.writeFileSync(stderr, result.stderr, { mode: 0o600 });
    if (tab.logging === true || tab.logging === 'true') {
      writeOutput(path.join(logFolder, `${tab._id}.stdout.log`), result.stdout);
      writeOutput(path.join(logFolder, `${tab._id}.log`), result.stderr);
    }
    return { stdout, stderr };
  } catch (error) {
    audit({ operationId, type: 'execution_output', jobId: tab._id, status: 'failed', error: error.message });
    console.error(`Unable to persist execution output for ${tab._id}: ${error.message}`);
    return null;
  }
}

function sendMail(tab, operationId) {
  if (!tab.mailing?.profileId) return;
  const child = spawn(process.execPath, [path.join(__dirname, 'bin', 'crontab-ui-mailer.js'), tab._id, operationId], {
    detached: false,
    stdio: 'ignore',
  });
  child.once('error', (error) => audit({ operationId, type: 'mail', jobId: tab._id, status: 'failed', error: error.message }));
  child.once('exit', (code, signal) => {
    if (code !== 0) audit({ operationId, type: 'mail', jobId: tab._id, status: 'failed', exitCode: code, signal });
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
    let configuredEnvironment;
    try {
      configuredEnvironment = parseEnvironment(exports.get_env());
    } catch (environmentError) {
      return callback(environmentError);
    }
    let jobEnvironment;
    try {
      jobEnvironment = buildTaskEnvironment(configuredEnvironment);
    } catch (environmentError) {
      return callback(environmentError);
    }
    const cmd = res.command;

    const operationId = crypto.randomUUID();
    audit({ operationId, type: 'runjob', jobId: _id, status: 'started', ...auditContext });

    execute(cmd, { timeoutMs: commandTimeoutMs, maxOutputBytes: commandMaxBuffer, killGraceMs: commandKillGraceMs, env: jobEnvironment }, (error, result) => {
      const output = recordOutput(res, result, operationId);
      if (output) sendMail(res, operationId);
      else if (res.mailing?.profileId) audit({ operationId, type: 'mail', jobId: res._id, status: 'skipped', reason: 'output_unavailable' });
      applyRetention();
      audit({ operationId, type: 'runjob', jobId: _id, status: error ? 'failed' : 'completed', exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, terminationReason: result.terminationReason, outputExceeded: result.outputExceeded, error: error?.message, ...auditContext });
      callback(error, { operationId, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, terminationReason: result.terminationReason });
    });
  });
};

function pruneManualRuns() {
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  for (const [operationId, run] of manualRuns) {
    if (run.completedAt && run.completedAt < cutoff) manualRuns.delete(operationId);
  }
  const completed = [...manualRuns.entries()].filter(([, run]) => run.completedAt).sort((a, b) => b[1].completedAt - a[1].completedAt);
  completed.slice(10).forEach(([operationId]) => manualRuns.delete(operationId));
}

exports.getManualRun = (operationId) => {
  pruneManualRuns();
  const run = manualRuns.get(operationId);
  if (!run) return null;
  const safeRun = { ...run };
  delete safeRun.controller;
  return safeRun;
};

exports.startManualRun = (_id, auditContext = {}, callback = () => {}) => {
  if (activeManualRunId) return callback(Object.assign(new Error('A manual execution is already active'), { statusCode: 409 }));
  return db.find({ _id }).exec((err, docs) => {
    if (err || !docs.length) return callback(err || new Error('Job not found'));
    let configuredEnvironment;
    try {
      configuredEnvironment = parseEnvironment(exports.get_env());
    } catch (environmentError) {
      return callback(environmentError);
    }
    let jobEnvironment;
    try {
      jobEnvironment = buildTaskEnvironment(configuredEnvironment);
    } catch (environmentError) {
      return callback(environmentError);
    }
    const job = docs[0];
    const operationId = crypto.randomUUID();
    const run = { operationId, jobId: _id, status: 'running', startedAt: Date.now(), controller: null };
    manualRuns.set(operationId, run);
    activeManualRunId = operationId;
    audit({ operationId, type: 'manual_run', jobId: _id, status: 'started', ...auditContext });
    callback(null, exports.getManualRun(operationId));
    run.controller = execute(job.command, {
      timeoutMs: commandTimeoutMs, maxOutputBytes: commandMaxBuffer, killGraceMs: commandKillGraceMs,
      env: jobEnvironment, onStart: (controller) => { run.controller = controller; },
    }, (error, result) => {
      const output = recordOutput(job, result, operationId);
      if (output) sendMail(job, operationId);
      else if (job.mailing?.profileId) audit({ operationId, type: 'mail', jobId: job._id, status: 'skipped', reason: 'output_unavailable' });
      applyRetention();
      run.status = error ? (result.terminationReason === 'cancelled' ? 'cancelled' : 'failed') : 'completed';
      run.completedAt = Date.now();
      run.result = { exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, terminationReason: result.terminationReason, outputExceeded: result.outputExceeded };
      activeManualRunId = null;
      audit({ operationId, type: 'manual_run', jobId: _id, status: run.status, error: error?.message, ...run.result, ...auditContext });
      pruneManualRuns();
    });
  });
};

exports.cancelManualRun = (operationId, auditContext = {}) => {
  const run = manualRuns.get(operationId);
  if (!run || run.status !== 'running' || !run.controller) return null;
  run.controller.cancel();
  audit({ operationId, type: 'manual_run', jobId: run.jobId, status: 'cancellation_requested', ...auditContext });
  return exports.getManualRun(operationId);
};

function restoreFile(filePath, contents, existed, callback) {
  if (!existed) return fs.rm(filePath, { force: true }, callback);
  return writeAtomicFile(filePath, contents, callback);
}

function markPublished(ids, callback) {
  if (!ids.length) return callback(null);
  return db.update({ _id: { $in: ids } }, { $set: { saved: true, needsPublishReview: false } }, { multi: true }, callback);
}

function setCrontab(environment, callback, applyCrontab) {
  let envVars;
  try {
    envVars = serialiseEnvironment(environment);
  } catch (error) {
    return callback(error);
  }
  const previousEnvironmentExists = fs.existsSync(envFile);
  const previousEnvironment = previousEnvironmentExists ? fs.readFileSync(envFile, 'utf8') : '';

  return exports.crontabs((tabs) => {
    let crontabString = '';
    if (envVars) {
      crontabString += `${envVars}\n`;
    }
    for (const tab of tabs) {
      if (!tab.stopped) {
        crontabString += `${tab.schedule} ${makeCommand(tab)}\n`;
      }
    }

    const fileName = process.env.CRON_IN_DOCKER !== undefined ? 'root' : 'crontab';
    const crontabFile = path.join(cronPath, fileName);
    const previousCrontabExists = fs.existsSync(crontabFile);
    const previousCrontab = previousCrontabExists ? fs.readFileSync(crontabFile, 'utf8') : '';
    const rollback = (error) => restoreFile(crontabFile, previousCrontab, previousCrontabExists, (cronRollbackError) => {
      return restoreFile(envFile, previousEnvironment, previousEnvironmentExists, (environmentRollbackError) => {
        if (cronRollbackError || environmentRollbackError) {
          error.rollbackError = [cronRollbackError, environmentRollbackError]
            .filter(Boolean).map((rollbackError) => rollbackError.message).join('; ');
        }
        callback(error);
      });
    });

    return writeAtomicFile(envFile, envVars, (environmentError) => {
      if (environmentError) return callback(environmentError);
      return writeAtomicFile(crontabFile, crontabString, (writeError) => {
        if (writeError) return rollback(writeError);
        return applyCrontab(crontabFile, (applyError) => {
          if (applyError) return rollback(applyError);
          return markPublished(tabs.map((tab) => tab._id), callback);
        });
      });
    });
  });
}

exports.set_crontab = (environment, callback = () => {}, applyCrontab = applySystemCrontab) => withDatabaseLock(
  (done) => setCrontab(environment, done, applyCrontab),
  callback
);

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
  setImmediate(() => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dbFolder, `backup-${timestamp}.db`);
    const temporary = path.join(dbFolder, `.backup-${crypto.randomUUID()}.tmp`);
    try {
      fs.mkdirSync(dbFolder, { recursive: true, mode: 0o700 });
      db.snapshotTo(temporary);
      fs.renameSync(temporary, dest);
      applyRetention();
      callback(null, path.basename(dest));
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      callback(error);
    }
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
  setImmediate(() => {
    try {
      if (!isSqliteFile(fileName)) throw new Error('Imported database is not a SQLite database');
      readJobsFromFile(fileName);
      callback(null);
    } catch (error) {
      callback(error);
    }
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validateImportedJob(document, { preserveMetadata = false } = {}) {
  if (!isPlainObject(document)) throw new Error('Imported record must be an object');
  for (const key of Object.keys(document)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new Error('Imported record contains a dangerous property');
    }
  }

  const accepted = new Set(['_id', 'name', 'command', 'schedule', 'stopped', 'logging', 'mailing', 'timestamp', 'created', 'saved', 'hook', 'owner', 'createdBy', 'needsPublishReview']);
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

  const normalised = {
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

  if (!preserveMetadata) return normalised;
  if (typeof document._id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(document._id)) {
    throw new Error('Restored job has an invalid id');
  }
  for (const field of ['owner', 'createdBy']) {
    if (document[field] !== undefined && (typeof document[field] !== 'string' || document[field].length > 128 || /[\r\n]/.test(document[field]))) {
      throw new Error(`Restored job has an invalid ${field}`);
    }
  }
  if (document.saved !== undefined && typeof document.saved !== 'boolean') throw new Error('Restored job has an invalid saved state');
  if (document.created !== undefined && (!Number.isSafeInteger(document.created) || document.created < 0)) {
    throw new Error('Restored job has an invalid created timestamp');
  }
  if (document.timestamp !== undefined && (typeof document.timestamp !== 'string' || document.timestamp.length > 256 || /[\r\n]/.test(document.timestamp))) {
    throw new Error('Restored job has an invalid timestamp');
  }

  return {
    ...normalised,
    _id: document._id,
    saved: document.saved === true,
    // The backup describes a prior publication, not the scheduler currently
    // installed on this host. Force an explicit review before trusting it.
    needsPublishReview: true,
    ...(document.owner ? { owner: document.owner } : {}),
    ...(document.createdBy ? { createdBy: document.createdBy } : {}),
    ...(Number.isSafeInteger(document.created) ? { created: document.created } : {}),
    ...(document.timestamp ? { timestamp: document.timestamp } : {}),
  };
}

exports.normalise_database = (temporaryFile, callback, options = {}) => {
  setImmediate(() => {
    const normalisedFile = `${temporaryFile}.normalised-${crypto.randomUUID()}`;
    try {
      const jobs = readJobsFromFile(temporaryFile).map((document) => {
        const job = validateImportedJob(document, options);
        return options.preserveMetadata ? job : { ...job, _id: crypto.randomUUID() };
      });
      createDatabaseFile(normalisedFile, jobs);
      fs.rmSync(temporaryFile, { force: true });
      fs.renameSync(normalisedFile, temporaryFile);
      callback(null);
    } catch (error) {
      fs.rmSync(normalisedFile, { force: true });
      callback(error);
    }
  });
};

function importFingerprint(job) {
  return JSON.stringify([
    String(job.name || '').trim(),
    String(job.command || '').trim(),
    String(job.schedule || '').trim(),
  ]);
}

function importName(job) {
  return String(job.name || '').trim().toLocaleLowerCase('en-US');
}

function buildImportPlan(importedJobs, existingJobs, mode) {
  if (!['merge', 'replace'].includes(mode)) throw new Error('Invalid import mode');

  if (mode === 'replace') {
    return {
      jobs: importedJobs,
      summary: {
        mode,
        existing: existingJobs.length,
        incoming: importedJobs.length,
        added: importedJobs.length,
        skipped: 0,
        conflicts: 0,
        replaced: existingJobs.length,
      },
    };
  }

  const existingFingerprints = new Set(existingJobs.map(importFingerprint));
  const existingNames = new Set(existingJobs.map(importName).filter(Boolean));
  const incomingFingerprints = new Set();
  const additions = [];
  let skipped = 0;
  let conflicts = 0;

  for (const job of importedJobs) {
    const fingerprint = importFingerprint(job);
    if (existingFingerprints.has(fingerprint) || incomingFingerprints.has(fingerprint)) {
      skipped += 1;
      continue;
    }
    const name = importName(job);
    if (name && existingNames.has(name)) conflicts += 1;
    incomingFingerprints.add(fingerprint);
    additions.push(job);
  }

  return {
    jobs: existingJobs.concat(additions),
    summary: {
      mode,
      existing: existingJobs.length,
      incoming: importedJobs.length,
      added: additions.length,
      skipped,
      conflicts,
      replaced: 0,
    },
  };
}

function readImportPlan(temporaryFile, mode) {
  return buildImportPlan(readJobsFromFile(temporaryFile), db.getAllData(), mode);
}

exports.inspect_import = (temporaryFile, mode, callback = () => {}) => {
  setImmediate(() => {
    try {
      callback(null, readImportPlan(temporaryFile, mode).summary);
    } catch (error) {
      callback(error);
    }
  });
};

exports.apply_import = (temporaryFile, mode, callback = () => {}) => withDatabaseLock((done) => {
  let plan;
  try {
    plan = readImportPlan(temporaryFile, mode);
    if (mode === 'merge') createDatabaseFile(temporaryFile, plan.jobs);
  } catch (error) {
    return done(error);
  }
  return replaceDatabase(temporaryFile, (error) => done(error, plan.summary));
}, callback);

exports._build_import_plan = buildImportPlan;

function replaceDatabase(temporaryFile, done) {
  validateDatabaseFile(temporaryFile, (validationError) => {
    if (validationError) {
      fs.rm(temporaryFile, { force: true }, () => done(validationError));
      return;
    }
    return backupDatabase((backupError) => {
      if (backupError) {
        fs.rm(temporaryFile, { force: true }, () => done(backupError));
        return;
      }
      setImmediate(() => {
        // Windows does not allow replacing a SQLite file while another connection
        // has it open. Replace rows inside the active database transactionally
        // instead of renaming the active file.
        if (process.platform === 'win32') {
          try {
            db.replaceDocuments(readJobsFromFile(temporaryFile));
            return fs.rm(temporaryFile, { force: true }, (cleanupError) => done(cleanupError || null));
          } catch (error) {
            return fs.rm(temporaryFile, { force: true }, () => done(error));
          }
        }
        const rollbackFile = path.join(dbFolder, `.rollback-${crypto.randomUUID()}.db`);
        const reopen = (error) => {
          try {
            if (!db.database) db.open();
          } catch (openError) {
            error.rollbackError = openError.message;
          }
          fs.rm(temporaryFile, { force: true }, () => done(error));
        };
        const restoreRollback = (error) => {
          if (!fs.existsSync(rollbackFile) || fs.existsSync(crontabDbFile)) return reopen(error);
          return fs.rename(rollbackFile, crontabDbFile, (rollbackError) => {
            if (rollbackError) error.rollbackError = rollbackError.message;
            reopen(error);
          });
        };
        try {
          db.close();
        } catch (closeError) {
          return reopen(closeError);
        }
        return fs.rename(crontabDbFile, rollbackFile, (snapshotError) => {
          if (snapshotError) return reopen(snapshotError);
          return fs.rename(temporaryFile, crontabDbFile, (replaceError) => {
            if (replaceError) return restoreRollback(replaceError);
            try {
              db.open();
            } catch (openError) {
              return restoreRollback(openError);
            }
            return fs.rm(rollbackFile, { force: true }, () => done(null));
          });
        });
      });
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
    return exports.normalise_database(temporaryFile, (normaliseError) => {
      if (normaliseError) return done(normaliseError);
      return replaceDatabase(temporaryFile, (error) => {
        if (error) fs.unlink(temporaryFile, () => {});
        done(error);
      });
    }, { preserveMetadata: true });
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
  db.reload();
};

exports.close_db = () => {
  db.close();
};

exports.get_env = () => {
  if (fs.existsSync(envFile)) {
    return fs.readFileSync(envFile, 'utf8').replace('\n', '\n');
  }
  return '';
};

function parseSystemCrontab(content) {
  if (typeof content !== 'string') throw new Error('System crontab returned invalid output');

  return content.split(/\r?\n/).map((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return null;

    const macro = line.match(/^(@[A-Za-z]+)\s+(.+)$/);
    const fields = macro || line.match(/^((?:\S+\s+){4}\S+)\s+(.+)$/);
    if (!fields) return null;

    const schedule = fields[1];
    const command = fields[2].trim();
    if (!command || /[\r\n]/.test(command)) return null;

    try {
      if (schedule !== '@reboot') CronExpressionParser.parse(schedule);
    } catch (_error) {
      return null;
    }
    return { command, schedule, index };
  }).filter(Boolean);
}

function readSystemCrontab(callback) {
  return execFile('crontab', ['-l'], {
    timeout: systemCrontabImportTimeoutMs,
    maxBuffer: systemCrontabImportMaxBuffer,
    windowsHide: true,
  }, callback);
}

function writeImportedJobs(entries, callback) {
  return db.find({}).exec((findError, existingJobs) => {
    if (findError) return callback(findError);
    const existing = new Set(existingJobs.map((job) => `${job.schedule}\u0000${job.command}`));
    const uniqueEntries = entries.filter((entry) => {
      const key = `${entry.schedule}\u0000${entry.command}`;
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    });

    if (!uniqueEntries.length) {
      return backupDatabase((backupError, backupName) => callback(backupError, {
        imported: 0,
        unchanged: entries.length,
        backup: backupName,
      }));
    }

    const createdAt = Date.now();
    const importedJobs = uniqueEntries.map((entry) => ({
      ...buildCrontab(`system-${createdAt}-${entry.index}`, entry.command, entry.schedule, false, false, {}),
      _id: crypto.randomUUID(),
      created: createdAt,
      saved: false,
    }));
    const temporaryFile = path.join(dbFolder, `.system-import-${crypto.randomUUID()}.db`);
    try {
      createDatabaseFile(temporaryFile, existingJobs.concat(importedJobs));
    } catch (error) {
      return callback(error);
    }
    return replaceDatabase(temporaryFile, (replaceError) => callback(replaceError, {
        imported: importedJobs.length,
        unchanged: entries.length - importedJobs.length,
      }));
  });
}

// The read function is injectable only to make the command boundary testable. Production always uses crontab -l.
exports.import_crontab = (callback = () => {}, readCrontab = readSystemCrontab) => withDatabaseLock((done) => {
  try {
    return readCrontab((readError, stdout) => {
      if (readError) return done(readError);
      let entries;
      try {
        entries = parseSystemCrontab(stdout);
      } catch (parseError) {
        return done(parseError);
      }
      return writeImportedJobs(entries, done);
    });
  } catch (error) {
    return done(error);
  }
}, callback);

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
