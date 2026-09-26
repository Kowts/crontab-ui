'use strict';

/* global describe, it, expect, beforeAll, afterAll */
const request = require('supertest');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
const { requireRole } = require('../middleware/authorization');
const { configuredUsers } = require('../middleware/auth');

describe('Crontab UI', () => {
  afterAll(() => {
    fs.rmSync(testDbPath, { recursive: true, force: true });
  });

  describe('GET /', () => {
    it('should return the main page', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Crontab UI');
      expect(res.text).toContain('Cronjobs');
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
      expect(res.text).toContain('echo hello');
    });

    it('should include the make_command wrapper (tee pipeline)', async () => {
      const res = await request(app).get('/preview_crontab');
      expect(res.text).toContain('tee');
      expect(res.text).toContain('stderr');
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
    it('should reject path traversal in db param', async () => {
      const res = await request(app).get('/restore?db=../../etc/passwd');
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid db parameter');
    });

    it('should reject invalid characters in id param', async () => {
      const res = await request(app).get('/logger?id=../../../etc/passwd');
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid id parameter');
    });

    it('should allow valid db param', async () => {
      const res = await request(app).get('/restore?db=crontab.db');
      expect(res.status).toBe(200);
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
  });

  describe('Command textarea', () => {
    it('should render a textarea for the command field', async () => {
      const res = await request(app).get('/');
      expect(res.text).toContain('<textarea');
      expect(res.text).toContain('id=\'job-command\'');
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
