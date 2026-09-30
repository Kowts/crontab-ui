'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000');

// A revoked session record is kept for a while so the sign-out remains visible in the table, then
// removed. The cookie is already refused from the moment it is revoked, so this is housekeeping.
const revokedSessionRetentionMs = 24 * 60 * 60 * 1000;

function isSqliteFile(fileName) {
  if (!fs.existsSync(fileName) || fs.statSync(fileName).size < SQLITE_HEADER.length) return false;
  const descriptor = fs.openSync(fileName, 'r');
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    fs.readSync(descriptor, header, 0, header.length, 0);
    return header.equals(SQLITE_HEADER);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readLegacyNeDb(fileName) {
  const records = new Map();
  const data = fs.readFileSync(fileName, 'utf8');
  for (const [index, line] of data.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_error) {
      throw new Error(`Invalid legacy NeDB record at line ${index + 1}`);
    }
    if (!entry || typeof entry !== 'object' || entry.$$indexCreated) continue;
    if (typeof entry._id !== 'string') throw new Error(`Legacy NeDB record at line ${index + 1} has no id`);
    if (entry.$$deleted) records.delete(entry._id);
    else records.set(entry._id, entry);
  }
  return [...records.values()];
}

function escapeSqlitePath(fileName) {
  return fileName.replace(/'/g, "''");
}

function initialise(database) {
  database.pragma('journal_mode = DELETE');
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      document TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
    CREATE TABLE IF NOT EXISTS manual_runs (
      operation_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      result TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_runs_active_actor
      ON manual_runs(actor) WHERE status = 'running';
    CREATE INDEX IF NOT EXISTS idx_manual_runs_completed_at ON manual_runs(completed_at DESC);
    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      actor TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      signal TEXT,
      duration_ms INTEGER,
      termination_reason TEXT,
      output_exceeded INTEGER,
      started_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_executions_job_started ON executions(job_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_completed ON executions(completed_at DESC);
    CREATE TABLE IF NOT EXISTS job_alerts (
      job_id TEXT PRIMARY KEY,
      last_alert_at INTEGER NOT NULL,
      alerted_at_failures INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
}

function normaliseDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Database contains an invalid job document');
  if (typeof document._id !== 'string' || !document._id) throw new Error('Database contains a job without an id');
  return document;
}

function insertDocuments(database, documents) {
  const insert = database.prepare('INSERT INTO jobs (id, document, created_at) VALUES (?, ?, ?)');
  const save = database.transaction((items) => {
    for (const item of items) {
      const document = normaliseDocument(item);
      insert.run(document._id, JSON.stringify(document), Number.isFinite(document.created) ? document.created : 0);
    }
  });
  save(documents);
}

function readDocuments(database) {
  return database.prepare('SELECT document FROM jobs ORDER BY created_at DESC').all().map((row) => {
    try {
      return normaliseDocument(JSON.parse(row.document));
    } catch (error) {
      throw new Error(`Database contains invalid job data: ${error.message}`);
    }
  });
}

function readDocumentsByIds(database, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = database.prepare(`SELECT document FROM jobs WHERE id IN (${placeholders})`).all(...ids);
  return rows.map((row) => {
    try {
      return normaliseDocument(JSON.parse(row.document));
    } catch (error) {
      throw new Error(`Database contains invalid job data: ${error.message}`);
    }
  });
}

function queryIds(query) {
  if (!query || Object.keys(query).length !== 1 || !Object.hasOwn(query, '_id')) return null;
  if (typeof query._id === 'string') return [query._id];
  if (Array.isArray(query._id?.$in)) return query._id.$in.filter((id) => typeof id === 'string');
  return null;
}

function createDatabaseFile(fileName, documents) {
  fs.rmSync(fileName, { force: true });
  const database = new Database(fileName);
  try {
    initialise(database);
    insertDocuments(database, documents);
  } finally {
    database.close();
  }
}

function readJobsFromFile(fileName) {
  if (!isSqliteFile(fileName)) return readLegacyNeDb(fileName);
  const database = new Database(fileName, { readonly: true, fileMustExist: true });
  try {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get();
    if (!table) throw new Error('SQLite database does not contain the jobs table');
    return readDocuments(database);
  } finally {
    database.close();
  }
}

function migrateLegacyFile(fileName) {
  const documents = readLegacyNeDb(fileName);
  const temporary = `${fileName}.migration-${crypto.randomUUID()}.tmp`;
  const legacy = `${fileName}.legacy-nedb-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  createDatabaseFile(temporary, documents);
  try {
    fs.renameSync(fileName, legacy);
    try {
      fs.renameSync(temporary, fileName);
    } catch (error) {
      fs.renameSync(legacy, fileName);
      throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return legacy;
}

class SqliteDatastore {
  constructor({ filename }) {
    this.filename = filename;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (fs.existsSync(filename) && fs.statSync(filename).size > 0 && !isSqliteFile(filename)) {
      const legacy = migrateLegacyFile(filename);
      console.log(`Migrated legacy NeDB database to SQLite; retained source at ${legacy}`);
    }
    this.open();
  }

  open() {
    this.database = new Database(this.filename);
    initialise(this.database);
  }

  close() {
    if (!this.database) return;
    this.database.pragma('optimize');
    this.database.close();
    this.database = null;
  }

  reload() {
    this.close();
    this.open();
  }

  loadDatabase(callback = () => {}) {
    queueMicrotask(() => callback(null));
  }

  find(query = {}) {
    const datastore = this;
    let sort = null;
    return {
      sort(value) {
        sort = value;
        return this;
      },
      exec(callback) {
        queueMicrotask(() => {
          try {
            const ids = queryIds(query);
            const documents = ids === null
              ? readDocuments(datastore.database).filter((document) => datastore.matches(document, query))
              : readDocumentsByIds(datastore.database, ids).filter((document) => datastore.matches(document, query));
            if (sort?.created) documents.sort((left, right) => (sort.created < 0 ? right.created - left.created : left.created - right.created));
            callback(null, documents);
          } catch (error) {
            callback(error);
          }
        });
      },
    };
  }

  matches(document, query) {
    return Object.entries(query).every(([key, expected]) => {
      if (expected && typeof expected === 'object' && Array.isArray(expected.$in)) return expected.$in.includes(document[key]);
      return document[key] === expected;
    });
  }

  insert(document, callback = () => {}) {
    queueMicrotask(() => {
      try {
        const value = normaliseDocument(document);
        this.database.prepare('INSERT INTO jobs (id, document, created_at) VALUES (?, ?, ?)')
          .run(value._id, JSON.stringify(value), Number.isFinite(value.created) ? value.created : 0);
        callback(null, value);
      } catch (error) {
        callback(error);
      }
    });
  }

  update(query, update, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    callback ||= () => {};
    queueMicrotask(() => {
      try {
        const ids = queryIds(query);
        const documents = ids === null
          ? readDocuments(this.database).filter((document) => this.matches(document, query))
          : readDocumentsByIds(this.database, ids).filter((document) => this.matches(document, query));
        const patch = update.$set || update;
        const write = this.database.prepare('UPDATE jobs SET document = ?, created_at = ? WHERE id = ?');
        const persist = this.database.transaction((items) => {
          for (const document of items) {
            const value = { ...document, ...patch };
            write.run(JSON.stringify(value), Number.isFinite(value.created) ? value.created : 0, value._id);
          }
        });
        persist(options?.multi ? documents : documents.slice(0, 1));
        callback(null, documents.length);
      } catch (error) {
        callback(error);
      }
    });
  }

  remove(query, _options, callback = () => {}) {
    queueMicrotask(() => {
      try {
        const requestedIds = queryIds(query);
        const ids = requestedIds === null
          ? readDocuments(this.database).filter((document) => this.matches(document, query)).map((document) => document._id)
          : requestedIds;
        const remove = this.database.prepare('DELETE FROM jobs WHERE id = ?');
        const execute = this.database.transaction((values) => values.forEach((id) => remove.run(id)));
        execute(ids);
        callback(null, ids.length);
      } catch (error) {
        callback(error);
      }
    });
  }

  getAllData() {
    return readDocuments(this.database);
  }

  compactDatafile(callback = () => {}) {
    queueMicrotask(() => {
      try {
        this.database.pragma('optimize');
        callback(null);
      } catch (error) {
        callback(error);
      }
    });
  }

  snapshotTo(fileName) {
    fs.rmSync(fileName, { force: true });
    this.database.exec(`VACUUM INTO '${escapeSqlitePath(fileName)}'`);
  }

  replaceDocuments(documents) {
    const values = documents.map((document) => normaliseDocument(document));
    const replace = this.database.transaction((items) => {
      const clear = this.database.prepare('DELETE FROM jobs');
      const insert = this.database.prepare('INSERT INTO jobs (id, document, created_at) VALUES (?, ?, ?)');
      clear.run();
      for (const document of items) {
        insert.run(document._id, JSON.stringify(document), Number.isFinite(document.created) ? document.created : 0);
      }
    });
    replace(values);
  }

  createManualRun(run) {
    this.database.prepare(`
      INSERT INTO manual_runs (operation_id, job_id, actor, status, started_at)
      VALUES (@operationId, @jobId, @actor, @status, @startedAt)
    `).run(run);
  }

  getManualRun(operationId) {
    const row = this.database.prepare('SELECT * FROM manual_runs WHERE operation_id = ?').get(operationId);
    if (!row) return null;
    return {
      operationId: row.operation_id,
      jobId: row.job_id,
      actor: row.actor,
      status: row.status,
      startedAt: row.started_at,
      ...(row.completed_at !== null && { completedAt: row.completed_at }),
      ...(row.result && { result: JSON.parse(row.result) }),
    };
  }

  completeManualRun(operationId, status, completedAt, result) {
    this.database.prepare(`
      UPDATE manual_runs SET status = ?, completed_at = ?, result = ? WHERE operation_id = ?
    `).run(status, completedAt, JSON.stringify(result), operationId);
  }

  recoverManualRuns(completedAt) {
    return this.database.prepare(`
      UPDATE manual_runs
      SET status = 'interrupted', completed_at = ?, result = ?
      WHERE status = 'running'
    `).run(completedAt, JSON.stringify({ terminationReason: 'service_restart' })).changes;
  }

  pruneManualRuns(cutoff, keepCompleted) {
    const completed = this.database.prepare(`
      SELECT operation_id FROM manual_runs WHERE completed_at IS NOT NULL
      ORDER BY completed_at DESC
    `).all();
    const remove = this.database.prepare(`
      DELETE FROM manual_runs
      WHERE completed_at < ? OR operation_id = ?
    `);
    const prune = this.database.transaction(() => {
      this.database.prepare('DELETE FROM manual_runs WHERE completed_at < ?').run(cutoff);
      completed.slice(keepCompleted).forEach((row) => remove.run(cutoff, row.operation_id));
    });
    prune();
  }

  createExecution(execution) {
    this.database.prepare(`
      INSERT INTO executions (
        operation_id, job_id, trigger, actor, status, exit_code, signal,
        duration_ms, termination_reason, output_exceeded, started_at, completed_at
      ) VALUES (
        @operationId, @jobId, @trigger, @actor, @status, @exitCode, @signal,
        @durationMs, @terminationReason, @outputExceeded, @startedAt, @completedAt
      )
    `).run({
      ...execution,
      // SQLite binds only numbers, strings, buffers and null, so every optional value is coerced
      // here rather than at the call site.
      actor: execution.actor || null,
      exitCode: Number.isSafeInteger(execution.exitCode) ? execution.exitCode : null,
      signal: execution.signal || null,
      durationMs: Number.isSafeInteger(execution.durationMs) ? execution.durationMs : null,
      terminationReason: execution.terminationReason || null,
      outputExceeded: execution.outputExceeded ? 1 : 0,
    });
  }

  listExecutions(jobId, limit) {
    return this.database.prepare(`
      SELECT operation_id, job_id, trigger, actor, status, exit_code, signal,
             duration_ms, termination_reason, output_exceeded, started_at, completed_at
      FROM executions
      WHERE job_id = ?
      ORDER BY completed_at DESC
      LIMIT ?
    `).all(jobId, limit).map(mapExecution);
  }

  countConsecutiveFailures(jobId) {
    const latest = this.database.prepare(`
      SELECT status FROM executions WHERE job_id = ? ORDER BY completed_at DESC LIMIT 1
    `).get(jobId);
    if (!latest || latest.status === 'completed') return 0;
    return this.database.prepare(`
      SELECT COUNT(*) AS total FROM executions
      WHERE job_id = ? AND completed_at > COALESCE((
        SELECT MAX(completed_at) FROM executions WHERE job_id = ? AND status = 'completed'
      ), 0)
    `).get(jobId, jobId).total;
  }

  // The panel answers "is this task healthy" without reading the history: the latest outcome, the
  // last known good run, and how many failures have stacked up since it. A cancelled or timed out
  // run counts as a failure, because the command did not do its job.
  summariseExecutions(jobId) {
    const latest = this.database.prepare(`
      SELECT * FROM executions WHERE job_id = ? ORDER BY completed_at DESC LIMIT 1
    `).get(jobId);
    const lastSuccess = this.database.prepare(`
      SELECT * FROM executions
      WHERE job_id = ? AND status = 'completed'
      ORDER BY completed_at DESC LIMIT 1
    `).get(jobId);
    return {
      lastRun: latest ? mapExecution(latest) : null,
      lastSuccess: lastSuccess ? mapExecution(lastSuccess) : null,
      consecutiveFailures: this.countConsecutiveFailures(jobId),
    };
  }

  // A signed cookie is only a claim. The record here is what makes it revocable: signing out
  // removes the row, so a copy of the cookie taken beforehand stops being accepted immediately
  // instead of remaining valid until it expires.
  createSession(session) {
    this.database.prepare(`
      INSERT INTO sessions (id, user, issued_at, expires_at) VALUES (@id, @user, @issuedAt, @expiresAt)
    `).run(session);
  }

  getSession(id) {
    const row = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      user: row.user,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at === null ? null : row.revoked_at,
    };
  }

  revokeSession(id, revokedAt) {
    this.database.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(revokedAt, id);
  }

  // Used when a password changes or an administrator ends access for one account. Every browser
  // that account had open is invalidated in one step, which individual sign-out cannot achieve.
  revokeUserSessions(user, revokedAt) {
    return this.database.prepare('UPDATE sessions SET revoked_at = ? WHERE user = ? AND revoked_at IS NULL')
      .run(revokedAt, user).changes;
  }

  pruneSessions(now) {
    // Revoked rows are kept briefly so a sign-out is auditable, then removed. An expired row is
    // meaningless either way, since the cookie stops being accepted at that point.
    this.database.prepare('DELETE FROM sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)')
      .run(now, now - revokedSessionRetentionMs);
  }

  getAlertState(jobId) {
    const row = this.database.prepare('SELECT * FROM job_alerts WHERE job_id = ?').get(jobId);
    return row ? { jobId: row.job_id, lastAlertAt: row.last_alert_at, alertedAtFailures: row.alerted_at_failures } : null;
  }

  recordAlert(jobId, at, failures) {
    this.database.prepare(`
      INSERT INTO job_alerts (job_id, last_alert_at, alerted_at_failures) VALUES (?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET last_alert_at = excluded.last_alert_at,
        alerted_at_failures = excluded.alerted_at_failures
    `).run(jobId, at, failures);
  }

  // A task that works again ends the incident. Clearing here is what lets a later failure alert
  // immediately instead of waiting out a cooldown that belonged to an outage already over.
  clearAlert(jobId) {
    this.database.prepare('DELETE FROM job_alerts WHERE job_id = ?').run(jobId);
  }

  // After the task set is replaced, run records and alert state for tasks that no longer exist are
  // meaningless. Execution history is otherwise kept on purpose, since it outliving a task helps a
  // post-mortem; alert state is not, because a stale cooldown would suppress the first alert of a
  // restored or recreated task.
  dropOrphanedRunState() {
    const clean = this.database.transaction(() => {
      this.database.prepare('DELETE FROM executions WHERE job_id NOT IN (SELECT id FROM jobs)').run();
      this.database.prepare('DELETE FROM manual_runs WHERE job_id NOT IN (SELECT id FROM jobs)').run();
      this.database.prepare('DELETE FROM job_alerts WHERE job_id NOT IN (SELECT id FROM jobs)').run();
    });
    clean();
  }

  pruneExecutions(cutoff, keepPerJob) {
    // The per-task cap decides which records survive. A limit that is missing, zero or NaN would
    // make the row-number comparison match nothing, so the NOT IN would select every record and
    // delete the entire history. Refuse it here rather than trust the caller.
    if (!Number.isSafeInteger(keepPerJob) || keepPerJob < 1) return;
    const prune = this.database.transaction(() => {
      this.database.prepare('DELETE FROM executions WHERE completed_at < ?').run(cutoff);
      this.database.prepare(`
        DELETE FROM executions
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY completed_at DESC) AS position
            FROM executions
          )
          WHERE position <= ?
        )
      `).run(keepPerJob);
      // Alert state left behind by a task that no longer exists would otherwise accumulate
      // forever, since only a successful run and an explicit removal ever clear it.
      this.database.prepare('DELETE FROM job_alerts WHERE job_id NOT IN (SELECT id FROM jobs)').run();
    });
    prune();
  }
}

function mapExecution(row) {
  return {
    operationId: row.operation_id,
    jobId: row.job_id,
    trigger: row.trigger,
    actor: row.actor,
    status: row.status,
    exitCode: row.exit_code,
    signal: row.signal,
    durationMs: row.duration_ms,
    terminationReason: row.termination_reason,
    outputExceeded: row.output_exceeded === 1,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

module.exports = {
  SqliteDatastore,
  createDatabaseFile,
  isSqliteFile,
  readJobsFromFile,
};
