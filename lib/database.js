'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000');

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
            const documents = readDocuments(datastore.database).filter((document) => datastore.matches(document, query));
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
        const documents = readDocuments(this.database).filter((document) => this.matches(document, query));
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
        const ids = readDocuments(this.database).filter((document) => this.matches(document, query)).map((document) => document._id);
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
}

module.exports = {
  SqliteDatastore,
  createDatabaseFile,
  isSqliteFile,
  readJobsFromFile,
};
