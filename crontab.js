'use strict';

const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { CronExpressionParser } = require('cron-parser');
const cronstrue = require('cronstrue/i18n');
const { getProfile } = require('./config/mail-profiles');
const { useBoundedNumber, useCommandTimeoutMs, useResourceLimit } = require('./config/limits');
const { normaliseMailing, failureAlertDue } = require('./config/alert-policy');
const { EXECUTION_STATES, resolveTerminalState } = require('./config/execution-states');
const { execute, executeStructured } = require('./execution');
const { prepareStructuredExecution } = require('./lib/structured-execution');
const { LocalAgentClient } = require('./lib/agent-client');
const { redact, searchAudit } = require('./lib/audit-log');
const { parseEnvironment, serialiseEnvironment } = require('./config/environment');
const { buildTaskEnvironment } = require('./config/task-environment');
const {
  SqliteDatastore,
  createDatabaseFile,
  isSqliteFile,
  readExecutionCatalogFromFile,
  readJobsFromFile,
} = require('./lib/database');
const { validateStructuredTask } = require('./config/structured-tasks');
const { validateEnvironmentPayload: validateExecutionEnvironmentPayload } = require('./config/execution-environments');
const { persistSchedule } = require('./lib/schedule-store');
const { createLogThrottle } = require('./lib/log-throttle');

const humanCronLocale = process.env.HUMANCRON ?? 'en';

const dbFolder = process.env.CRON_DB_PATH || path.join(__dirname, 'crontabs');
if (/[\r\n\0]/.test(dbFolder)) throw new Error('CRON_DB_PATH must not contain line breaks or null bytes');
console.log(`Cron db path: ${dbFolder}`);

const logFolder = path.join(dbFolder, 'logs');
const auditFile = path.join(logFolder, 'operations.jsonl');
const envFile = path.join(dbFolder, 'env.db');
const crontabDbFile = path.join(dbFolder, 'crontab.db');

const db = new SqliteDatastore({ filename: crontabDbFile });
db.updateExecutionTargetHealth('native-local', process.env.CRON_IN_DOCKER === 'true' ? 'unavailable' : 'unknown', null, null);

// Every limit is read through config/limits.js. An unvalidated value was not hypothetical: a
// non-numeric EXECUTION_HISTORY_PER_JOB reached SQLite as NULL, the retention query matched no
// rows, and the whole execution history was deleted on the first run.
const commandTimeoutMs = useCommandTimeoutMs();
const commandMemoryLimitMb = useResourceLimit('COMMAND_MEMORY_LIMIT_MB', 0, 0, 1024 * 1024);
const commandCpuSeconds = useResourceLimit('COMMAND_CPU_SECONDS', 0, 0, 86400);
const commandMaxProcesses = useResourceLimit('COMMAND_MAX_PROCESSES', 0, 0, 100000);
const executionRuntime = Object.freeze({
  timeoutMs: commandTimeoutMs,
  version: require('./package.json').version,
  hostname: os.hostname(),
  pid: process.pid,
  codeHash: crypto.createHash('sha256')
    .update(fs.readFileSync(__filename))
    .update(fs.readFileSync(path.join(__dirname, 'execution.js')))
    .update(fs.readFileSync(path.join(__dirname, 'bin', 'crontab-ui-runner.js')))
    .digest('hex'),
  resourceLimits: Object.freeze({
    memoryLimitMb: commandMemoryLimitMb,
    cpuSeconds: commandCpuSeconds,
    maxProcesses: commandMaxProcesses,
  }),
  identity: Object.freeze({
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    gid: typeof process.getgid === 'function' ? process.getgid() : null,
    username: os.userInfo().username || null,
  }),
});
const commandMaxBuffer = useBoundedNumber('COMMAND_MAX_BUFFER', 1024 * 1024, 1024, 256 * 1024 * 1024);
const commandKillGraceMs = useBoundedNumber('COMMAND_KILL_GRACE_MS', 5000, 0, 600000);
const manualRunConcurrency = process.env.MANUAL_RUN_CONCURRENCY === 'forbid' ? 'forbid' : 'allow';
const maxLogBytes = useBoundedNumber('LOG_MAX_BYTES', 10 * 1024 * 1024, 1024, 4 * 1024 * 1024 * 1024);
const logRotationCount = useBoundedNumber('LOG_ROTATION_COUNT', 5, 0, 100);
const logRetentionDays = useBoundedNumber('LOG_RETENTION_DAYS', 30, 1, 3650);
const backupRetentionCount = useBoundedNumber('BACKUP_RETENTION_COUNT', 30, 1, 10_000);
const backupRetentionDays = useBoundedNumber('BACKUP_RETENTION_DAYS', 90, 1, 3650);
const backupExternalDir = process.env.BACKUP_EXTERNAL_DIR ? path.resolve(process.env.BACKUP_EXTERNAL_DIR) : '';
const systemCrontabImportTimeoutMs = useBoundedNumber('SYSTEM_CRONTAB_IMPORT_TIMEOUT_MS', 30000, 1000, 10 * 60 * 1000);
const systemCrontabImportMaxBuffer = useBoundedNumber('SYSTEM_CRONTAB_IMPORT_MAX_BUFFER', 256 * 1024, 1024, 64 * 1024 * 1024);
const executionHistoryPerJob = useBoundedNumber('EXECUTION_HISTORY_PER_JOB', 200, 1, 10_000);
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

function buildCrontab(name, command, schedule, stopped, logging, mailing, ownership = {}, execution = null) {
  return {
    name,
    command,
    execution_mode: execution?.mode === 'structured' ? 'structured' : undefined,
    structured_execution: execution?.mode === 'structured' ? execution.definition : undefined,
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
  const quotedDbFolder = "'" + path.resolve(dbFolder).replace(/'/g, "'\\''") + "'";
  const cronDbFolder = isDockerScheduler() ? quotedDbFolder : quotedDbFolder.replace(/%/g, '\\%');
  return `CRON_DB_PATH=${cronDbFolder} COMMAND_TIMEOUT_MS=${commandTimeoutMs} "${process.execPath}" "${path.join(__dirname, 'bin', 'crontab-ui-runner.js')}" ${tab._id}`;
}

function applySystemCrontab(filePath, callback) {
  return execFile('crontab', [filePath], {
    timeout: commandTimeoutMs || 300000,
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
    timeout: commandTimeoutMs || 300000,
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

exports.listExecutionTargets = () => db.listExecutionTargets();
exports.updateExecutionTargetHealth = (id, status, version, lastSeenAt) => db.updateExecutionTargetHealth(id, status, version, lastSeenAt);
exports.listExecutionEnvironments = (filters) => db.listExecutionEnvironments(filters);
exports.countExecutionEnvironments = (filters) => db.countExecutionEnvironments(filters);
exports.getExecutionCatalog = () => db.getExecutionCatalog();
exports.countStructuredTasksByEnvironment = () => {
  const counts = {};
  for (const job of db.getAllData()) {
    const environmentId = job.execution_mode === 'structured' ? job.structured_execution?.environment_id : null;
    if (environmentId) counts[environmentId] = (counts[environmentId] || 0) + 1;
  }
  return counts;
};
exports.getExecutionEnvironment = (id) => db.getExecutionEnvironment(id);
exports.createExecutionEnvironment = (environment) => db.createExecutionEnvironment(environment);
exports.updateExecutionEnvironment = (id, revision, changes, actor) => db.updateExecutionEnvironment(id, revision, changes, actor);
exports.setExecutionEnvironmentEnabled = (id, enabled, actor, revision) => db.setExecutionEnvironmentEnabled(id, enabled, actor, revision);
exports.addEnvironmentValidation = (id, validation) => db.addEnvironmentValidation(id, validation);
exports.listEnvironmentValidations = (id, limit) => db.listEnvironmentValidations(id, limit);

exports.create_new = (name, command, schedule, logging, mailing, ownership = {}, callback = () => {}, structuredExecution = null) => {
  const execution = structuredExecution ? { mode: 'structured', definition: structuredExecution } : null;
  const tab = buildCrontab(name, command, schedule, false, logging, mailing, ownership, execution);
  tab._id = crypto.randomUUID();
  tab.created = Date.now();
  tab.saved = false;
  db.insert(tab, callback);
};

exports.update = (_id, data, callback = () => {}) => {
  if (typeof _id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(_id)) {
    return callback(new Error('Invalid job id'));
  }
  const execution = data.execution_mode === 'structured'
    ? { mode: 'structured', definition: data.structured_execution }
    : null;
  const tab = buildCrontab(data.name, data.command, data.schedule, null, data.logging, data.mailing, {}, execution);
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

// Error first, so a failed read is distinguishable from a task that does not exist. The datastore
// reports a failure by calling back with the error alone, which previously left `docs` undefined
// and raised a TypeError inside a microtask with no reference to the cause. Answering both cases
// differently matters: a database problem must not be reported to the caller as "no such task".
exports.get_crontab = (_id, callback) => {
  db.find({ _id }).exec((err, docs) => {
    if (err) {
      console.error(`Unable to read task ${_id}: ${err.message}`);
      return callback(err);
    }
    return callback(null, docs[0]);
  });
};

const auditState = { ok: true, failures: 0, lastError: null, lastErrorAt: null };
const auditErrorLog = createLogThrottle(5 * 60 * 1000);

function audit(event) {
  try {
    rotateLog(auditFile);
    const entry = `${JSON.stringify({ timestamp: new Date().toISOString(), ...redact(event) })}\n`;
    let writeError;
    for (let attempt = 0; attempt < auditWriteAttempts; attempt += 1) {
      try {
        fs.appendFileSync(auditFile, entry, { encoding: 'utf8', mode: 0o600 });
        auditState.ok = true;
        auditErrorLog.reset();
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
    auditState.ok = false;
    auditState.failures += 1;
    auditState.lastError = error.message;
    auditState.lastErrorAt = new Date().toISOString();
    if (auditErrorLog.shouldLog(error.message)) {
      console.error('Unable to write audit record:', error.message);
    }
  }
}

exports.audit = audit;
exports.auditHealth = () => ({ ...auditState });

exports.searchAudit = (filters, limit) => {
  const rotated = Array.from({ length: logRotationCount }, (_, index) => `${auditFile}.${index + 1}`);
  return searchAudit([auditFile, ...rotated], filters, limit);
};

exports.recoverManualRuns = () => {
  const recovered = db.recoverManualRuns(Date.now());
  if (recovered) audit({ type: 'manual_run', status: 'interrupted', reason: 'service_restart', count: recovered });
  return recovered;
};

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
function recordExecution({ job, operationId, trigger, actor, startedAt, status, result, runtime = executionRuntime }) {
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
      runtime,
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

let dispatchMailer = defaultMailerSpawn;

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
  const child = dispatchMailer([tab._id, operationId, outcome, durationMs, exitCode]);
  watchMailerProcess(child, { operationId, jobId: tab._id });
  if (child.unref) child.unref();
  return true;
}

function defaultMailerSpawn(args) {
  const mailerEnvironment = { ...process.env };
  delete mailerEnvironment.CRONTAB_UI_AGENT_HMAC_SECRET;
  return spawn(process.execPath, [path.join(__dirname, 'bin', 'crontab-ui-mailer.js'), ...args], {
    detached: false,
    env: mailerEnvironment,
    stdio: 'ignore',
  });
}

// Launching the mailer is a collaborator, not an internal detail: it is what turns a delivery
// decision into a real attempt, and a substitute makes the decision itself verifiable without a
// live SMTP server. This is the same injection the application uses for publishing a crontab.
// Returns the previous dispatcher so a caller can restore it.
function setMailerDispatcher(override) {
  const previous = dispatchMailer;
  dispatchMailer = override || defaultMailerSpawn;
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

// Session records back the revocable sign-in cookie. A signed cookie alone cannot be withdrawn
// before it expires, which is what this exists to change.
exports.sessions = {
  create: (session) => db.createSession(session),
  get: (id) => db.getSession(id),
  revoke: (id, at) => db.revokeSession(id, at),
  revokeUser: (user, at) => db.revokeUserSessions(user, at),
  prune: (now) => db.pruneSessions(now),
};

exports.should_send_mail = shouldSendMail;
exports.watch_mailer_process = watchMailerProcess;
exports.set_mailer_dispatcher = setMailerDispatcher;

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

  try {
    db.pruneSessions(Date.now());
  } catch (error) {
    audit({ type: 'retention', status: 'failed', scope: 'sessions', error: error.message });
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
    const operationId = crypto.randomUUID();
    let plan;
    try {
      plan = prepareJobExecution(res);
    } catch (dispatchError) {
      audit({
        operationId, type: 'execution_dispatch', jobId: _id, trigger: 'scheduled',
        status: dispatchError.code === 'EXECUTOR_UNAVAILABLE' ? 'unreachable' : 'rejected',
        errorCode: dispatchError.code || 'DISPATCH_REJECTED', ...auditContext,
      });
      return callback(dispatchError);
    }
    audit({ operationId, type: 'runjob', jobId: _id, status: 'started', ...auditContext, runtime: plan.runtime });

    const startedAt = Date.now();
    executeJob(res, plan, operationId, (error, result) => {
      const failed = Boolean(error);
      const output = result.dispatchStatus ? null : recordOutput(res, result, operationId);
      // The execution is recorded before the notification decision, because the number of
      // consecutive failures is what that decision depends on.
      if (!result.dispatchStatus) {
        recordExecution({
          job: res, operationId, trigger: 'scheduled', startedAt,
          status: resolveTerminalState(error, result), result, runtime: plan.runtime,
        });
        if (output) deliverMail(res, operationId, result, failed);
        else if (shouldSendMail(res.mailing, failed)) audit({ operationId, type: 'mail', jobId: res._id, status: 'skipped', reason: 'output_unavailable' });
        applyRetention();
      }
      audit({ operationId, type: result.dispatchStatus ? 'execution_dispatch' : 'runjob', jobId: _id, status: error ? 'failed' : 'completed', dispatchStatus: result.dispatchStatus, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, terminationReason: result.terminationReason, outputExceeded: result.outputExceeded, identity: result.identity, resourceLimits: result.resourceLimits, error: error?.message, ...auditContext, runtime: plan.runtime });
      callback(error, { operationId, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, terminationReason: result.terminationReason });
    });
  });
};

function prepareJobExecution(job) {
  if (job.execution_mode === 'structured') {
    const environmentId = job.structured_execution?.environment_id;
    const environment = typeof environmentId === 'string' ? db.getExecutionEnvironment(environmentId) : null;
    if (environment?.targetId === 'ubuntu-local') {
      if (!environment.enabled) throw Object.assign(new Error('Execution environment is disabled'), { statusCode: 409, code: 'ENVIRONMENT_DISABLED' });
      const target = db.listExecutionTargets().find((item) => item.id === environment.targetId);
      if (!target || target.healthStatus !== 'online') {
        throw Object.assign(new Error('The local execution agent is unavailable'), { statusCode: 503, code: 'EXECUTOR_UNAVAILABLE' });
      }
      if (environment.validationStatus !== 'valid') {
        throw Object.assign(new Error('Execution environment must be validated before use'), { statusCode: 409, code: 'ENVIRONMENT_NOT_VALIDATED' });
      }
      const definition = job.structured_execution;
      return {
        agent: {
          taskId: job._id,
          environmentCode: environment.code,
          environmentRevision: environment.revision,
          scriptPath: definition.script_path,
          workingDirectory: definition.working_directory || environment.defaultWorkingDirectory || path.posix.dirname(definition.script_path),
          arguments: definition.arguments,
          timeoutMs: definition.timeout_ms,
        },
        runtime: Object.freeze({ ...executionRuntime, executionMode: 'structured', environmentId: environment.id,
          environmentRevision: environment.revision, runtimeType: environment.runtimeType, scriptPath: definition.script_path }),
      };
    }
    const structured = prepareStructuredExecution(job, environment, { maximumTimeoutMs: commandTimeoutMs });
    return { structured, runtime: Object.freeze({ ...executionRuntime, ...structured.runtime }) };
  }
  let configuredEnvironment;
  try {
    configuredEnvironment = parseEnvironment(exports.get_env());
  } catch (error) {
    throw error;
  }
  return { environment: buildTaskEnvironment(configuredEnvironment), structured: null, runtime: executionRuntime };
}

function executeJob(job, plan, operationId, callback) {
  if (plan.agent) return executeAgentJob(plan.agent, operationId, callback);
  if (plan.structured) {
    return executeStructured(plan.structured.executable, plan.structured.args, {
      timeoutMs: plan.structured.timeoutMs,
      maxOutputBytes: commandMaxBuffer,
      killGraceMs: commandKillGraceMs,
      env: plan.structured.env,
      cwd: plan.structured.cwd,
      cgroupManager: plan.structured.cgroupManager || null,
      wrapperPath: plan.structured.wrapperPath || null,
      operationId,
    }, callback);
  }
  return execute(job.command, {
    timeoutMs: commandTimeoutMs,
    maxOutputBytes: commandMaxBuffer,
    killGraceMs: commandKillGraceMs,
    env: plan.environment,
    resourceLimits: { memoryLimitKb: commandMemoryLimitMb * 1024, cpuSeconds: commandCpuSeconds, maxProcesses: commandMaxProcesses },
  }, callback);
}

function executeAgentJob(plan, operationId, callback) {
  const client = new LocalAgentClient();
  const request = {
    operation_id: operationId,
    task_id: plan.taskId,
    environment_code: plan.environmentCode,
    environment_revision: plan.environmentRevision,
    script_path: plan.scriptPath,
    working_directory: plan.workingDirectory,
    arguments: plan.arguments,
    timeout_ms: plan.timeoutMs,
  };
  let completed = false;
  let cancelRequested = false;
  let pollFailures = 0;
  let pollTimer;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  const startedAt = Date.now();
  const finish = (error, result) => {
    if (completed) return;
    completed = true;
    if (pollTimer) clearTimeout(pollTimer);
    callback(error, result);
  };
  const updateAgentHealth = (status) => {
    try {
      const target = db.listExecutionTargets().find((item) => item.id === 'ubuntu-local');
      db.updateExecutionTargetHealth('ubuntu-local', status, target?.agentVersion || null, Date.now());
    } catch (error) {
      audit({ operationId, type: 'execution_target_health', status: 'failed', error: error.message });
    }
  };
  const loadLogs = async (stream) => {
    let cursor = 0;
    const chunks = [];
    for (let count = 0; count < 1024; count += 1) {
      const page = await client.getLogs(operationId, stream, cursor);
      if (page.content_base64) chunks.push(Buffer.from(page.content_base64, 'base64'));
      if (!Number.isSafeInteger(page.next_cursor) || page.next_cursor <= cursor) break;
      cursor = page.next_cursor;
      if (page.content_base64.length < 4) break;
    }
    return Buffer.concat(chunks);
  };
  const poll = async () => {
    if (completed) return;
    try {
      const execution = await client.getExecution(operationId);
      pollFailures = 0;
      if (['completed', 'failed', 'timeout', 'cancelled', 'output_limit', 'unknown'].includes(execution.status)) {
        try {
          [stdout, stderr] = await Promise.all([loadLogs('stdout'), loadLogs('stderr')]);
        } catch (_error) {
          stdout = Buffer.alloc(0);
          stderr = Buffer.alloc(0);
        }
        if (execution.status === 'unknown') {
          return finish(Object.assign(new Error('Agent execution outcome is unknown; automatic retry is disabled'), { code: 'AGENT_EXECUTION_UNKNOWN' }), {
            dispatchStatus: 'unknown', exitCode: null, signal: null, durationMs: Date.now() - startedAt,
            terminationReason: 'agent_restart', outputExceeded: execution.output_truncated,
            stdout, stderr, identity: executionRuntime.identity,
          });
        }
        const terminationReason = execution.termination_reason || null;
        const error = execution.status === 'completed' ? null
          : Object.assign(new Error(`Agent execution ${execution.status}`), { code: terminationReason || execution.status });
        return finish(error, {
          exitCode: execution.exit_code,
          signal: execution.signal,
          durationMs: execution.duration_ms,
          terminationReason,
          outputExceeded: execution.output_truncated || execution.status === 'output_limit',
          stdout,
          stderr,
          identity: executionRuntime.identity,
        });
      }
      if (cancelRequested) await client.cancelExecution(operationId).catch(() => {});
      pollTimer = setTimeout(poll, 500);
    } catch (error) {
      pollFailures += 1;
      if (pollFailures < 20) {
        pollTimer = setTimeout(poll, 500);
        return;
      }
      updateAgentHealth('unavailable');
      return finish(Object.assign(new Error('Agent execution outcome is unknown; automatic retry is disabled'), {
        code: error.code || 'AGENT_EXECUTION_UNKNOWN',
      }), {
        dispatchStatus: 'unknown', exitCode: null, signal: null, durationMs: Date.now() - startedAt,
        terminationReason: 'dispatch_unknown', outputExceeded: false,
        stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), identity: executionRuntime.identity,
      });
    }
  };

  client.submitExecution(request).then((response) => {
    if (!response.accepted) {
      return finish(Object.assign(new Error('Agent rejected the execution request'), { code: 'AGENT_DISPATCH_REJECTED' }), {
        dispatchStatus: 'rejected', exitCode: null, signal: null, durationMs: Date.now() - startedAt,
        terminationReason: null, outputExceeded: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), identity: executionRuntime.identity,
      });
    }
    updateAgentHealth('online');
    if (cancelRequested) client.cancelExecution(operationId).catch(() => {});
    void poll();
  }).catch((error) => {
    const policyRejection = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500;
    const dispatchStatus = error.code === 'AGENT_DISPATCH_UNKNOWN' ? 'unknown'
      : policyRejection ? 'rejected' : 'unreachable';
    if (!policyRejection) updateAgentHealth('unavailable');
    finish(error, {
      dispatchStatus, exitCode: null, signal: null, durationMs: Date.now() - startedAt,
      terminationReason: null, outputExceeded: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), identity: executionRuntime.identity,
    });
  });

  return {
    cancel() {
      cancelRequested = true;
      if (client.configured()) client.cancelExecution(operationId).catch(() => {});
    },
  };
}

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

exports.getLatestExecutions = () => db.listLatestExecutions();

exports.startManualRun = (_id, auditContext = {}, callback = () => {}) => {
  return db.find({ _id }).exec((err, docs) => {
    if (err || !docs.length) return callback(err || new Error('Job not found'));
    const job = docs[0];
    const operationId = crypto.randomUUID();
    const actor = auditContext.actor || 'local';
    let plan;
    try {
      plan = prepareJobExecution(job);
    } catch (dispatchError) {
      audit({
        operationId, type: 'execution_dispatch', jobId: _id, trigger: 'manual', actor,
        status: dispatchError.code === 'EXECUTOR_UNAVAILABLE' ? 'unreachable' : 'rejected',
        errorCode: dispatchError.code || 'DISPATCH_REJECTED', ...auditContext,
      });
      return callback(dispatchError);
    }
    if (manualRunConcurrency === 'forbid' && db.findActiveManualRun(_id)) {
      return callback(Object.assign(new Error('This task already has an active manual execution'), { statusCode: 409 }));
    }
    try {
      db.createManualRun({ operationId, jobId: _id, actor, status: EXECUTION_STATES.RUNNING, startedAt: Date.now() });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return callback(Object.assign(new Error('A manual execution is already active for this user'), { statusCode: 409 }));
      }
      return callback(error);
    }
    audit({ operationId, type: 'manual_run', jobId: _id, status: 'started', ...auditContext, runtime: plan.runtime });
    callback(null, exports.getManualRun(operationId));
    const startedAt = Date.now();
    const controller = executeJob(job, plan, operationId, (error, result) => {
      if (result.dispatchStatus) {
        const dispatchResult = {
          dispatchStatus: result.dispatchStatus,
          terminationReason: result.dispatchStatus === 'unknown' ? 'dispatch_unknown' : 'agent_unavailable',
        };
        db.completeManualRun(operationId, 'failed', Date.now(), dispatchResult);
        manualRunControllers.delete(operationId);
        audit({
          operationId,
          type: 'execution_dispatch',
          jobId: _id,
          status: result.dispatchStatus,
          errorCode: error?.code || null,
          ...auditContext,
          runtime: plan.runtime,
        });
        pruneManualRuns();
        return;
      }
      const failed = Boolean(error);
      const output = recordOutput(job, result, operationId);
      const status = resolveTerminalState(error, result);
      recordExecution({ job, operationId, trigger: 'manual', actor, startedAt, status, result, runtime: plan.runtime });
      if (output) deliverMail(job, operationId, result, failed);
      else if (shouldSendMail(job.mailing, failed)) audit({ operationId, type: 'mail', jobId: job._id, status: 'skipped', reason: 'output_unavailable' });
      applyRetention();
      const resultSummary = { exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, terminationReason: result.terminationReason, outputExceeded: result.outputExceeded, identity: result.identity, resourceLimits: result.resourceLimits };
      db.completeManualRun(operationId, status, Date.now(), resultSummary);
      manualRunControllers.delete(operationId);
      audit({ operationId, type: 'manual_run', jobId: _id, status, error: error?.message, ...resultSummary, ...auditContext, runtime: plan.runtime });
      pruneManualRuns();
    });
    manualRunControllers.set(operationId, controller);
  });
};

exports.cancelManualRun = (operationId, auditContext = {}) => {
  const run = exports.getManualRun(operationId);
  const controller = manualRunControllers.get(operationId);
  if (!run || run.status !== EXECUTION_STATES.RUNNING || !controller) return null;
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
          if (isDockerScheduler()) {
            try {
              persistSchedule(dbFolder, dockerCronUser, crontabFile);
            } catch (persistError) {
              audit({ type: 'schedule_persist', status: 'failed', error: persistError.message });
            }
          }
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

// A second copy outside the main data volume survives the loss of that volume. A failure here is
// audited but never fails the backup, which already exists locally.
function copyBackupExternally(backupFile) {
  if (!backupExternalDir) return;
  const name = path.basename(backupFile);
  const temporary = path.join(backupExternalDir, `.${name}.tmp`);
  try {
    fs.mkdirSync(backupExternalDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(backupFile, temporary);
    fs.renameSync(temporary, path.join(backupExternalDir, name));
    const kept = fs.readdirSync(backupExternalDir)
      .filter((file) => /^backup-.*\.db$/.test(file)).sort().reverse();
    for (const stale of kept.slice(backupRetentionCount)) fs.unlinkSync(path.join(backupExternalDir, stale));
    audit({ type: 'backup_external', status: 'completed', backup: name });
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The external directory may be unusable (for example ENOTDIR); the failure is audited below.
    }
    audit({ type: 'backup_external', status: 'failed', backup: name, error: error.message });
  }
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
      copyBackupExternally(dest);
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

function validateImportedJob(document, { preserveMetadata = false, environmentIds = new Set() } = {}) {
  if (!isPlainObject(document)) throw new Error('Imported record must be an object');
  for (const key of Object.keys(document)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new Error('Imported record contains a dangerous property');
    }
  }

  const accepted = new Set([
    '_id', 'name', 'command', 'schedule', 'stopped', 'logging', 'mailing', 'timestamp', 'created', 'saved',
    'hook', 'owner', 'createdBy', 'needsPublishReview', 'execution_mode', 'structured_execution',
  ]);
  for (const key of Object.keys(document)) {
    if (!accepted.has(key)) throw new Error(`Unsupported imported field: ${key}`);
  }

  if (typeof document.name !== 'string' || document.name.length > 128 || /[\r\n]/.test(document.name)) {
    throw new Error('Imported job has an invalid name');
  }
  const executionMode = document.execution_mode || 'command';
  let structuredExecution;
  if (!['command', 'structured'].includes(executionMode)) throw new Error('Imported job has an invalid execution mode');
  if (executionMode === 'command') {
    if (typeof document.command !== 'string' || !document.command.trim() || document.command.length > 2000 || /[\r\n]/.test(document.command)
      || document.structured_execution !== undefined) throw new Error('Imported job has an invalid command');
  } else {
    if (document.command !== undefined) throw new Error('Imported structured job must not include a command');
    try {
      structuredExecution = validateStructuredTask(document.structured_execution, useCommandTimeoutMs());
    } catch (error) {
      throw new Error(`Imported structured job is invalid: ${error.message}`);
    }
    if (!environmentIds.has(structuredExecution.environment_id)) {
      throw new Error('Imported structured job references an unknown execution environment');
    }
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
    ...(executionMode === 'command' ? { command: document.command } : {
      execution_mode: 'structured',
      structured_execution: structuredExecution,
    }),
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

function validateExecutionCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.targets)
    || !Array.isArray(catalog.environments) || !Array.isArray(catalog.validations)) {
    throw new Error('Imported execution environment catalog is invalid');
  }
  if (!catalog.targets.length && !catalog.environments.length && !catalog.validations.length) return catalog;
  const supportedTargets = new Set(['container-local', 'native-local', 'ubuntu-local']);
  const targetIds = new Set();
  const targets = catalog.targets.map((target) => {
    if (!target || !supportedTargets.has(target.id) || target.code !== target.id
      || !['container', 'local_agent', 'native_local'].includes(target.type)
      || typeof target.name !== 'string' || !target.name || target.name.length > 120
      || ![0, 1].includes(target.enabled)
      || !['unknown', 'online', 'degraded', 'unavailable'].includes(target.health_status)
      || !Number.isSafeInteger(target.created_at) || !Number.isSafeInteger(target.updated_at)) {
      throw new Error('Imported execution target is invalid');
    }
    let capabilities;
    try { capabilities = JSON.parse(target.capabilities_json); } catch (_error) {
      throw new Error('Imported execution target capabilities are invalid');
    }
    if (!isPlainObject(capabilities)) throw new Error('Imported execution target capabilities are invalid');
    if (targetIds.has(target.id)) throw new Error('Imported execution target is duplicated');
    targetIds.add(target.id);
    return {
      ...target,
      health_status: target.type === 'container' ? 'unknown' : 'unavailable',
      agent_version: null,
      last_seen_at: null,
    };
  });
  for (const id of ['container-local', 'ubuntu-local']) {
    if (!targetIds.has(id)) throw new Error('Imported execution target catalog is incomplete');
  }
  if (!targetIds.has('native-local')) {
    const now = Date.now();
    targets.push({
      id: 'native-local',
      code: 'native-local',
      name: 'Executor nativo',
      type: 'native_local',
      enabled: 1,
      capabilities_json: '{}',
      health_status: 'unavailable',
      agent_version: null,
      last_seen_at: null,
      created_at: now,
      updated_at: now,
    });
    targetIds.add('native-local');
  }

  const environmentIds = new Set();
  const codes = new Set();
  const environments = catalog.environments.map((environment) => {
    if (!environment || !/^[0-9a-f-]{36}$/i.test(environment.id || '')
      || !targetIds.has(environment.target_id)
      || !Number.isSafeInteger(environment.revision) || environment.revision < 1
      || !['pending', 'valid', 'invalid', 'unavailable'].includes(environment.validation_status)
      || ![0, 1].includes(environment.enabled)
      || !Number.isSafeInteger(environment.created_at) || !Number.isSafeInteger(environment.updated_at)
      || typeof environment.created_by !== 'string' || environment.created_by.length > 128
      || typeof environment.updated_by !== 'string' || environment.updated_by.length > 128) {
      throw new Error('Imported execution environment is invalid');
    }
    const payload = validateExecutionEnvironmentPayload({
      code: environment.code,
      name: environment.name,
      runtime_type: environment.runtime_type,
      target_id: environment.target_id,
      executable_path: environment.executable_path,
      default_working_directory: environment.default_working_directory,
      description: environment.description,
      enabled: Boolean(environment.enabled),
    });
    if (environmentIds.has(environment.id) || codes.has(environment.code)) {
      throw new Error('Imported execution environment is duplicated');
    }
    environmentIds.add(environment.id);
    codes.add(environment.code);
    return {
      ...environment,
      ...payload,
      runtime_type: payload.runtimeType,
      target_id: payload.targetId,
      executable_path: payload.executablePath,
      default_working_directory: payload.defaultWorkingDirectory || null,
      description: payload.description || null,
      enabled: payload.enabled ? 1 : 0,
    };
  });
  const validations = catalog.validations.map((validation) => {
    if (!validation || !/^[0-9a-f-]{36}$/i.test(validation.id || '')
      || !environmentIds.has(validation.environment_id)
      || typeof validation.actor !== 'string' || !validation.actor || validation.actor.length > 128
      || !['pending', 'valid', 'invalid', 'unavailable'].includes(validation.status)
      || (validation.message !== null && (typeof validation.message !== 'string' || validation.message.length > 512))
      || (validation.runtime_version !== null && (typeof validation.runtime_version !== 'string' || validation.runtime_version.length > 120))
      || !Number.isSafeInteger(validation.validated_at)) {
      throw new Error('Imported environment validation record is invalid');
    }
    return validation;
  });
  return { targets, environments, validations };
}

exports.normalise_database = (temporaryFile, callback, options = {}) => {
  setImmediate(() => {
    const normalisedFile = `${temporaryFile}.normalised-${crypto.randomUUID()}`;
    try {
      const catalog = validateExecutionCatalog(readExecutionCatalogFromFile(temporaryFile));
      const environmentIds = new Set(catalog.environments.map((environment) => environment.id));
      const jobs = readJobsFromFile(temporaryFile).map((document) => {
        const job = validateImportedJob(document, { ...options, environmentIds });
        return options.preserveMetadata ? job : { ...job, _id: crypto.randomUUID() };
      });
      createDatabaseFile(normalisedFile, jobs, catalog);
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
    job.execution_mode === 'structured' ? job.structured_execution : String(job.command || '').trim(),
    String(job.schedule || '').trim(),
  ]);
}

function importName(job) {
  return String(job.name || '').trim().toLocaleLowerCase('en-US');
}

function mergeExecutionCatalog(importedCatalog, existingCatalog) {
  const targets = new Map((existingCatalog.targets || []).map((target) => [target.id, target]));
  for (const target of importedCatalog.targets || []) {
    if (!targets.has(target.id)) targets.set(target.id, target);
  }
  const environments = new Map((existingCatalog.environments || []).map((environment) => [environment.id, environment]));
  const codes = new Map([...environments.values()].map((environment) => [environment.code, environment]));
  for (const environment of importedCatalog.environments || []) {
    const sameId = environments.get(environment.id);
    const sameCode = codes.get(environment.code);
    if (sameId) {
      const currentDefinition = [sameId.code, sameId.runtime_type, sameId.target_id, sameId.executable_path,
        sameId.default_working_directory, sameId.revision];
      const importedDefinition = [environment.code, environment.runtime_type, environment.target_id, environment.executable_path,
        environment.default_working_directory, environment.revision];
      if (JSON.stringify(currentDefinition) !== JSON.stringify(importedDefinition)) {
        throw Object.assign(new Error(`Imported environment conflicts with existing environment ${environment.code}`), { statusCode: 409 });
      }
      continue;
    }
    if (sameCode) {
      throw Object.assign(new Error(`Imported environment code already exists: ${environment.code}`), { statusCode: 409 });
    }
    environments.set(environment.id, environment);
    codes.set(environment.code, environment);
  }
  const validations = new Map((existingCatalog.validations || []).map((validation) => [validation.id, validation]));
  for (const validation of importedCatalog.validations || []) {
    if (environments.has(validation.environment_id)) validations.set(validation.id, validation);
  }
  return {
    targets: [...targets.values()].map((target) => ({
      ...target,
      health_status: target.type === 'container' ? 'unknown' : 'unavailable',
      agent_version: null,
      last_seen_at: null,
    })),
    environments: [...environments.values()],
    validations: [...validations.values()],
  };
}

function buildImportPlan(importedJobs, existingJobs, mode, importedCatalog = { targets: [], environments: [], validations: [] }, existingCatalog = db.getExecutionCatalog()) {
  if (!['merge', 'replace'].includes(mode)) throw new Error('Invalid import mode');

  if (mode === 'replace') {
    return {
      jobs: importedJobs,
      catalog: importedCatalog,
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

  const catalog = mergeExecutionCatalog(importedCatalog, existingCatalog);
  const environmentIds = new Set(catalog.environments.map((environment) => environment.id));
  for (const job of additions) {
    if (job.execution_mode === 'structured' && !environmentIds.has(job.structured_execution.environment_id)) {
      throw new Error('Imported structured job references an unknown execution environment');
    }
  }

  return {
    jobs: existingJobs.concat(additions),
    catalog,
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
  return buildImportPlan(readJobsFromFile(temporaryFile), db.getAllData(), mode,
    validateExecutionCatalog(readExecutionCatalogFromFile(temporaryFile)), db.getExecutionCatalog());
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
    if (mode === 'merge') createDatabaseFile(temporaryFile, plan.jobs, plan.catalog);
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
        // The tasks are replaced inside a transaction in the active database, on every platform.
        // Windows cannot rename a SQLite file that another connection has open, which used to
        // force a different path per platform, and the two paths disagreed: renaming the file on
        // other systems also replaced the execution history and the alert state, so an import or
        // a restore could resurrect a stale alert cooldown and discard local run history.
        // replaceDocuments is atomic on its own, so it removes the need for a rollback file and
        // makes import and restore behave identically everywhere.
        try {
          db.replaceDocuments(readJobsFromFile(temporaryFile), readExecutionCatalogFromFile(temporaryFile));
          db.dropOrphanedRunState();
        } catch (error) {
          return removeTemporaryFile(temporaryFile, () => done(error));
        }
        return removeTemporaryFile(temporaryFile, (cleanupError) => {
          if (cleanupError) console.warn(`Unable to remove imported temporary database: ${cleanupError.message}`);
          done(null);
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

exports.get_installed_crontab = (callback, readCrontab = readSystemCrontab) => {
  if (!isDockerScheduler()) {
    return readCrontab((error, content) => callback(error, error ? undefined : {
      content, source: 'system', confirmed: true,
    }));
  }
  const file = path.join(cronPath, process.env.CRON_USER || 'node');
  return fs.readFile(file, 'utf8', (error, content) => {
    if (error) return callback(error);
    let confirmed = false;
    try {
      const state = JSON.parse(fs.readFileSync(schedulerReloadStateFile(file), 'utf8'));
      confirmed = state.digest === crypto.createHash('sha256').update(content).digest('hex');
    } catch (_error) {
      confirmed = false;
    }
    return callback(null, { content, source: 'docker', confirmed });
  });
};

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
