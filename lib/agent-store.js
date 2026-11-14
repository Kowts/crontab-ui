'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

class LocalAgentStore {
  constructor({ filename }) {
    this.filename = filename;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(filename)) fs.closeSync(fs.openSync(filename, 'a', 0o600));
    this.database = new Database(filename);
    this.database.pragma('journal_mode = DELETE');
    this.database.pragma('synchronous = FULL');
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agent_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_nonces (
        nonce TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_nonces_created ON agent_nonces(created_at);
      CREATE TABLE IF NOT EXISTS agent_executions (
        operation_id TEXT PRIMARY KEY,
        request_fingerprint TEXT NOT NULL,
        task_id TEXT NOT NULL,
        environment_code TEXT NOT NULL,
        environment_revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('accepted','running','completed','failed','timeout','cancelled','output_limit','unknown')),
        submitted_at INTEGER NOT NULL,
        accepted_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER,
        pid INTEGER,
        pid_started_at TEXT,
        exit_code INTEGER,
        signal TEXT,
        termination_reason TEXT,
        duration_ms INTEGER,
        stdout_path TEXT,
        stderr_path TEXT,
        output_bytes INTEGER NOT NULL DEFAULT 0,
        output_truncated INTEGER NOT NULL DEFAULT 0,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_executions_status ON agent_executions(status, submitted_at);
      INSERT OR IGNORE INTO agent_schema_migrations (version, applied_at)
        VALUES ('0001_agent_state', unixepoch('subsec') * 1000);
    `);
  }

  close() {
    if (this.database) this.database.close();
    this.database = null;
  }

  recordNonce(nonce, createdAt = Date.now()) {
    const insert = this.database.prepare('INSERT INTO agent_nonces (nonce, created_at) VALUES (?, ?)');
    const record = this.database.transaction(() => {
      this.database.prepare('DELETE FROM agent_nonces WHERE created_at < ?').run(createdAt - 300_000);
      insert.run(nonce, createdAt);
    });
    try {
      record.immediate();
      return true;
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
      throw error;
    }
  }

  acceptOperation({ operationId, fingerprint, taskId, environmentCode, environmentRevision, maxConcurrent, now = Date.now() }) {
    const accept = this.database.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM agent_executions WHERE operation_id = ?').get(operationId);
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw Object.assign(new Error('Operation ID was already used with a different request'), { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
        }
        return { existing: true, execution: mapAgentExecution(existing) };
      }
      const active = this.database.prepare(`
        SELECT COUNT(*) AS count FROM agent_executions WHERE status IN ('accepted','running')
      `).get().count;
      if (active >= maxConcurrent) {
        throw Object.assign(new Error('The local executor has reached its concurrency limit'), { statusCode: 429, code: 'AGENT_BUSY' });
      }
      this.database.prepare(`
        INSERT INTO agent_executions (
          operation_id, request_fingerprint, task_id, environment_code, environment_revision,
          status, submitted_at, accepted_at
        ) VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)
      `).run(operationId, fingerprint, taskId, environmentCode, environmentRevision, now, now);
      return { existing: false, execution: mapAgentExecution(this.database.prepare(
        'SELECT * FROM agent_executions WHERE operation_id = ?',
      ).get(operationId)) };
    });
    return accept.immediate();
  }

  setRunning(operationId, { pid, pidStartedAt, stdoutPath, stderrPath, startedAt = Date.now() }) {
    return this.database.prepare(`
      UPDATE agent_executions SET status = 'running', pid = ?, pid_started_at = ?,
        stdout_path = ?, stderr_path = ?, started_at = ? WHERE operation_id = ? AND status = 'accepted'
    `).run(pid, pidStartedAt || null, stdoutPath, stderrPath, startedAt, operationId).changes === 1;
  }

  complete(operationId, result) {
    return this.database.prepare(`
      UPDATE agent_executions SET status = ?, completed_at = ?, exit_code = ?, signal = ?,
        termination_reason = ?, duration_ms = ?, output_bytes = ?, output_truncated = ?, error_code = ?
      WHERE operation_id = ? AND status IN ('accepted','running')
    `).run(
      result.status, result.completedAt || Date.now(), Number.isSafeInteger(result.exitCode) ? result.exitCode : null,
      result.signal || null, result.terminationReason || null, Number.isSafeInteger(result.durationMs) ? result.durationMs : null,
      Number.isSafeInteger(result.outputBytes) ? result.outputBytes : 0, result.outputTruncated ? 1 : 0,
      result.errorCode || null, operationId,
    ).changes === 1;
  }

  markActiveUnknown(now = Date.now()) {
    return this.database.prepare(`
      UPDATE agent_executions SET status = 'unknown', completed_at = ?, termination_reason = 'agent_restart'
      WHERE status IN ('accepted','running')
    `).run(now).changes;
  }

  getOperation(operationId) {
    const row = this.database.prepare('SELECT * FROM agent_executions WHERE operation_id = ?').get(operationId);
    return row ? mapAgentExecution(row) : null;
  }

  listActive(limit = 100) {
    return this.database.prepare(`
      SELECT * FROM agent_executions WHERE status IN ('accepted','running')
      ORDER BY submitted_at LIMIT ?
    `).all(limit).map(mapAgentExecution);
  }

  listOperations() {
    return this.database.prepare('SELECT * FROM agent_executions ORDER BY submitted_at DESC').all().map(mapAgentExecution);
  }

  pruneCompleted(cutoff) {
    return this.database.prepare(`
      DELETE FROM agent_executions
      WHERE completed_at IS NOT NULL AND completed_at < ? AND status IN (
        'completed','failed','timeout','cancelled','output_limit'
      )
    `).run(cutoff).changes;
  }
}

function mapAgentExecution(row) {
  return {
    operationId: row.operation_id,
    requestFingerprint: row.request_fingerprint,
    taskId: row.task_id,
    environmentCode: row.environment_code,
    environmentRevision: row.environment_revision,
    status: row.status,
    submittedAt: row.submitted_at,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    pid: row.pid,
    pidStartedAt: row.pid_started_at,
    exitCode: row.exit_code,
    signal: row.signal,
    terminationReason: row.termination_reason,
    durationMs: row.duration_ms,
    stdoutPath: row.stdout_path,
    stderrPath: row.stderr_path,
    outputBytes: row.output_bytes,
    outputTruncated: row.output_truncated === 1,
    errorCode: row.error_code,
  };
}

module.exports = { LocalAgentStore };
