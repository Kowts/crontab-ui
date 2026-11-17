'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EXECUTION_STATES, isValidTransition } = require('../config/execution-states');

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
      completed_at INTEGER NOT NULL,
      runtime_metadata TEXT
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
  database.transaction(() => {
    if (!database.pragma('table_info(executions)').some(column => column.name === 'runtime_metadata')) {
      database.exec('ALTER TABLE executions ADD COLUMN runtime_metadata TEXT');
    }
  }).immediate();
  applyMigrations(database);
}

function applyMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const migration = '0001_execution_environments';
  if (!database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration)) {
    const apply = database.transaction(() => {
      database.exec(`
      CREATE TABLE execution_targets (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('container','local_agent','native_local')),
        enabled INTEGER NOT NULL DEFAULT 1,
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        health_status TEXT NOT NULL DEFAULT 'unknown',
        agent_version TEXT,
        last_seen_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE execution_environments (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        runtime_type TEXT NOT NULL CHECK(runtime_type IN ('python','node','bash','binary')),
        target_id TEXT NOT NULL REFERENCES execution_targets(id),
        executable_path TEXT NOT NULL,
        default_working_directory TEXT,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        validation_status TEXT NOT NULL DEFAULT 'pending'
          CHECK(validation_status IN ('pending','valid','invalid','unavailable')),
        runtime_version TEXT,
        validated_at INTEGER,
        revision INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_environments_target ON execution_environments(target_id);
      CREATE INDEX idx_environments_enabled ON execution_environments(enabled);
      CREATE TABLE environment_validation_history (
        id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL REFERENCES execution_environments(id),
        actor TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','valid','invalid','unavailable')),
        message TEXT,
        runtime_version TEXT,
        validated_at INTEGER NOT NULL
      );
      `);
      const now = Date.now();
      const insertTarget = database.prepare(`
      INSERT INTO execution_targets (
        id, code, name, type, enabled, capabilities_json, health_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertTarget.run('container-local', 'container-local', 'Contentor local', 'container', 1, '{}', 'unknown', now, now);
      insertTarget.run('ubuntu-local', 'ubuntu-local', 'Executor Ubuntu', 'local_agent', 1, '{}', 'unavailable', now, now);
      insertTarget.run('native-local', 'native-local', 'Executor nativo', 'native_local', 1, '{}', 'unknown', now, now);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration, now);
    });
    apply.immediate();
  }

  const nativeMigration = '0002_native_local_target';
  if (!database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(nativeMigration)) {
    const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_targets'").get()?.sql || '';
    if (!definition.includes('native_local')) {
      database.pragma('foreign_keys = OFF');
      try {
        database.transaction(() => {
          database.exec(`
            CREATE TABLE execution_targets_v2 (
              id TEXT PRIMARY KEY,
              code TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL,
              type TEXT NOT NULL CHECK(type IN ('container','local_agent','native_local')),
              enabled INTEGER NOT NULL DEFAULT 1,
              capabilities_json TEXT NOT NULL DEFAULT '{}',
              health_status TEXT NOT NULL DEFAULT 'unknown',
              agent_version TEXT,
              last_seen_at INTEGER,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            INSERT INTO execution_targets_v2 SELECT * FROM execution_targets;
            DROP TABLE execution_targets;
            ALTER TABLE execution_targets_v2 RENAME TO execution_targets;
          `);
        }).immediate();
      } finally {
        database.pragma('foreign_keys = ON');
      }
    }
    const now = Date.now();
    database.transaction(() => {
      database.prepare(`
        INSERT OR IGNORE INTO execution_targets (
          id, code, name, type, enabled, capabilities_json, health_status, created_at, updated_at
        ) VALUES ('native-local', 'native-local', 'Executor nativo', 'native_local', 1, '{}', 'unknown', ?, ?)
      `).run(now, now);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(nativeMigration, now);
    }).immediate();
    if (database.pragma('foreign_key_check').length) throw new Error('Execution target migration violated foreign keys');
  }

  const usersMigration = '0003_sqlite_users';
  if (!database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(usersMigration)) {
    const now = Date.now();
    database.transaction(() => {
      database.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL CHECK(substr(password_hash, 1, 7) = 'scrypt:'),
          role TEXT NOT NULL CHECK(role IN ('viewer','executor','operator','admin')),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
          revision INTEGER NOT NULL DEFAULT 1,
          created_by TEXT,
          updated_by TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_login_at INTEGER
        );
        CREATE INDEX idx_users_active_role ON users(is_active, role);
      `);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(usersMigration, now);
    }).immediate();
  }

  const runParametersMigration = '0004_execution_run_parameters';
  if (!database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(runParametersMigration)) {
    database.transaction(() => {
      if (!database.pragma('table_info(executions)').some((column) => column.name === 'run_parameters')) {
        database.exec('ALTER TABLE executions ADD COLUMN run_parameters TEXT');
      }
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(runParametersMigration, Date.now());
    }).immediate();
  }
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

function createDatabaseFile(fileName, documents, catalog = null, userRecords = null) {
  fs.rmSync(fileName, { force: true });
  const database = new Database(fileName);
  try {
    initialise(database);
    insertDocuments(database, documents);
    if (catalog) insertExecutionCatalog(database, catalog);
    if (userRecords !== null) insertUserRecords(database, userRecords);
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

function readExecutionCatalogFromFile(fileName) {
  if (!isSqliteFile(fileName)) return { targets: [], environments: [], validations: [] };
  const database = new Database(fileName, { readonly: true, fileMustExist: true });
  try {
    const hasCatalog = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_environments'").get();
    if (!hasCatalog) return { targets: [], environments: [], validations: [] };
    return {
      targets: database.prepare('SELECT * FROM execution_targets ORDER BY id').all(),
      environments: database.prepare('SELECT * FROM execution_environments ORDER BY id').all(),
      validations: database.prepare('SELECT * FROM environment_validation_history ORDER BY id').all(),
    };
  } finally {
    database.close();
  }
}

function readUsersFromFile(fileName) {
  if (!isSqliteFile(fileName)) return null;
  const database = new Database(fileName, { readonly: true, fileMustExist: true });
  try {
    const hasUsers = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    if (!hasUsers) return null;
    return database.prepare(`
      SELECT id, username, password_hash, role, is_active, revision, created_by, updated_by,
             created_at, updated_at, last_login_at
      FROM users ORDER BY username COLLATE NOCASE
    `).all();
  } finally {
    database.close();
  }
}

function validateUserRecords(records) {
  if (!Array.isArray(records)) throw new Error('Imported user records are invalid');
  const ids = new Set();
  const usernames = new Set();
  for (const user of records) {
    if (!user || !/^[0-9a-f-]{36}$/i.test(user.id || '')
      || typeof user.username !== 'string' || user.username !== user.username.trim().toLowerCase()
      || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(user.username)
      || typeof user.password_hash !== 'string' || !require('../config/passwords').isValidDigestFormat(user.password_hash)
      || !['viewer', 'executor', 'operator', 'admin'].includes(user.role)
      || ![0, 1].includes(user.is_active)
      || !Number.isSafeInteger(user.revision) || user.revision < 1
      || !Number.isSafeInteger(user.created_at) || !Number.isSafeInteger(user.updated_at)
      || (user.last_login_at !== null && !Number.isSafeInteger(user.last_login_at))) {
      throw new Error('Imported user record is invalid');
    }
    if (ids.has(user.id) || usernames.has(user.username)) throw new Error('Imported user record is duplicated');
    ids.add(user.id);
    usernames.add(user.username);
  }
  if (records.length && !records.some((user) => user.role === 'admin' && user.is_active === 1)) {
    throw new Error('Imported user records must contain an active administrator');
  }
  return records;
}

function insertUserRecords(database, records) {
  const insert = database.prepare(`
    INSERT INTO users (
      id, username, password_hash, role, is_active, revision, created_by, updated_by,
      created_at, updated_at, last_login_at
    ) VALUES (
      @id, @username, @password_hash, @role, @is_active, @revision, @created_by, @updated_by,
      @created_at, @updated_at, @last_login_at
    )
  `);
  for (const user of records) insert.run(user);
}

function insertExecutionCatalog(database, catalog) {
  const allowedTargets = new Set(['container-local', 'native-local', 'ubuntu-local']);
  const upsertTarget = database.prepare(`
    INSERT INTO execution_targets (
      id, code, name, type, enabled, capabilities_json, health_status, agent_version, last_seen_at, created_at, updated_at
    ) VALUES (
      @id, @code, @name, @type, @enabled, @capabilities_json, @health_status, @agent_version, @last_seen_at, @created_at, @updated_at
    ) ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name, type=excluded.type,
      enabled=excluded.enabled, capabilities_json=excluded.capabilities_json, health_status=excluded.health_status,
      agent_version=excluded.agent_version, last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at
  `);
  for (const target of catalog.targets || []) {
    if (!allowedTargets.has(target.id)) throw new Error('Imported execution target is not supported');
    upsertTarget.run(target);
  }

  const insertEnvironment = database.prepare(`
    INSERT INTO execution_environments (
      id, code, name, runtime_type, target_id, executable_path, default_working_directory, description,
      enabled, validation_status, runtime_version, validated_at, revision, created_by, updated_by, created_at, updated_at
    ) VALUES (
      @id, @code, @name, @runtime_type, @target_id, @executable_path, @default_working_directory, @description,
      @enabled, @validation_status, @runtime_version, @validated_at, @revision, @created_by, @updated_by, @created_at, @updated_at
    )
  `);
  for (const environment of catalog.environments || []) insertEnvironment.run(environment);

  const insertValidation = database.prepare(`
    INSERT INTO environment_validation_history (
      id, environment_id, actor, status, message, runtime_version, validated_at
    ) VALUES (@id, @environment_id, @actor, @status, @message, @runtime_version, @validated_at)
  `);
  for (const validation of catalog.validations || []) insertValidation.run(validation);
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
    // Create the file owner-only: SQLite would otherwise use the process umask (typically 0644).
    if (!fs.existsSync(this.filename)) fs.closeSync(fs.openSync(this.filename, 'a', 0o600));
    this.database = new Database(this.filename);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(this.filename, 0o600); } catch (_error) { /* not the owner; start-up validation reports it */ }
    }
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

  listExecutionTargets() {
    return this.database.prepare(`
      SELECT id, code, name, type, enabled, capabilities_json, health_status, agent_version, last_seen_at
      FROM execution_targets ORDER BY name COLLATE NOCASE
    `).all().map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      enabled: row.enabled === 1,
      capabilities: JSON.parse(row.capabilities_json),
      healthStatus: row.health_status,
      agentVersion: row.agent_version,
      lastSeenAt: row.last_seen_at,
    }));
  }

  updateExecutionTargetHealth(id, healthStatus, agentVersion = null, lastSeenAt = Date.now()) {
    const updatedAt = Date.now();
    return this.database.prepare(`
      UPDATE execution_targets SET health_status = ?, agent_version = ?, last_seen_at = ?, updated_at = ?
      WHERE id = ?
    `).run(healthStatus, agentVersion, lastSeenAt, updatedAt, id).changes > 0;
  }

  listExecutionEnvironments(filters = {}) {
    const clauses = [];
    const values = [];
    if (filters.targetId) { clauses.push('e.target_id = ?'); values.push(filters.targetId); }
    if (filters.runtimeType) { clauses.push('e.runtime_type = ?'); values.push(filters.runtimeType); }
    if (filters.enabled !== undefined) { clauses.push('e.enabled = ?'); values.push(filters.enabled ? 1 : 0); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.database.prepare(`
      SELECT e.*, t.code AS target_code, t.name AS target_name, t.type AS target_type,
             t.health_status AS target_health_status
      FROM execution_environments e JOIN execution_targets t ON t.id = e.target_id
      ${where} ORDER BY e.name COLLATE NOCASE LIMIT ? OFFSET ?
    `).all(...values, filters.limit || 100, filters.offset || 0).map(mapExecutionEnvironment);
  }

  countExecutionEnvironments(filters = {}) {
    const clauses = [];
    const values = [];
    if (filters.targetId) { clauses.push('target_id = ?'); values.push(filters.targetId); }
    if (filters.runtimeType) { clauses.push('runtime_type = ?'); values.push(filters.runtimeType); }
    if (filters.enabled !== undefined) { clauses.push('enabled = ?'); values.push(filters.enabled ? 1 : 0); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.database.prepare(`SELECT COUNT(*) AS count FROM execution_environments ${where}`).get(...values).count;
  }

  getExecutionCatalog() {
    return {
      targets: this.database.prepare('SELECT * FROM execution_targets ORDER BY id').all(),
      environments: this.database.prepare('SELECT * FROM execution_environments ORDER BY id').all(),
      validations: this.database.prepare('SELECT * FROM environment_validation_history ORDER BY id').all(),
    };
  }

  getExecutionEnvironment(id) {
    const row = this.database.prepare(`
      SELECT e.*, t.code AS target_code, t.name AS target_name, t.type AS target_type,
             t.health_status AS target_health_status
      FROM execution_environments e JOIN execution_targets t ON t.id = e.target_id
      WHERE e.id = ?
    `).get(id);
    return row ? mapExecutionEnvironment(row) : null;
  }

  createExecutionEnvironment(environment) {
    this.database.prepare(`
      INSERT INTO execution_environments (
        id, code, name, runtime_type, target_id, executable_path, default_working_directory,
        description, enabled, validation_status, revision, created_by, updated_by, created_at, updated_at
      ) VALUES (
        @id, @code, @name, @runtimeType, @targetId, @executablePath, @defaultWorkingDirectory,
        @description, @enabled, 'pending', 1, @actor, @actor, @now, @now
      )
    `).run({
      ...environment,
      defaultWorkingDirectory: environment.defaultWorkingDirectory || null,
      description: environment.description || null,
      enabled: environment.enabled ? 1 : 0,
    });
    return this.getExecutionEnvironment(environment.id);
  }

  updateExecutionEnvironment(id, revision, changes, actor) {
    const runtimeChanged = ['runtimeType', 'targetId', 'executablePath', 'defaultWorkingDirectory']
      .some((key) => Object.hasOwn(changes, key));
    const assignments = [];
    const values = [];
    const fields = {
      name: 'name', runtimeType: 'runtime_type', targetId: 'target_id', executablePath: 'executable_path',
      defaultWorkingDirectory: 'default_working_directory', description: 'description', enabled: 'enabled',
    };
    for (const [key, column] of Object.entries(fields)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(key === 'enabled' ? (changes[key] ? 1 : 0) : (changes[key] || null));
    }
    if (runtimeChanged) assignments.push("validation_status = 'pending', validated_at = NULL, runtime_version = NULL");
    assignments.push('revision = revision + 1', 'updated_by = ?', 'updated_at = ?');
    values.push(actor, Date.now(), id, revision);
    const result = this.database.prepare(`
      UPDATE execution_environments SET ${assignments.join(', ')} WHERE id = ? AND revision = ?
    `).run(...values);
    return result.changes ? this.getExecutionEnvironment(id) : null;
  }

  setExecutionEnvironmentEnabled(id, enabled, actor, revision) {
    const result = this.database.prepare(`
      UPDATE execution_environments SET enabled = ?, revision = revision + 1,
        updated_by = ?, updated_at = ? WHERE id = ? AND revision = ?
    `).run(enabled ? 1 : 0, actor, Date.now(), id, revision);
    return result.changes ? this.getExecutionEnvironment(id) : null;
  }

  addEnvironmentValidation(environmentId, validation) {
    const update = this.database.transaction(() => {
      const now = validation.validatedAt || Date.now();
      this.database.prepare(`
        UPDATE execution_environments SET validation_status = ?, runtime_version = ?, validated_at = ?,
          updated_at = ? WHERE id = ?
      `).run(validation.status, validation.runtimeVersion || null, now, now, environmentId);
      this.database.prepare(`
        INSERT INTO environment_validation_history (
          id, environment_id, actor, status, message, runtime_version, validated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), environmentId, validation.actor, validation.status,
        validation.message || null, validation.runtimeVersion || null, now);
    });
    update.immediate();
  }

  listEnvironmentValidations(environmentId, limit = 50) {
    return this.database.prepare(`
      SELECT id, actor, status, message, runtime_version, validated_at
      FROM environment_validation_history WHERE environment_id = ?
      ORDER BY validated_at DESC LIMIT ?
    `).all(environmentId, limit).map((row) => ({
      id: row.id,
      actor: row.actor,
      status: row.status,
      message: row.message,
      runtimeVersion: row.runtime_version,
      validatedAt: row.validated_at,
    }));
  }

  listUsers() {
    return this.database.prepare(`
      SELECT id, username, role, is_active, revision, created_by, updated_by, created_at, updated_at, last_login_at
      FROM users ORDER BY username COLLATE NOCASE
    `).all().map(mapUser);
  }

  getUser(id) {
    const row = this.database.prepare(`
      SELECT id, username, role, is_active, revision, created_by, updated_by, created_at, updated_at, last_login_at
      FROM users WHERE id = ?
    `).get(id);
    return row ? mapUser(row) : null;
  }

  getUserByUsername(username) {
    const row = this.database.prepare(`
      SELECT id, username, role, is_active, revision, created_by, created_at, updated_at, last_login_at
      FROM users WHERE username = ? COLLATE NOCASE
    `).get(username);
    return row ? mapUser(row) : null;
  }

  getUserAuthentication(username) {
    const row = this.database.prepare(`
      SELECT id, username, password_hash, role, is_active, revision, created_by, updated_by, created_at, updated_at, last_login_at
      FROM users WHERE username = ? COLLATE NOCASE
    `).get(username);
    return row ? {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
      active: row.is_active === 1,
      revision: row.revision,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLoginAt: row.last_login_at,
    } : null;
  }

  countActiveAdministrators() {
    return this.database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1").get().count;
  }

  createUser(user) {
    this.database.prepare(`
      INSERT INTO users (id, username, password_hash, role, is_active, revision, created_by, updated_by, created_at, updated_at)
      VALUES (@id, @username, @passwordHash, @role, @active, 1, @actor, @actor, @now, @now)
    `).run({ ...user, active: user.active ? 1 : 0 });
    return this.getUser(user.id);
  }

  updateUser(id, revision, changes, actor = null) {
    const update = this.database.transaction(() => {
      const current = this.database.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!current || current.revision !== revision) return null;
      const nextRole = Object.hasOwn(changes, 'role') ? changes.role : current.role;
      const nextActive = Object.hasOwn(changes, 'active') ? (changes.active ? 1 : 0) : current.is_active;
      const removesLastAdmin = current.role === 'admin' && current.is_active === 1
        && (nextRole !== 'admin' || nextActive !== 1);
      if (removesLastAdmin && this.countActiveAdministrators() <= 1) {
        throw Object.assign(new Error('The last active administrator cannot be removed or demoted'), {
          statusCode: 409, code: 'LAST_ADMIN_REQUIRED',
        });
      }

      const nextPasswordHash = changes.passwordHash || current.password_hash;
      const passwordChanged = nextPasswordHash !== current.password_hash;
      const accessChanged = nextRole !== current.role || nextActive !== current.is_active;
      const now = Date.now();
      const result = this.database.prepare(`
        UPDATE users SET password_hash = ?, role = ?, is_active = ?, updated_by = ?, revision = revision + 1,
          updated_at = ? WHERE id = ? AND revision = ?
      `).run(nextPasswordHash, nextRole, nextActive, actor, now, id, revision);
      if (!result.changes) return null;
      if (passwordChanged || accessChanged) {
        this.database.prepare('UPDATE sessions SET revoked_at = ? WHERE user = ? AND revoked_at IS NULL')
          .run(now, current.username);
      }
      return this.getUser(id);
    });
    return update.immediate();
  }

  recordUserLogin(id, at = Date.now()) {
    this.database.prepare('UPDATE users SET last_login_at = ? WHERE id = ? AND is_active = 1').run(at, id);
  }

  createAuthenticatedUserSession(userId, session) {
    const create = this.database.transaction(() => {
      const active = this.database.prepare('SELECT username FROM users WHERE id = ? AND is_active = 1').get(userId);
      if (!active) return false;
      this.createSession(session);
      this.database.prepare('UPDATE users SET last_login_at = ? WHERE id = ? AND is_active = 1')
        .run(session.issuedAt, userId);
      return true;
    });
    return create.immediate();
  }

  importUsers(users) {
    const importRows = this.database.transaction((rows) => {
      for (const user of rows) {
        if (this.database.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(user.username)) {
          throw Object.assign(new Error(`User already exists: ${user.username}`), { statusCode: 409, code: 'USER_IMPORT_CONFLICT' });
        }
        this.database.prepare(`
          INSERT INTO users (id, username, password_hash, role, is_active, revision, created_by, updated_by, created_at, updated_at)
          VALUES (@id, @username, @passwordHash, @role, 1, 1, 'environment-migration', 'environment-migration', @now, @now)
        `).run(user);
      }
      if (!this.countActiveAdministrators()) {
        throw Object.assign(new Error('At least one active administrator is required'), { statusCode: 422, code: 'ACTIVE_ADMIN_REQUIRED' });
      }
    });
    importRows.immediate(users);
  }

  recoverAdministrator({ id, username, passwordHash, actor = 'cli-recovery', now = Date.now() }) {
    const recover = this.database.transaction(() => {
      const existing = this.database.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
      if (existing) {
        this.database.prepare(`
          UPDATE users SET password_hash = ?, role = 'admin', is_active = 1, updated_by = ?,
            revision = revision + 1, updated_at = ? WHERE id = ?
        `).run(passwordHash, actor, now, existing.id);
        this.database.prepare('UPDATE sessions SET revoked_at = ? WHERE user = ? AND revoked_at IS NULL')
          .run(now, username);
        return this.getUser(existing.id);
      }
      this.database.prepare(`
        INSERT INTO users (id, username, password_hash, role, is_active, revision, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, 'admin', 1, 1, ?, ?, ?, ?)
      `).run(id, username, passwordHash, actor, actor, now, now);
      return this.getUser(id);
    });
    return recover.immediate();
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
    // A snapshot that cannot be read back is worse than none: reject it before it is published.
    const copy = new Database(fileName, { readonly: true });
    try {
      const result = copy.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new Error(`Backup failed the integrity check: ${result}`);
    } finally {
      copy.close();
    }
  }

  replaceDocuments(documents, catalog = null, userRecords = undefined) {
    const values = documents.map((document) => normaliseDocument(document));
    const replace = this.database.transaction((items) => {
      const clear = this.database.prepare('DELETE FROM jobs');
      const insert = this.database.prepare('INSERT INTO jobs (id, document, created_at) VALUES (?, ?, ?)');
      clear.run();
      for (const document of items) {
        insert.run(document._id, JSON.stringify(document), Number.isFinite(document.created) ? document.created : 0);
      }
      if (catalog) {
        this.database.exec('DELETE FROM environment_validation_history; DELETE FROM execution_environments;');
        this.database.prepare(`
          UPDATE execution_targets SET enabled=1, capabilities_json='{}', health_status=CASE id
            WHEN 'ubuntu-local' THEN 'unavailable' ELSE 'unknown' END, agent_version=NULL, last_seen_at=NULL, updated_at=?
        `).run(Date.now());
        insertExecutionCatalog(this.database, catalog);
      }
      if (userRecords !== undefined) {
        this.database.exec('DELETE FROM sessions; DELETE FROM users;');
        const insertUser = this.database.prepare(`
          INSERT INTO users (
            id, username, password_hash, role, is_active, revision, created_by, updated_by,
            created_at, updated_at, last_login_at
          ) VALUES (
            @id, @username, @password_hash, @role, @is_active, @revision, @created_by, @updated_by,
            @created_at, @updated_at, @last_login_at
          )
        `);
        userRecords.forEach((user) => insertUser.run(user));
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
    // Se a base de dados já foi fechada (por exemplo, durante encerramento do serviço),
    // não é possível persistir o estado da execução manual. Ignora silenciosamente em
    // vez de lançar um TypeError não tratado que poderia interromper o callback do
    // processo filho.
    if (!this.database) return;
    // Só uma execução ainda activa pode concluir: um segundo evento de conclusão (ou uma conclusão
    // tardia após recuperação por reinício) é ignorado de forma atómica e idempotente.
    if (!isValidTransition(EXECUTION_STATES.RUNNING, status)) return false;
    return this.database.prepare(`
      UPDATE manual_runs SET status = ?, completed_at = ?, result = ?
      WHERE operation_id = ? AND status = 'running'
    `).run(status, completedAt, JSON.stringify(result), operationId).changes > 0;
  }

  findActiveManualRun(jobId) {
    const row = this.database.prepare(`
      SELECT operation_id FROM manual_runs WHERE job_id = ? AND status = 'running' LIMIT 1
    `).get(jobId);
    return row ? row.operation_id : null;
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
        duration_ms, termination_reason, output_exceeded, started_at, completed_at, runtime_metadata, run_parameters
      ) VALUES (
        @operationId, @jobId, @trigger, @actor, @status, @exitCode, @signal,
        @durationMs, @terminationReason, @outputExceeded, @startedAt, @completedAt, @runtimeMetadata, @runParameters
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
      runtimeMetadata: execution.runtime ? JSON.stringify(execution.runtime) : null,
      runParameters: execution.runParameters ? JSON.stringify(execution.runParameters) : null,
    });
  }

  listExecutions(jobId, limit) {
    return this.database.prepare(`
      SELECT operation_id, job_id, trigger, actor, status, exit_code, signal,
              duration_ms, termination_reason, output_exceeded, started_at, completed_at, runtime_metadata, run_parameters
      FROM executions
      WHERE job_id = ?
      ORDER BY completed_at DESC
      LIMIT ?
    `).all(jobId, limit).map(mapExecution);
  }

  listLatestExecutions() {
    return this.database.prepare(`
      WITH ranked_executions AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY job_id ORDER BY completed_at DESC, id DESC
        ) AS position
        FROM executions
      )
      SELECT * FROM ranked_executions WHERE position = 1
    `).all().map(mapExecution);
  }

  countConsecutiveFailures(jobId) {
    const latest = this.database.prepare(`
      SELECT status FROM executions WHERE job_id = ? ORDER BY completed_at DESC, id DESC LIMIT 1
    `).get(jobId);
    if (!latest || latest.status === 'completed') return 0;
    return this.database.prepare(`
      SELECT COUNT(*) AS total FROM executions
      WHERE job_id = ? AND id > COALESCE((
        SELECT MAX(id) FROM executions WHERE job_id = ? AND status = 'completed'
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
    runtime: row.runtime_metadata ? JSON.parse(row.runtime_metadata) : null,
    runParameters: row.run_parameters ? JSON.parse(row.run_parameters) : null,
  };
}

function mapExecutionEnvironment(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    runtimeType: row.runtime_type,
    targetId: row.target_id,
    target: {
      code: row.target_code,
      name: row.target_name,
      type: row.target_type,
      healthStatus: row.target_health_status,
    },
    executablePath: row.executable_path,
    defaultWorkingDirectory: row.default_working_directory,
    description: row.description,
    enabled: row.enabled === 1,
    validationStatus: row.validation_status,
    runtimeVersion: row.runtime_version,
    validatedAt: row.validated_at,
    revision: row.revision,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    active: row.is_active === 1,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

module.exports = {
  SqliteDatastore,
  createDatabaseFile,
  isSqliteFile,
  readExecutionCatalogFromFile,
  readJobsFromFile,
  readUsersFromFile,
  validateUserRecords,
};
