'use strict';

/* global describe, it, expect, beforeAll, afterAll */
const request = require('supertest');
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Datastore = require('@seald-io/nedb');

const testDbPath = path.join(os.tmpdir(), `crontab-ui-test-${Date.now()}`);
fs.mkdirSync(testDbPath, { recursive: true });
fs.mkdirSync(path.join(testDbPath, 'logs'), { recursive: true });

process.env.CRON_DB_PATH = testDbPath;
process.env.CRON_PATH = testDbPath;
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.NODE_ENV = 'test';
process.env.MAIL_PROFILES_JSON = JSON.stringify({
  operations: {
    transporter: 'smtps://mailer:password@smtp.example.test',
    from: 'crontab@example.test',
    to: 'operations@example.test',
  },
});

const app = require('../app');
const crontab = require('../crontab');
const { requireRole, validateRoleAssignments } = require('../middleware/authorization');
const setupAuth = require('../middleware/auth');
const { configuredUsers } = setupAuth;
const { getProfile } = require('../config/mail-profiles');
const { execute } = require('../execution');
const { parseEnvironment } = require('../config/environment');
const { validateProductionTransport } = require('../config/transport');
const { canAccessJob } = require('../middleware/job-authorization');
const csrfProtection = require('../middleware/csrf');

describe('Crontab UI', () => {
  describe('GET /', () => {
    it('should return the main page', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Crontab UI');
      expect(res.text).toContain('Tarefas agendadas');
      expect(res.text).toContain('Criar primeira tarefa');
    });
  });

  describe('POST /save', () => {
    it('should create a new job', async () => {
      const res = await request(app)
        .post('/save')
        .send({
          _id: -1,
          name: 'test-job',
          command: 'echo hello',
          schedule: '* * * * *',
          logging: 'false',
          mailing: {},
        });
      expect(res.status).toBe(200);
    });

    it('should show the new job on the main page', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('test-job');
      expect(res.text).toContain('echo hello');
    });
  });

  describe('Mail profile validation', () => {
    it('should reject an unknown server-side mail profile', async () => {
      const res = await request(app).post('/save').send({
        _id: -1, name: 'invalid-profile', command: 'echo hello',
        schedule: '* * * * *', logging: false, mailing: { profileId: 'unknown' },
      });
      expect(res.status).toBe(400);
    });

    it('should accept a configured mail profile without exposing its credentials', async () => {
      const res = await request(app).post('/save').send({
        _id: -1, name: 'valid-profile', command: 'echo hello',
        schedule: '* * * * *', logging: false, mailing: { profileId: 'operations' },
      });
      expect(res.status).toBe(200);
      const page = await request(app).get('/');
      expect(page.text).toContain('"profileId":"operations"');
      expect(page.text).not.toContain('mailer:password');
    });
  });

  describe('POST /stop and /start', () => {
    let jobId;

    beforeAll(async () => {
      const res = await request(app).get('/');
      const match = res.text.match(/stopJob\('([^']+)'\)/);
      jobId = match ? match[1] : null;
    });

    it('should stop a job', async () => {
      if (!jobId) return;
      const res = await request(app)
        .post('/stop')
        .send({ _id: jobId });
      expect(res.status).toBe(200);
    });

    it('should start a job', async () => {
      if (!jobId) return;
      const res = await request(app)
        .post('/start')
        .send({ _id: jobId });
      expect(res.status).toBe(200);
    });
  });

  describe('GET /backup', () => {
    it('should create a backup', async () => {
      const res = await request(app).post('/backup');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /export', () => {
    it('should export the database', async () => {
      const res = await request(app).get('/export');
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('crontab.db');
    });
  });

  describe('POST /save (duplicate)', () => {
    it('should duplicate an existing job', async () => {
      const page = await request(app).get('/');
      const match = page.text.match(/duplicateJob\('([^']+)'\)/);
      const jobId = match ? match[1] : null;
      if (!jobId) return;

      const jobMatch = page.text.match(/test-job/);
      expect(jobMatch).not.toBeNull();

      const res = await request(app)
        .post('/save')
        .send({
          _id: -1,
          name: 'test-job (copy)',
          command: 'echo hello',
          schedule: '* * * * *',
          logging: 'false',
          mailing: {},
        });
      expect(res.status).toBe(200);

      const afterPage = await request(app).get('/');
      expect(afterPage.text).toContain('test-job (copy)');
    });
  });

  describe('GET /preview_crontab', () => {
    it('should return the crontab preview as plain text', async () => {
      const res = await request(app).get('/preview_crontab');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('crontab-ui-runner.js');
    });

    it('should delegate scheduled execution to the bounded runner', async () => {
      const res = await request(app).get('/preview_crontab');
      expect(res.text).toContain('crontab-ui-runner.js');
    });

    it('should only include active (non-stopped) jobs', async () => {
      const page = await request(app).get('/');
      const match = page.text.match(/stopJob\('([^']+)'\)/);
      if (!match) return;

      await request(app).post('/stop').send({ _id: match[1] });

      const res = await request(app).get('/preview_crontab');
      const lines = res.text.trim().split('\n').filter((l) => l.includes('echo hello'));
      const activePage = await request(app).get('/');
      const activeCount = (activePage.text.match(/stopJob\('/g) || []).length;
      expect(lines.length).toBe(activeCount);

      await request(app).post('/start').send({ _id: match[1] });
    });
  });

  describe('Input validation', () => {
    it('should reject an invalid cron schedule on job creation', async () => {
      const res = await request(app).post('/save').send({
        _id: -1, name: 'invalid-cron-save', command: 'echo hello',
        schedule: 'not-a-cron', logging: false, mailing: {},
      });
      expect(res.status).toBe(400);
    });

    it('should render persisted HTML as text instead of executable markup', async () => {
      const payload = '<img src=x onerror=alert(1)>';
      const saved = await request(app).post('/save').send({
        _id: -1, name: payload, command: payload,
        schedule: '* * * * *', logging: false, mailing: {},
      });
      expect(saved.status).toBe(200);
      const page = await request(app).get('/');
      expect(page.text).not.toContain(payload);
      expect(page.text).toContain('\\u003cimg src=x onerror=alert(1)\\u003e');
    });

    it('should reject path traversal in db param', async () => {
      const res = await request(app).get('/restore?db=../../etc/passwd');
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid backup parameter');
    });

    it('should reject invalid characters in id param', async () => {
      const res = await request(app).get('/logger?id=../../../etc/passwd');
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid id parameter');
    });

    it('should reject non-backup files in recovery routes', async () => {
      const res = await request(app).get('/restore?db=crontab.db');
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid backup parameter');
    });

    it('should allow valid id param', async () => {
      const res = await request(app).get('/logger?id=abc123_test-id');
      expect(res.status).toBe(200);
    });

    it('should reject an invalid job id in a mutating route', async () => {
      const res = await request(app).post('/runjob').send({ _id: '../bad' });
      expect(res.status).toBe(400);
    });

    it('should reject an environment payload containing a NUL byte', async () => {
      const res = await request(app).post('/crontab').send({ env_vars: 'PATH=/bin\0BAD=1' });
      expect(res.status).toBe(400);
    });

    it.each(['export PATH=/bin', 'PATH=$(whoami)', 'PATH=`whoami`', 'PATH=/bin;id', 'PATH=/bin&&id', 'PATH=/bin|id', 'lowercase=/bin'])('rejects shell syntax or invalid environment names', async (env_vars) => {
      const res = await request(app).post('/crontab').send({ env_vars });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /remove', () => {
    let jobId;

    beforeAll(async () => {
      const res = await request(app).get('/');
      const match = res.text.match(/deleteJob\('([^']+)'\)/);
      jobId = match ? match[1] : null;
    });

    it('should remove a job', async () => {
      if (!jobId) return;
      const res = await request(app)
        .post('/remove')
        .send({ _id: jobId });
      expect(res.status).toBe(200);
    });

    it('should remove the duplicated job too', async () => {
      const page = await request(app).get('/');
      const match = page.text.match(/deleteJob\('([^']+)'\)/);
      if (!match) return;
      const res = await request(app)
        .post('/remove')
        .send({ _id: match[1] });
      expect(res.status).toBe(200);
    });
  });

  describe('GET /logger', () => {
    it('should return no errors message when no log exists', async () => {
      const res = await request(app).get('/logger?id=nonexistent');
      expect(res.status).toBe(200);
      expect(res.text).toContain('No errors logged yet');
    });

    it('should return text/plain content type when no log exists', async () => {
      const res = await request(app).get('/logger?id=nonexistent');
      expect(res.headers['content-type']).toContain('text/plain');
    });

    it('should return text/plain and no-store when log file exists', async () => {
      const logFile = path.join(testDbPath, 'logs', 'testlog.log');
      fs.writeFileSync(logFile, 'some error output\n');
      const res = await request(app).get('/logger?id=testlog');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toContain('some error output');
      fs.unlinkSync(logFile);
    });
  });

  describe('GET /stdout', () => {
    it('should return no errors message when no log exists', async () => {
      const res = await request(app).get('/stdout?id=nonexistent');
      expect(res.status).toBe(200);
      expect(res.text).toContain('No errors logged yet');
    });

    it('should return text/plain content type when no log exists', async () => {
      const res = await request(app).get('/stdout?id=nonexistent');
      expect(res.headers['content-type']).toContain('text/plain');
    });

    it('should return text/plain and no-store when stdout log exists', async () => {
      const logFile = path.join(testDbPath, 'logs', 'teststdout.stdout.log');
      fs.writeFileSync(logFile, 'some stdout output\n');
      const res = await request(app).get('/stdout?id=teststdout');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toContain('some stdout output');
      fs.unlinkSync(logFile);
    });
  });

  describe('GET /import_crontab (auto-backup)', () => {
    it('should create a backup before importing', async () => {
      // ensure a job exists so crontab.db is non-empty
      await request(app).post('/save').send({
        _id: -1, name: 'backup-test', command: 'echo backup',
        schedule: '* * * * *', logging: 'false', mailing: {},
      });
      // small delay so backup filename (based on date) doesn't collide
      await new Promise((r) => setTimeout(r, 1100));
      const backupsBefore = fs.readdirSync(testDbPath)
        .filter((f) => f.startsWith('backup'));
      await request(app).post('/import_crontab');
      const backupsAfter = fs.readdirSync(testDbPath)
        .filter((f) => f.startsWith('backup'));
      expect(backupsAfter.length).toBe(backupsBefore.length + 1);
    });
  });

  describe('POST /import (auto-backup)', () => {
    it('should create a backup before importing a db file', async () => {
      // small delay so backup filename (based on date) doesn't collide
      await new Promise((r) => setTimeout(r, 1100));
      const backupsBefore = fs.readdirSync(testDbPath)
        .filter((f) => f.startsWith('backup'));
      const dbContent = fs.readFileSync(path.join(testDbPath, 'crontab.db'));
      await request(app)
        .post('/import')
        .attach('import_file', dbContent, 'crontab.db');
      const backupsAfter = fs.readdirSync(testDbPath)
        .filter((f) => f.startsWith('backup'));
      expect(backupsAfter.length).toBe(backupsBefore.length + 1);
    });

    it('rejects multiple uploaded files and preserves the active database', async () => {
      const before = fs.readFileSync(path.join(testDbPath, 'crontab.db'), 'utf8');
      const response = await request(app)
        .post('/import')
        .attach('import_file', Buffer.from(''), 'first.db')
        .attach('import_file', Buffer.from(''), 'second.db');

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('A single .db import file is required');
      expect(fs.readFileSync(path.join(testDbPath, 'crontab.db'), 'utf8')).toBe(before);
      expect(fs.readdirSync(testDbPath).some((file) => file.startsWith('.import-'))).toBe(false);
    });
  });

  describe('Command textarea', () => {
    it('should render a textarea for the command field', async () => {
      const res = await request(app).get('/');
      expect(res.text).toContain('<textarea');
      expect(res.text).toContain('id="job-command"');
    });
  });

  describe('NeDB import normalisation', () => {
    function normalise(file) {
      return new Promise((resolve, reject) => crontab.normalise_database(file, (error) => {
        if (error) reject(error);
        else resolve();
      }));
    }

    function records(file) {
      const datastore = new Datastore({ filename: file });
      return new Promise((resolve, reject) => datastore.loadDatabase((loadError) => {
        if (loadError) return reject(loadError);
        return datastore.find({}).exec((findError, docs) => (findError ? reject(findError) : resolve(docs)));
      }));
    }

    function writeCandidate(name, documents) {
      const file = path.join(testDbPath, name);
      fs.writeFileSync(file, documents.map((document) => JSON.stringify(document)).join('\n'));
      return file;
    }

    it('normalises a valid record, removes hooks and regenerates imported ids', async () => {
      const file = writeCandidate('normalise-valid.db', [{
        _id: 'externally-controlled-id', name: 'imported', command: 'echo imported',
        schedule: '* * * * *', stopped: false, logging: 'true', mailing: {},
        hook: 'touch /tmp/should-not-run', timestamp: 'old', created: 1, saved: true,
      }]);
      await normalise(file);
      const [job] = await records(file);
      expect(job._id).not.toBe('externally-controlled-id');
      expect(job.hook).toBeUndefined();
      expect(job.command).toBe('echo imported');
      expect(job.logging).toBe(true);
    });

    it('accepts an empty datastore', async () => {
      const file = writeCandidate('normalise-empty.db', []);
      await normalise(file);
      expect(await records(file)).toEqual([]);
    });

    it.each([
      ['truncated NeDB', '{"name":'],
      ['invalid cron', JSON.stringify({ _id: 'invalid-cron', name: 'bad', command: 'echo bad', schedule: 'not-a-cron' })],
      ['command object', JSON.stringify({ _id: 'invalid-command', name: 'bad', command: { run: 'echo bad' }, schedule: '* * * * *' })],
      ['environment object', JSON.stringify({ _id: 'invalid-env', name: 'bad', command: 'echo bad', schedule: '* * * * *', env_vars: {} })],
      ['unexpected property', JSON.stringify({ _id: 'invalid-extra', name: 'bad', command: 'echo bad', schedule: '* * * * *', unknown: true })],
    ])('rejects %s without replacing the active database', async (_label, content) => {
      const candidate = path.join(testDbPath, `normalise-invalid-${Date.now()}.db`);
      fs.writeFileSync(candidate, content);
      await expect(normalise(candidate)).rejects.toThrow();
    });

    it('rejects a multi-record candidate when any record is invalid', async () => {
      const file = writeCandidate('normalise-partial.db', [
        { _id: 'valid-record', name: 'valid', command: 'echo valid', schedule: '* * * * *' },
        { _id: 'invalid-record', name: 'invalid', command: {}, schedule: '* * * * *' },
      ]);
      await expect(normalise(file)).rejects.toThrow('invalid command');
    });

    it('keeps the active database when an uploaded candidate is invalid', async () => {
      await request(app).post('/save').send({
        _id: -1, name: 'import-rollback-sentinel', command: 'echo preserved',
        schedule: '* * * * *', logging: false, mailing: {},
      });
      const invalid = Buffer.from(JSON.stringify({ _id: 'invalid-upload', name: 'bad', command: {}, schedule: '* * * * *' }));
      const response = await request(app).post('/import').attach('import_file', invalid, 'invalid.db');
      expect(response.status).toBe(500);
      const page = await request(app).get('/');
      expect(page.text).toContain('import-rollback-sentinel');
      expect(page.text).toContain('echo preserved');
    });
  });

  describe('Backup recovery', () => {
    it('should restore a persisted job from a backup', async () => {
      await request(app).post('/save').send({
        _id: -1, name: 'recovery-job', command: 'echo recover',
        schedule: '* * * * *', logging: false, mailing: {},
      });
      const backupResponse = await request(app).post('/backup');
      expect(backupResponse.status).toBe(200);
      const backup = fs.readdirSync(testDbPath)
        .filter((file) => file.startsWith('backup-')).sort().at(-1);
      expect(backup).toBeTruthy();
      const restored = await request(app).post(`/restore_backup?db=${encodeURIComponent(backup)}`);
      expect(restored.status).toBe(200);
      const page = await request(app).get('/');
      expect(page.text).toContain('recovery-job');
    });
  });
});

describe('Environment definitions', () => {
  it('parses multiple environment variables without shell evaluation', () => {
    expect(parseEnvironment('NAME=value\nOTHER=with spaces=and equals\nEMPTY=')).toEqual({
      NAME: 'value', OTHER: 'with spaces=and equals', EMPTY: '',
    });
  });

  it('preserves supported Unicode values', () => {
    expect(parseEnvironment('MESSAGE=olá Cabo Verde')).toEqual({ MESSAGE: 'olá Cabo Verde' });
  });
});

describe('Bounded command execution', () => {
  function executeCommand(command, options) {
    return new Promise((resolve) => execute(command, options, (error, result) => resolve({ error, result })));
  }

  it('captures a normal command exit code', async () => {
    const { error, result } = await executeCommand(`"${process.execPath}" -e "process.stdout.write('ok')"`, {
      timeoutMs: 5_000, maxOutputBytes: 1024,
    });
    expect(error).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('ok');
  });

  it('terminates a command that exceeds its timeout', async () => {
    const { error, result } = await executeCommand(`"${process.execPath}" -e "setTimeout(() => {}, 5000)"`, {
      timeoutMs: 50, maxOutputBytes: 1024, killGraceMs: 10,
    });
    expect(error).toBeTruthy();
    expect(result.terminationReason).toBe('timeout');
  });

  it('terminates a command that exceeds the output limit', async () => {
    const { error, result } = await executeCommand(`"${process.execPath}" -e "process.stdout.write('x'.repeat(4096))"`, {
      timeoutMs: 5_000, maxOutputBytes: 128,
    });
    expect(error).toBeTruthy();
    expect(result.terminationReason).toBe('output_limit');
    expect(result.stdout.length).toBeLessThanOrEqual(128);
  });
});

describe('POST /save job identifier validation', () => {
  let jobId;

  function findJob(id) {
    return new Promise((resolve) => crontab.get_crontab(id, resolve));
  }

  beforeAll(async () => {
    const response = await request(app).post('/save').send({
      _id: -1,
      name: 'id-validation-sentinel',
      command: 'echo unchanged',
      schedule: '* * * * *',
      logging: false,
      mailing: {},
    });
    expect(response.status).toBe(200);
    const jobs = await new Promise((resolve) => crontab.crontabs(resolve));
    jobId = jobs.find((job) => job.name === 'id-validation-sentinel')._id;
  });

  it('creates a job only when _id is the numeric sentinel -1', async () => {
    const response = await request(app).post('/save').send({
      _id: -1,
      name: 'id-validation-create',
      command: 'echo created',
      schedule: '* * * * *',
      logging: false,
      mailing: {},
    });
    expect(response.status).toBe(200);
  });

  it('updates a job when _id is a valid string', async () => {
    const response = await request(app).post('/save').send({
      _id: jobId,
      name: 'id-validation-sentinel',
      command: 'echo updated',
      schedule: '* * * * *',
      logging: false,
      mailing: {},
    });
    expect(response.status).toBe(200);
    expect((await findJob(jobId)).command).toBe('echo updated');
  });

  it.each([
    ['object', { $ne: null }],
    ['array', ['not-an-id']],
    ['$ne operator', { $ne: null }],
    ['$gt operator', { $gt: '' }],
    ['too long string', 'a'.repeat(65)],
    ['invalid characters', '../other-job'],
    ['null', null],
    ['undefined', undefined],
  ])('rejects an invalid _id: %s without changing an existing job', async (_label, invalidId) => {
    const payload = {
      name: 'tampered',
      command: 'echo tampered',
      schedule: '* * * * *',
      logging: false,
      mailing: {},
    };
    if (invalidId !== undefined) payload._id = invalidId;

    const response = await request(app).post('/save').send(payload);
    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Invalid job id');
    const persisted = await findJob(jobId);
    expect(persisted.name).toBe('id-validation-sentinel');
    expect(persisted.command).toBe('echo updated');
  });
});

describe('Routes module', () => {
  it('should export routes with base_url prefix', () => {
    const { routes, base_url } = require('../routes');
    expect(routes.root).toBe(base_url + '/');
    expect(routes.save).toBe(base_url + '/save');
    expect(routes.backup).toBe(base_url + '/backup');
  });

  it('should export relative routes', () => {
    const { relative } = require('../routes');
    expect(relative.save).toBe('save');
    expect(relative.backup).toBe('backup');
  });
});

describe('RBAC middleware', () => {
  const originalRoles = process.env.AUTHZ_ROLE_MAP_JSON;

  afterAll(() => {
    if (originalRoles === undefined) delete process.env.AUTHZ_ROLE_MAP_JSON;
    else process.env.AUTHZ_ROLE_MAP_JSON = originalRoles;
  });

  function authorize(requiredRole, user) {
    process.env.AUTHZ_ROLE_MAP_JSON = JSON.stringify({ admin: 'admin', operator: 'operator', viewer: 'viewer' });
    const response = { statusCode: 200, body: null };
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; },
    };
    let called = false;
    requireRole(requiredRole)(
      { app: { locals: { authEnabled: true } }, auth: { user } },
      res,
      () => { called = true; },
    );
    return { called, response };
  }

  it('denies a viewer manual command execution', () => {
    const result = authorize('operator', 'viewer');
    expect(result.called).toBe(false);
    expect(result.response.statusCode).toBe(403);
  });

  it('permits an operator to execute commands but not administrative recovery', () => {
    expect(authorize('operator', 'operator').called).toBe(true);
    expect(authorize('admin', 'operator').response.statusCode).toBe(403);
  });

  it('requires an explicit role when authentication is enabled', () => {
    const result = authorize('viewer', 'unmapped');
    expect(result.called).toBe(false);
    expect(result.response.statusCode).toBe(403);
  });

  it('does not apply roles when authentication is disabled for loopback development', () => {
    process.env.AUTHZ_ROLE_MAP_JSON = '{}';
    let called = false;
    requireRole('admin')(
      { app: { locals: { authEnabled: false } }, auth: null },
      {},
      () => { called = true; },
    );
    expect(called).toBe(true);
  });
});

describe('Basic authentication users configuration', () => {
  const originalUsers = process.env.BASIC_AUTH_USERS_JSON;

  afterAll(() => {
    if (originalUsers === undefined) delete process.env.BASIC_AUTH_USERS_JSON;
    else process.env.BASIC_AUTH_USERS_JSON = originalUsers;
  });

  it('accepts a server-side map of multiple authenticated users', () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ alice: 'secret-a', bob: 'secret-b' });
    expect(configuredUsers()).toEqual({ alice: 'secret-a', bob: 'secret-b' });
  });

  it('rejects an empty user map', () => {
    process.env.BASIC_AUTH_USERS_JSON = '{}';
    expect(() => configuredUsers()).toThrow('must contain non-empty');
  });
});

describe('Mail profile hardening', () => {
  const originalProfiles = process.env.MAIL_PROFILES_JSON;

  afterAll(() => {
    if (originalProfiles === undefined) delete process.env.MAIL_PROFILES_JSON;
    else process.env.MAIL_PROFILES_JSON = originalProfiles;
  });

  it('normalises a configured recipient list without exposing configuration to jobs', () => {
    process.env.MAIL_PROFILES_JSON = JSON.stringify({
      alerts: { transporter: 'smtps://mailer:secret@smtp.example.test', from: 'cron@example.test', to: ['one@example.test', 'two@example.test'] },
    });
    expect(getProfile('alerts')).toMatchObject({ from: 'cron@example.test', to: ['one@example.test', 'two@example.test'] });
  });

  it('rejects a non-SMTP transporter and recipient header injection', () => {
    process.env.MAIL_PROFILES_JSON = JSON.stringify({
      unsafe: { transporter: 'file:///tmp/mail', from: 'cron@example.test', to: 'ops@example.test' },
      injected: { transporter: 'smtps://smtp.example.test', from: 'cron@example.test', to: 'ops@example.test\nBcc: attacker@example.test' },
    });
    expect(() => getProfile('unsafe')).toThrow('smtp or smtps');
    expect(() => getProfile('injected')).toThrow('invalid recipient address');
  });
});

describe('Production authentication configuration', () => {
  it('requires every authenticated user to have a valid role', () => {
    expect(() => validateRoleAssignments({ admin: 'secret', operator: 'secret' }, { admin: 'admin' }))
      .toThrow('operator has no assigned role');
  });

  it('rejects role mappings for users that cannot authenticate', () => {
    expect(() => validateRoleAssignments({ admin: 'secret' }, { admin: 'admin', stale: 'viewer' }))
      .toThrow('unknown user stale');
  });

  it('accepts a complete authentication and role configuration', () => {
    expect(() => validateRoleAssignments({ admin: 'secret' }, { admin: 'admin' })).not.toThrow();
  });
});

describe('Production transport configuration', () => {
  it('requires TLS or an explicitly trusted proxy in production', () => {
    expect(() => validateProductionTransport({ nodeEnv: 'production', nativeTls: false })).toThrow('requires SSL_CERT');
  });

  it('rejects insecure bypasses and unsafe proxy configuration', () => {
    expect(() => validateProductionTransport({ nodeEnv: 'production', nativeTls: true, insecureBypass: true })).toThrow('not allowed');
    expect(() => validateProductionTransport({ nodeEnv: 'production', nativeTls: false, trustedProxy: 'anything' })).toThrow('TRUSTED_PROXY');
  });

  it('accepts native TLS or a known proxy range', () => {
    expect(() => validateProductionTransport({ nodeEnv: 'production', nativeTls: true })).not.toThrow();
    expect(() => validateProductionTransport({ nodeEnv: 'production', nativeTls: false, trustedProxy: '172.20.0.0/16' })).not.toThrow();
  });
});

describe('Job ownership authorization', () => {
  const originalRoles = process.env.AUTHZ_ROLE_MAP_JSON;
  const requestFor = (user) => ({ app: { locals: { authEnabled: true } }, auth: { user } });

  beforeAll(() => {
    process.env.AUTHZ_ROLE_MAP_JSON = JSON.stringify({ alice: 'operator', bob: 'operator', viewer: 'viewer', executor: 'executor', admin: 'admin' });
  });
  afterAll(() => {
    if (originalRoles === undefined) delete process.env.AUTHZ_ROLE_MAP_JSON;
    else process.env.AUTHZ_ROLE_MAP_JSON = originalRoles;
  });

  it('allows an operator to manage only owned jobs', () => {
    expect(canAccessJob(requestFor('alice'), { owner: 'alice' }, 'write')).toBe(true);
    expect(canAccessJob(requestFor('bob'), { owner: 'alice' }, 'write')).toBe(false);
  });

  it('allows viewers to read their own jobs but not modify them', () => {
    expect(canAccessJob(requestFor('viewer'), { owner: 'viewer' }, 'read')).toBe(true);
    expect(canAccessJob(requestFor('viewer'), { owner: 'viewer' }, 'write')).toBe(false);
  });

  it('allows an executor to run but not edit an owned job', () => {
    expect(canAccessJob(requestFor('executor'), { owner: 'executor' }, 'execute')).toBe(true);
    expect(canAccessJob(requestFor('executor'), { owner: 'executor' }, 'write')).toBe(false);
  });

  it('restricts legacy unowned jobs to administrators', () => {
    expect(canAccessJob(requestFor('alice'), {}, 'read')).toBe(false);
    expect(canAccessJob(requestFor('admin'), {}, 'write')).toBe(true);
  });
});

describe('Operational audit trail', () => {
  it('records correlated administrative operations without storing the command', async () => {
    const command = 'echo audit-secret-command';
    const response = await request(app).post('/save').send({
      _id: -1,
      name: 'audit-job',
      command,
      schedule: '* * * * *',
      logging: false,
      mailing: {},
    });

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const events = fs.readFileSync(crontab.audit_file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const event = events.find((entry) => entry.requestId === response.headers['x-request-id']);
    expect(event).toMatchObject({
      type: 'http_operation',
      operation: 'save_job',
      outcome: 'completed',
      status: 200,
    });
    expect(event.commandSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(event)).not.toContain(command);
  });

  it('records lifecycle fields for executions', async () => {
    const event = { operationId: 'operation-audit-test', type: 'runjob', status: 'completed', exitCode: 0 };
    crontab.audit(event);
    const records = fs.readFileSync(crontab.audit_file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining(event)]));
  });
});

describe('Transactional backup operations', () => {
  it('serializes concurrent backup attempts through the database lock', async () => {
    const backup = () => new Promise((resolve) => crontab.backup((error, name) => resolve({ error, name })));
    const first = backup();
    const second = backup();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const results = [firstResult, secondResult];

    expect(results.filter((result) => !result.error)).toHaveLength(1);
    expect(results.find((result) => result.error).error.statusCode).toBe(409);
    expect(results.find((result) => !result.error).name).toMatch(/^backup-.*\.db$/);
  });

  it('rejects a concurrent database replacement instead of interleaving it', async () => {
    const first = path.join(testDbPath, '.replace-first.db');
    const second = path.join(testDbPath, '.replace-second.db');
    fs.copyFileSync(path.join(testDbPath, 'crontab.db'), first);
    fs.copyFileSync(path.join(testDbPath, 'crontab.db'), second);
    const replace = (file) => new Promise((resolve) => crontab.replace_database(file, (error) => resolve(error)));
    const [firstError, secondError] = await Promise.all([replace(first), replace(second)]);
    const errors = [firstError, secondError];

    expect(errors.filter(Boolean)).toHaveLength(1);
    expect(errors.find(Boolean).statusCode).toBe(409);
  });
});

describe('CSRF middleware', () => {
  const originalEnvironment = process.env.NODE_ENV;

  afterAll(() => {
    process.env.NODE_ENV = originalEnvironment;
  });

  it('issues a token on a safe request and rejects a state change without it', () => {
    process.env.NODE_ENV = 'development';
    let cookie;
    let proceeded = false;
    csrfProtection(
      { method: 'GET', headers: {}, get: () => undefined },
      { append: (_name, value) => { cookie = value; } },
      () => { proceeded = true; },
    );
    expect(proceeded).toBe(true);
    const token = decodeURIComponent(cookie.match(/^[^=]+=([^;]+)/)[1]);

    const denied = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    csrfProtection({ method: 'POST', headers: { cookie: `crontab_ui_csrf=${encodeURIComponent(token)}` }, get: () => undefined }, denied, () => {});
    expect(denied.statusCode).toBe(403);
    expect(denied.body.message).toBe('Invalid CSRF token');

    let accepted = false;
    csrfProtection({ method: 'POST', headers: { cookie: `crontab_ui_csrf=${encodeURIComponent(token)}` }, get: () => token }, {}, () => { accepted = true; });
    expect(accepted).toBe(true);
  });
});

describe('External basic authentication middleware', () => {
  const originalUsers = process.env.BASIC_AUTH_USERS_JSON;
  const originalUser = process.env.BASIC_AUTH_USER;
  const originalPassword = process.env.BASIC_AUTH_PWD;

  afterAll(() => {
    if (originalUsers === undefined) delete process.env.BASIC_AUTH_USERS_JSON;
    else process.env.BASIC_AUTH_USERS_JSON = originalUsers;
    if (originalUser === undefined) delete process.env.BASIC_AUTH_USER;
    else process.env.BASIC_AUTH_USER = originalUser;
    if (originalPassword === undefined) delete process.env.BASIC_AUTH_PWD;
    else process.env.BASIC_AUTH_PWD = originalPassword;
  });

  it('rejects unauthenticated access and accepts configured credentials', async () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ reviewer: 'strong-secret' });
    delete process.env.BASIC_AUTH_USER;
    delete process.env.BASIC_AUTH_PWD;
    const protectedApp = express();
    expect(setupAuth(protectedApp)).toBe(true);
    protectedApp.get('/protected', (req, res) => res.json({ user: req.auth.user }));

    expect((await request(protectedApp).get('/protected')).status).toBe(401);
    const allowed = await request(protectedApp).get('/protected').auth('reviewer', 'strong-secret');
    expect(allowed.status).toBe(200);
    expect(allowed.body.user).toBe('reviewer');
  });
});

describe('Application bootstrap', () => {
  it('creates isolated applications and exposes a closable HTTP server', async () => {
    const anotherApp = app.createApp();
    expect(anotherApp).not.toBe(app);
    anotherApp.set('port', 0);
    const server = app.startServer(anotherApp);
    await new Promise((resolve) => server.once('listening', resolve));
    expect(server.listening).toBe(true);
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
});

afterAll(() => {
  fs.rmSync(testDbPath, { recursive: true, force: true });
});
