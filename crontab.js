'use strict';

const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { CronExpressionParser } = require('cron-parser');
const cronstrue = require('cronstrue/i18n');
const { getProfile } = require('./config/mail-profiles');
const { normaliseMailing, failureAlertDue } = require('./config/alert-policy');
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
const executionHistoryPerJob = Number(process.env.EXECUTION_HISTORY_PER_JOB || 200);
const executionHistoryLimit = 50;
const auditWriteAttempts = 3;
const auditRetryDelayMs = 25;

const cronPath = process.env.CRON_PATH || path.join(dbFolder, 'crontab-staging');
let databaseOperationActive = false;
const manualRunControllers = new Map();
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

function isDockerScheduler() {
  return process.env.CRON_IN_DOCKER !== undefined;
}

function schedulerReloadStateFile(filePath) {
  return `${filePath}.reload.json`;
}

function fileDigest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function waitForSchedulerReload(filePath, expectedDigest, callback) {
  const timeoutMs = Number(process.env.SCHEDULER_RELOAD_TIMEOUT_MS || 10000);
  const startedAt = Date.now();
  const stateFile = schedulerReloadStateFile(filePath);
  const poll = () => {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.digest === expectedDigest) return callback(null);
    } catch (_error) {
      // The scheduler writes this state atomically; absence means it has not reloaded yet.
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return callback(new Error(`Scheduler did not confirm reloading ${path.basename(filePath)} within ${timeoutMs}ms`));
    }
    return setTimeout(poll, 50);
  };
  poll();
}

function applyDockerCrontab(filePath, callback) {
  return execFile('supercronic', ['-test', filePath], {
    timeout: commandTimeoutMs,
    maxBuffer: commandMaxBuffer,
    windowsHide: true,
  }, (validationError) => {
    if (validationError) return callback(validationError);
    let digest;
    try {
      digest = fileDigest(filePath);
    } catch (error) {
      return callback(error);
    }
    return waitForSchedulerReload(filePath, digest, callback);
  });
}

function applyManagedCrontab(filePath, callback) {
  return isDockerScheduler() ? applyDockerCrontab(filePath, callback) : applySystemCrontab(filePath, callback);
}

exports.db_folder = dbFolder;
exports.log_folder = logFolder;
exports.output_folder = logFolder;
exports.audit_file = auditFile;
exports.env_file = envFile;
exports.crontab_db_file = crontabDbFile;
exports.apply_docker_crontab = applyDockerCrontab;
exports.scheduler_reload_state_file = schedulerReloadStateFile;

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
  // The alert state belongs to a task that no longer exists; keeping it would leave a row that
  // nothing can clear, since only a successful run clears it.
  db.clearAlert(_id);
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

// The datastore reports a read failure by calling back with the error alone, so `docs` is
// undefined and indexing it would raise an unhandled TypeError inside a microtask, far from the
// cause. Callers already treat a missing task as undefined, so a failed read is surfaced in the
// log and answered the same way instead of crashing the request.
exports.get_crontab = (_id, callback) => {
  db.find({ _id }).exec((err, docs) => {
    if (err) {
      console.error(`Unable to read task ${_id}: ${err.message}`);
      return callback(undefined);
    }
    return callback(docs[0]);
  });
};

function audit(event) {
  try {
    rotateLog(auditFile);
    const entry = `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`;
    let writeError;
    for (let attempt = 0; attempt < auditWriteAttempts; attempt += 1) {
      try {
        fs.appendFileSync(auditFile, entry, { encoding: 'utf8', mode: 0o600 });
        return;
      } catch (error) {
        writeError = error;
        if (error.code !== 'EBUSY' || attempt === auditWriteAttempts - 1) throw error;
        // Audit writes deliberately remain synchronous: callers record a lifecycle event before
        // reporting success, and an asynchronous retry could reorder it or lose it on shutdown.
        // Windows may briefly retain a rotated log handle as EBUSY. This bounded retry pauses the
        // event loop only on that rare path, at most two times (50 ms total), before surfacing it.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, auditRetryDelayMs);
      }
    }
    throw writeError;
  } catch (error) {
    // Audit failures must not make a scheduled job unavailable, but must remain visible.
    console.error('Unable to write audit record:', error.message);
  }
}

exports.audit = audit;

exports.recoverManualRuns = () => {
  const recovered = db.recoverManualRuns(Date.now());
  if (recovered) audit({ type: 'manual_run', status: 'interrupted', reason: 'service_restart', count: recovered });
  return recovered;
};

exports.recoverManualRuns();

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

// The execution history is diagnostic, never operational: a failure to store it must not turn a
// completed run into a failed one, so the error is surfaced in the audit log instead of thrown.
function recordExecution({ job, operationId, trigger, actor, startedAt, status, result }) {
  try {
    db.createExecution({
      operationId,
      jobId: job._id,
      trigger,
      actor,
      status,
      startedAt,
      completedAt: Date.now(),
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      terminationReason: result.terminationReason,
      outputExceeded: result.outputExceeded,
    });
  } catch (error) {
    audit({ operationId, type: 'execution_history', jobId: job._id, status: 'failed', error: error.message });
    console.error(`Unable to record execution history for ${job._id}: ${error.message}`);
  }
}

function shouldSendMail(mailing, failed) {
  if (!mailing?.profileId) return false;
  const policy = mailing.policy || 'onFailure';
  return policy === 'always' || (failed ? policy === 'onFailure' : policy === 'onSuccess');
}

let mailerSpawn = defaultMailerSpawn;

// Decides whether a failing run should be announced, and keeps the state that makes the next
// decision possible. The alert is recorded when the decision to send is taken, not when delivery
// is confirmed: the mailer runs detached and cannot report back, and a broken SMTP server is
// exactly the case where repeated attempts should be throttled rather than retried in a loop.
function deliverMail(tab, operationId, result, failed) {
  // A successful run ends the incident, whatever the notification policy is. This has to happen
  // before the policy check: a task configured to notify only on failure returns early there, and
  // would otherwise keep a stale cooldown that suppresses the next real alert.
  if (!failed) db.clearAlert(tab._id);
  if (!shouldSendMail(tab.mailing, failed)) {
    if (tab.mailing?.profileId) {
      audit({ operationId, type: 'mail', jobId: tab._id, status: 'skipped', reason: failed ? 'policy_on_success' : 'policy_on_failure' });
    }
    return false;
  }
  if (failed) {
    const now = Date.now();
    const consecutiveFailures = db.countConsecutiveFailures(tab._id);
    const alertState = db.getAlertState(tab._id);
    const decision = failureAlertDue(tab.mailing, {
      consecutiveFailures,
      lastAlertAt: alertState ? alertState.lastAlertAt : null,
      now,
    });
    if (!decision.send) {
      audit({
        operationId, type: 'mail', jobId: tab._id, status: 'skipped', reason: decision.reason, consecutiveFailures,
      });
      return false;
    }
    db.recordAlert(tab._id, now, consecutiveFailures);
  }
  const outcome = failed ? 'failed' : 'succeeded';
  const durationMs = Number.isSafeInteger(result.durationMs) && result.durationMs >= 0 ? String(result.durationMs) : '';
  const exitCode = Number.isSafeInteger(result.exitCode) ? String(result.exitCode) : '';
  const child = mailerSpawn([tab._id, operationId, outcome, durationMs, exitCode]);
  watchMailerProcess(child, { operationId, jobId: tab._id });
  if (child.unref) child.unref();
  return true;
}

function defaultMailerSpawn(args) {
  return spawn(process.execPath, [path.join(__dirname, 'bin', 'crontab-ui-mailer.js'), ...args], {
    detached: false,
    stdio: 'ignore',
  });
}

// The delivery decision is worth testing without a live SMTP server, and the same seam keeps the
// spawn itself replaceable. Returns the previous spawn, so a caller can restore it.
function setMailerSpawn(override) {
  const previous = mailerSpawn;
  mailerSpawn = override || defaultMailerSpawn;
  return previous;
}

// The mailer owns the audit record for its own delivery outcome, including unexpected exits.
// The parent only reports the one failure it can observe on its own: the process not starting.
// An exit code is deliberately ignored, because a non-zero exit is what the mailer itself uses
// to report a delivery failure it has already audited.
function watchMailerProcess(child, { operationId, jobId }) {
  child.once('error', (error) => audit({
    operationId, type: 'mail', jobId, status: 'failed', reason: 'spawn_failed', error: error.message,
  }));
}

exports.should_send_mail = shouldSendMail;
exports.watch_mailer_process = watchMailerProcess;
exports.set_mailer_spawn = setMailerSpawn;

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

  try {
    db.pruneExecutions(cutoff, executionHistoryPerJob);
  } catch (error) {
    audit({ type: 'retention', status: 'failed', scope: 'executions', error: error.message });
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

    const startedAt = Date.now();
    execute(cmd, { timeoutMs: commandTimeoutMs, maxOutputBytes: commandMaxBuffer, killGraceMs: commandKillGraceMs, env: jobEnvironment }, (error, result) => {
      const failed = Boolean(error);
      const output = recordOutput(res, result, operationId);
      // The execution is recorded before the notification decision, because the number of
      // consecutive failures is what that decision depends on.
      recordExecution({
        job: res, operationId, trigger: 'scheduled', startedAt,
        status: failed ? 'failed' : 'completed', result,
      });
      if (output) deliverMail(res, operationId, result, failed);
      else if (shouldSendMail(res.mailing, failed)) audit({ operationId, type: 'mail', jobId: res._id, status: 'skipped', reason: 'output_unavailable' });
      applyRetention();
      audit({ operationId, type: 'runjob', jobId: _id, status: error ? 'failed' : 'completed', exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, terminationReason: result.terminationReason, outputExceeded: result.outputExceeded, error: error?.message, ...auditContext });
      callback(error, { operationId, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, terminationReason: result.terminationReason });
    });
  });
};

function pruneManualRuns() {
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  db.pruneManualRuns(cutoff, 10);
}

exports.getManualRun = (operationId) => {
  pruneManualRuns();
  return db.getManualRun(operationId);
};

function nextScheduledRun(job) {
  if (job.stopped) return null;
  if (job.schedule === '@reboot') return null;
  try {
    return CronExpressionParser.parse(job.schedule).next().toISOString();
  } catch (_error) {
    return null;
  }
}

// The panel reads in one call what would otherwise need a run record, the job document, and a
// cron calculation per task. Output paths are never included: the history is a health summary.
exports.getExecutionPanel = (job) => ({
  jobId: job._id,
  name: job.name || job._id,
  schedule: job.schedule,
  stopped: Boolean(job.stopped),
  nextRun: nextScheduledRun(job),
  ...db.summariseExecutions(job._id),
  // Surfacing the alert state is what makes a deliberate silence legible: an operator can see the
  // cooldown is holding rather than assume the alert path is broken.
  alert: db.getAlertState(job._id),
  history: db.listExecutions(job._id, executionHistoryLimit),
});

exports.startManualRun = (_id, auditContext = {}, callback = () => {}) => {
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
    const actor = auditContext.actor || 'local';
    try {
      db.createManualRun({ operationId, jobId: _id, actor, status: 'running', startedAt: Date.now() });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return callback(Object.assign(new Error('A manual execution is already active for this user'), { statusCode: 409 }));
      }
      return callback(error);
    }
    audit({ operationId, type: 'manual_run', jobId: _id, status: 'started', ...auditContext });
    callback(null, exports.getManualRun(operationId));
    const startedAt = Date.now();
    const controller = execute(job.command, {
      timeoutMs: commandTimeoutMs, maxOutputBytes: commandMaxBuffer, killGraceMs: commandKillGraceMs,
      env: jobEnvironment,
    }, (error, result) => {
      const failed = Boolean(error);
      const output = recordOutput(job, result, operationId);
      const status = error ? (result.terminationReason === 'cancelled' ? 'cancelled' : 'failed') : 'completed';
      recordExecution({ job, operationId, trigger: 'manual', actor, startedAt, status, result });
      if (output) deliverMail(job, operationId, result, failed);
      else if (shouldSendMail(job.mailing, failed)) audit({ operationId, type: 'mail', jobId: job._id, status: 'skipped', reason: 'output_unavailable' });
      applyRetention();
      const resultSummary = { exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, terminationReason: result.terminationReason, outputExceeded: result.outputExceeded };
      db.completeManualRun(operationId, status, Date.now(), resultSummary);
      manualRunControllers.delete(operationId);
      audit({ operationId, type: 'manual_run', jobId: _id, status, error: error?.message, ...resultSummary, ...auditContext });
      pruneManualRuns();
    });
    manualRunControllers.set(operationId, controller);
  });
};

exports.cancelManualRun = (operationId, auditContext = {}) => {
  const run = exports.getManualRun(operationId);
  const controller = manualRunControllers.get(operationId);
  if (!run || run.status !== 'running' || !controller) return null;
  controller.cancel();
  audit({ operationId, type: 'manual_run', jobId: run.jobId, status: 'cancellation_requested', ...auditContext });
  return exports.getManualRun(operationId);
};

exports.shutdownManualRuns = (callback = () => {}) => {
  if (!manualRunControllers.size) return callback();
  for (const [operationId, controller] of manualRunControllers) {
    controller.cancel();
    const run = exports.getManualRun(operationId);
    if (run) audit({ operationId, type: 'manual_run', jobId: run.jobId, status: 'cancellation_requested', reason: 'service_shutdown' });
  }
  const waitForCompletion = () => {
    if (!manualRunControllers.size) return callback();
    return setTimeout(waitForCompletion, 25);
  };
  return waitForCompletion();
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

    const dockerCronUser = process.env.CRON_USER || 'node';
    if (process.env.CRON_IN_DOCKER !== undefined && !/^[a-z_][a-z0-9_-]{0,31}$/i.test(dockerCronUser)) {
      return callback(new Error('CRON_USER is invalid'));
    }
    const fileName = process.env.CRON_IN_DOCKER !== undefined ? dockerCronUser : 'crontab';
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

exports.set_crontab = (environment, callback = () => {}, applyCrontab = applyManagedCrontab) => withDatabaseLock(
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
  const temporaryFile = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
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

function removeTemporaryFile(fileName, callback = () => {}) {
  fs.rm(fileName, { force: true, maxRetries: 5, retryDelay: 100 }, callback);
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
  let normalisedMailing = {};
  if (document.mailing !== undefined) {
    try {
      normalisedMailing = normaliseMailing(document.mailing);
    } catch (error) {
      throw new Error(`Imported job has invalid mail settings: ${error.message}`);
    }
    if (normalisedMailing.profileId) getProfile(normalisedMailing.profileId);
  }

  const normalised = {
    name: document.name,
    command: document.command,
    schedule: document.schedule,
    stopped: document.stopped === true,
    logging: document.logging === true || document.logging === 'true',
    mailing: normalisedMailing,
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
            return removeTemporaryFile(temporaryFile, (cleanupError) => {
              if (cleanupError) console.warn(`Unable to remove imported temporary database: ${cleanupError.message}`);
              done(null);
            });
          } catch (error) {
            return removeTemporaryFile(temporaryFile, () => done(error));
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
    return fs.readFileSync(envFile, 'utf8');
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
