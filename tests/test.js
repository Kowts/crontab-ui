'use strict';

/* global describe, it, expect, beforeAll, beforeEach, afterAll, afterEach */
const rawRequest = require('supertest');
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const vm = require('vm');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const cronstrue = require('cronstrue/i18n');
const { SqliteDatastore, createDatabaseFile, readJobsFromFile, isSqliteFile } = require('../lib/database');

const testDbPath = path.join(os.tmpdir(), `crontab-ui-test-${Date.now()}`);
fs.mkdirSync(testDbPath, { recursive: true });
fs.mkdirSync(path.join(testDbPath, 'logs'), { recursive: true });

process.env.CRON_DB_PATH = testDbPath;
process.env.CRON_PATH = testDbPath;
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.NODE_ENV = 'test';
process.env.CSRF_SECRET = 'test-csrf-secret';
process.env.MAIL_PROFILES_JSON = JSON.stringify({
  operations: {
    transporter: 'smtps://mailer:password@smtp.example.test',
    from: 'crontab@example.test',
    to: 'operations@example.test',
  },
});

const testCsrfNonce = 'test-csrf-nonce';
const testCsrfToken = `${testCsrfNonce}.${crypto.createHmac('sha256', process.env.CSRF_SECRET)
  .update(testCsrfNonce).digest('base64url')}`;

function withCsrf(client) {
  for (const method of ['post', 'put', 'patch', 'delete']) {
    const original = client[method].bind(client);
    client[method] = (...args) => original(...args)
      .set('Cookie', `crontab_ui_csrf=${encodeURIComponent(testCsrfToken)}`)
      .set('X-CSRF-Token', testCsrfToken);
  }
  return client;
}

function request(target) {
  return withCsrf(rawRequest(target));
}

request.agent = (target) => withCsrf(rawRequest.agent(target));

const { createApp, startServer } = require('../app');
const crontab = require('../crontab');
const { requireRole, validateRoleAssignments } = require('../middleware/authorization');
const setupAuth = require('../middleware/auth');
const { configuredUsers } = setupAuth;
const { getProfile } = require('../config/mail-profiles');
const { execute } = require('../execution');
const { parseEnvironment } = require('../config/environment');
const { buildTaskEnvironment, configuredTaskEnvironmentNames } = require('../config/task-environment');
const { createReloadCoordinator, schedulerEnvironment } = require('../scheduler');
const { collectOutputAttachments } = require('../bin/crontab-ui-mailer');
const { validateAllProfiles, validateProfileId } = require('../config/mail-profiles');
const { categoriseFailure } = require('../config/mail-probe');
const { validateProductionTransport } = require('../config/transport');
const { hashPassword, verifyPassword, isValidDigestFormat, identifyForeignDigest } = require('../config/passwords');
const { normaliseMailing, failureAlertDue } = require('../config/alert-policy');
const { useBoundedNumber, requireBoundedNumber } = require('../config/limits');
const { canAccessJob, requireSaveAccess, canManageTasks } = require('../middleware/job-authorization');
const csrfProtection = require('../middleware/csrf');

// Requiring app.js must not build an application, so the shared instance used
// by the HTTP suite is created explicitly here. Every other test builds its own.
const app = createApp();

describe('Crontab UI', () => {
  describe('Execution history pagination', () => {
    function createPanel() {
      const elements = {};
      const createElement = () => ({
        children: [],
        classList: { remove() {} },
        appendChild(child) { this.children.push(child); },
        set textContent(value) { this.children = []; this.text = value; },
        get textContent() { return this.text; },
      });
      const state = { options: [], initialized: false, destroyed: 0 };
      const jquery = () => ({
        DataTable(options) {
          if (options) { state.options.push(options); state.initialized = true; }
          return { destroy() { state.initialized = false; state.destroyed += 1; } };
        },
      });
      jquery.fn = { dataTable: { isDataTable: () => state.initialized } };
      const context = {
        $: jquery,
        document: {
          addEventListener() {},
          createElement,
          getElementById(id) { elements[id] ||= createElement(); return elements[id]; },
        },
      };
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/script.js'), 'utf8'), context);
      context.i18n = require('../config/i18n').dictionaries.en;
      return { context, elements, state };
    }

    function history(count) {
      return Array.from({ length: count }, (_, index) => ({
        completedAt: 1_700_000_000_000 - index * 60_000,
        trigger: 'scheduled', status: 'completed', durationMs: index + 1, exitCode: 0,
      }));
    }

    it('paginates recent executions with translated counts and preserves server order', () => {
      const { context, elements, state } = createPanel();
      context.renderExecutions({ history: history(11), consecutiveFailures: 0 });
      const options = state.options[0];
      expect(options).toMatchObject({ pageLength: 5, lengthMenu: [5, 10, 25, 50], searching: false, ordering: false });
      expect(options.language.info).toBe('Showing _START_ to _END_ of _TOTAL_ executions');
      expect(elements['executions-body'].children.map((row) => row.children[3].textContent))
        .toEqual(Array.from({ length: 11 }, (_, index) => `${index + 1} ms`));
      let hidden;
      let pages = 3;
      const pager = { classList: { toggle(_name, value) { hidden = value; } } };
      const api = { table: () => ({ container: () => ({ querySelector: () => pager }) }), page: { info: () => ({ pages }) } };
      options.drawCallback.call({ api: () => api });
      expect(hidden).toBe(false);
      pages = 1;
      options.drawCallback.call({ api: () => api });
      expect(hidden).toBe(true);
      expect(elements['executions-empty'].hidden).toBe(true);
    });

    it('resets the table between tasks and removes pagination for empty history', () => {
      const { context, elements, state } = createPanel();
      context.renderExecutions({ history: history(11), consecutiveFailures: 0 });
      context.i18n = require('../config/i18n').dictionaries.pt;
      context.renderExecutions({ history: history(1), consecutiveFailures: 0 });
      expect(state.destroyed).toBe(1);
      expect(state.options[1].language.info).toBe('A mostrar _START_ a _END_ de _TOTAL_ execuções');
      expect(elements['executions-body'].children).toHaveLength(1);
      context.renderExecutions({ history: [], consecutiveFailures: 0 });
      expect(state.destroyed).toBe(2);
      expect(state.initialized).toBe(false);
      expect(state.options).toHaveLength(2);
      expect(elements['executions-body'].children).toHaveLength(0);
      expect(elements['executions-empty'].hidden).toBe(false);
    });
  });

  describe('SQLite primary-key operations', () => {
    it('finds, updates and removes targeted job ids without changing other documents', async () => {
      const filename = path.join(testDbPath, `primary-key-${crypto.randomUUID()}.db`);
      const datastore = new SqliteDatastore({ filename });
      const jobs = [
        { _id: 'first', name: 'first', created: 1 },
        { _id: 'second', name: 'second', created: 2 },
      ];
      try {
        await Promise.all(jobs.map((job) => new Promise((resolve, reject) => datastore.insert(job, (error) => (error ? reject(error) : resolve())))));
        const found = await new Promise((resolve, reject) => datastore.find({ _id: 'first' }).exec((error, docs) => (error ? reject(error) : resolve(docs))));
        expect(found).toEqual([jobs[0]]);
        await new Promise((resolve, reject) => datastore.update({ _id: { $in: ['first'] } }, { $set: { name: 'updated' } }, { multi: true }, (error) => (error ? reject(error) : resolve())));
        await new Promise((resolve, reject) => datastore.remove({ _id: 'second' }, {}, (error) => (error ? reject(error) : resolve())));
        expect(datastore.getAllData()).toEqual([{ ...jobs[0], name: 'updated' }]);
      } finally {
        datastore.close();
        fs.rmSync(filename, { force: true });
      }
    });
  });

  describe('Audit write retry', () => {
    it('documents the bounded synchronous retry for transient Windows log locks', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'crontab.js'), 'utf8');
      expect(source).toContain('const auditWriteAttempts = 3;');
      expect(source).toContain('const auditRetryDelayMs = 25;');
      expect(source).toContain('at most two times (50 ms total)');
    });
  });

  describe('GET /', () => {
    it('should return the main page', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Crontab UI');
      expect(res.text).toContain('Scheduled tasks');
      expect(res.text).toContain('Create first task');
      expect(res.text).toContain('id="job-schedule-description"');
      expect(res.text).toContain('vendor/cronstrue/cronstrue-i18n.min.js');
      expect(res.text).toContain('src="/js/theme.js"');
      expect(res.text).toContain('src="/js/script.js"');
      expect(res.text).toContain('id="theme-toggle"');
      expect(res.text).toContain('https://github.com/Kowts/crontab-ui');
      expect(res.text).toContain('rel="noopener noreferrer"');
      expect(res.text).toContain('id="environment-display"');
      expect(res.text).toContain('for="job-minute">Minute</label>');
      expect(res.text).toContain('data-schedule="0 0 1 1 *"');
      expect(res.text).toContain('Yearly');
      expect(res.text).toContain('id="import-modal"');
      expect(res.text).toContain('id="import_file"');
      expect(res.text).toContain('id="import-preview-modal"');
      const indexTemplate = fs.readFileSync(path.join(__dirname, '..', 'views', 'index.ejs'), 'utf8');
      expect(indexTemplate).toContain('data-bs-toggle="tooltip"');
      expect(indexTemplate).toContain('class="action-label"><%= t(\'run\') %></span>');
      expect((res.text.match(/data-action="new-job"/g) || []).length).toBe(2);
    });

    it('serves static assets without consuming the application rate-limit quota', async () => {
      const res = await request(app).get('/js/theme.js');
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
    });

    it('reloads the task list after a successful configuration import', () => {
      const clientScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'script.js'), 'utf8');
      expect(clientScript).toContain("getModal('import-modal').hide()");
      expect(clientScript).toContain('window.location.reload()');
      expect(clientScript).toContain("new URL(importForm.getAttribute('action'), window.location.origin)");
      expect(clientScript).toContain('function closeImportModal(callback)');
      expect(clientScript).toContain('function renderImportPreview(summary)');
      expect(clientScript).toContain('importRequest(true).then(function(summary)');
    });
  });

  describe('Interface language', () => {
    it('uses English by default and Portuguese when the locale cookie is set', async () => {
      const english = await request(app).get('/');
      const portuguese = await request(app).get('/').set('Cookie', 'crontab_ui_locale=pt');
      expect(english.text).toContain('Scheduled tasks');
      expect(portuguese.text).toContain('Tarefas agendadas');
      expect(english.text).toContain('Switch to dark theme');
      expect(portuguese.text).toContain('Mudar para tema escuro');
    });

    it('persists a supported locale in an HttpOnly cookie', async () => {
      const res = await request(app).post('/locale').send({ locale: 'pt' });
      expect(res.status).toBe(204);
      expect(res.headers['set-cookie'].join(';')).toContain('crontab_ui_locale=pt');
      expect(res.headers['set-cookie'].join(';')).toContain('HttpOnly');
    });

    it('exposes root-relative locale routes to the browser', async () => {
      const res = await request(app).get('/');
      expect(res.text).toContain('"locale":"/locale"');
    });
  });

  describe('Descrição de horários cron', () => {
    it('produz uma descrição em português para uma expressão válida', () => {
      expect(cronstrue.toString('0 2 * * *', {
        locale: 'pt_PT', use24HourTimeFormat: true, verbose: true
      })).toContain('02:00');
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
      expect(res.text).toContain('Local change — not published');
      expect(res.text).toContain('Owner: local');
      expect(res.text).toContain('Can manage and run');
      expect(res.text).toContain('Saving changes locally does not publish them to the service crontab.');
    });

    it('uses distinct controls for manual execution and schedule deactivation', async () => {
      const res = await request(app).get('/');
      expect(res.text).toContain('title="Run now without publishing"');
      expect(res.text).toContain('title="Disable scheduled task"');
      expect(res.text).toContain('class="bi bi-stop-fill"');
      expect(res.text).not.toContain('class="bi bi-pause-fill"');
    });
  });

  describe('Execution panel', () => {
    function createJob(name, command) {
      return new Promise((resolve, reject) => {
        crontab.create_new(name, command, '*/5 * * * *', false, {}, {}, (error, job) => {
          if (error) reject(error);
          else resolve(job);
        });
      });
    }

    function runJob(job) {
      return new Promise((resolve) => crontab.runjob(job._id, {}, (error) => resolve(error)));
    }

    function setCommand(job, command) {
      return new Promise((resolve, reject) => crontab.update(job._id, {
        name: job.name, command, schedule: job.schedule, logging: false, mailing: {},
      }, (error) => (error ? reject(error) : resolve())));
    }

    it('reports a task that never ran instead of failing the panel', async () => {
      const job = await createJob('panel-empty', 'echo panel-empty');
      const res = await request(app).get('/executions').query({ id: job._id });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ jobId: job._id, lastRun: null, lastSuccess: null, consecutiveFailures: 0, history: [] });
      expect(res.body.nextRun).toEqual(expect.any(String));
    });

    it('records duration and exit code of a successful run', async () => {
      const job = await createJob('panel-success', 'echo panel-success');
      expect(await runJob(job)).toBeFalsy();
      const res = await request(app).get('/executions').query({ id: job._id });
      expect(res.body.lastRun).toMatchObject({ status: 'completed', exitCode: 0, trigger: 'scheduled' });
      expect(res.body.lastRun.durationMs).toBeGreaterThanOrEqual(0);
      expect(res.body.lastSuccess).toMatchObject({ status: 'completed', exitCode: 0 });
      expect(res.body.consecutiveFailures).toBe(0);
      expect(res.body.history).toHaveLength(1);
    });

    it('keeps the last successful run and counts failures while it cannot find one', async () => {
      const job = await createJob('panel-regression', 'echo panel-regression');
      await runJob(job);
      await setCommand(job, 'exit 3');
      await runJob(job);
      await runJob(job);
      const res = await request(app).get('/executions').query({ id: job._id });
      expect(res.body.lastRun).toMatchObject({ status: 'failed', exitCode: 3 });
      expect(res.body.consecutiveFailures).toBe(2);
      expect(res.body.lastSuccess.exitCode).toBe(0);
    });

    it('resets the failure count as soon as a task succeeds again', async () => {
      const job = await createJob('panel-recovered', 'echo panel-recovered');
      await runJob(job);
      await setCommand(job, 'exit 1');
      await runJob(job);
      await runJob(job);
      await setCommand(job, 'echo panel-recovered');
      await runJob(job);
      const res = await request(app).get('/executions').query({ id: job._id });
      expect(res.body.consecutiveFailures).toBe(0);
      expect(res.body.lastRun.status).toBe('completed');
    });

    it('records a cancelled run as a failure of the task, not as a success', async () => {
      const job = await createJob('panel-cancelled', `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`);
      const started = await new Promise((resolve) => {
        crontab.startManualRun(job._id, { actor: 'panel-tester' }, (error, run) => resolve(run));
      });
      expect(started.status).toBe('running');
      await crontab.cancelManualRun(started.operationId, { actor: 'panel-tester' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const res = await request(app).get('/executions').query({ id: job._id });
      expect(res.body.lastRun).toMatchObject({ status: 'cancelled', trigger: 'manual', actor: 'panel-tester' });
      expect(res.body.consecutiveFailures).toBe(1);
    });

    it('does not expose the command or any output through the panel', async () => {
      const job = await createJob('panel-secret', 'echo panel-secret-token');
      await runJob(job);
      const res = await request(app).get('/executions').query({ id: job._id });
      expect(res.text).not.toContain('panel-secret-token');
      expect(res.body).not.toHaveProperty('command');
    });

    it('rejects an unknown task and a malformed identifier', async () => {
      expect((await request(app).get('/executions').query({ id: 'does-not-exist' })).status).toBe(404);
      expect((await request(app).get('/executions').query({ id: '../secret' })).status).toBe(400);
    });

    it('reports no next run for a paused task', async () => {
      const job = await createJob('panel-paused', 'echo panel-paused');
      await new Promise((resolve, reject) => crontab.status(job._id, true, (error) => (error ? reject(error) : resolve())));
      const res = await request(app).get('/executions').query({ id: job._id });
      expect(res.body.nextRun).toBeNull();
      expect(res.body.stopped).toBe(true);
    });
  });

  describe('Asynchronous manual execution', () => {
    it('returns an operation ID immediately and exposes its status', async () => {
      const job = await new Promise((resolve, reject) => {
        crontab.create_new('async-run', 'echo async-run', '* * * * *', false, {}, {}, (error, created) => {
          if (error) reject(error);
          else resolve(created);
        });
      });
      const started = await request(app).post('/runjob').send({ _id: job._id });
      expect(started.status).toBe(202);
      expect(started.body.operationId).toMatch(/^[a-f0-9-]{36}$/);
      const status = await request(app).get('/runjob/status').query({ operationId: started.body.operationId });
      expect(status.status).toBe(200);
      expect(['running', 'completed']).toContain(status.body.status);
    });

    it('persists manual-run state and limits concurrent runs per actor', async () => {
      const createJob = (name) => new Promise((resolve, reject) => {
        crontab.create_new(name, `"${process.execPath}" -e "setTimeout(() => {}, 500)"`, '* * * * *', false, {}, {}, (error, job) => {
          if (error) reject(error);
          else resolve(job);
        });
      });
      const start = (job, actor) => new Promise((resolve) => {
        crontab.startManualRun(job._id, { actor }, (error, run) => resolve({ error, run }));
      });
      const firstJob = await createJob('manual-run-alice');
      const secondJob = await createJob('manual-run-bob');
      const first = await start(firstJob, 'alice');
      const second = await start(secondJob, 'bob');
      const duplicate = await start(firstJob, 'alice');

      expect(first.error).toBeNull();
      expect(second.error).toBeNull();
      expect(first.run).toMatchObject({ actor: 'alice', status: 'running' });
      expect(second.run).toMatchObject({ actor: 'bob', status: 'running' });
      expect(crontab.getManualRun(first.run.operationId)).toMatchObject({ operationId: first.run.operationId, actor: 'alice' });
      expect(duplicate.error).toMatchObject({ statusCode: 409 });

      crontab.cancelManualRun(first.run.operationId, { actor: 'alice' });
      crontab.cancelManualRun(second.run.operationId, { actor: 'bob' });
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const waitForCompletion = () => {
          const runs = [first.run.operationId, second.run.operationId].map(crontab.getManualRun);
          if (runs.every((run) => run.status !== 'running')) return resolve();
          if (Date.now() >= deadline) return reject(new Error('Manual runs did not stop in time'));
          return setTimeout(waitForCompletion, 25);
        };
        waitForCompletion();
      });
    });

    it('marks unfinished persisted manual runs as interrupted during recovery', async () => {
      const job = await new Promise((resolve, reject) => {
        crontab.create_new('manual-run-recovery', `"${process.execPath}" -e "setTimeout(() => {}, 1000)"`, '* * * * *', false, {}, {}, (error, created) => {
          if (error) reject(error);
          else resolve(created);
        });
      });
      const started = await new Promise((resolve, reject) => {
        crontab.startManualRun(job._id, { actor: 'recovery-user' }, (error, run) => (error ? reject(error) : resolve(run)));
      });

      expect(crontab.recoverManualRuns()).toBe(1);
      expect(crontab.getManualRun(started.operationId)).toMatchObject({
        status: 'interrupted',
        result: { terminationReason: 'service_restart' },
      });
      crontab.shutdownManualRuns();
    });

    it('stores execution output in the managed log directory instead of CRON_PATH', async () => {
      const job = await new Promise((resolve, reject) => {
        crontab.create_new('managed-output', `"${process.execPath}" -e "process.stdout.write('managed-output')"`, '* * * * *', false, {}, {}, (error, created) => {
          if (error) reject(error);
          else resolve(created);
        });
      });
      const error = await new Promise((resolve) => crontab.runjob(job._id, (runError) => resolve(runError)));
      expect(error).toBeNull();
      expect(fs.readFileSync(path.join(crontab.output_folder, `${job._id}.stdout`), 'utf8')).toBe('managed-output');
      expect(fs.existsSync(path.join(testDbPath, `${job._id}.stdout`))).toBe(false);
    });

    it('does not expose service secrets to scheduled commands', async () => {
      const originalSecret = process.env.CRON_UI_EXECUTION_SECRET;
      const originalAllowlist = process.env.TASK_ENV_ALLOWLIST;
      const originalEnvironment = fs.existsSync(crontab.env_file) ? fs.readFileSync(crontab.env_file, 'utf8') : null;
      process.env.CRON_UI_EXECUTION_SECRET = 'must-not-reach-task';
      process.env.TASK_ENV_ALLOWLIST = 'SAFE_VALUE';
      fs.writeFileSync(crontab.env_file, 'SAFE_VALUE=allowed\nCRON_UI_EXECUTION_SECRET=must-not-reach-task');
      try {
        const job = await new Promise((resolve, reject) => {
          crontab.create_new('isolated-environment', `"${process.execPath}" -e "process.stdout.write((process.env.SAFE_VALUE || 'missing') + ':' + (process.env.CRON_UI_EXECUTION_SECRET || 'not-exposed'))"`, '* * * * *', false, {}, {}, (error, created) => {
            if (error) reject(error);
            else resolve(created);
          });
        });
        const error = await new Promise((resolve) => crontab.runjob(job._id, (runError) => resolve(runError)));
        expect(error).toBeNull();
        expect(fs.readFileSync(path.join(crontab.output_folder, `${job._id}.stdout`), 'utf8')).toBe('allowed:not-exposed');
      } finally {
        if (originalSecret === undefined) delete process.env.CRON_UI_EXECUTION_SECRET;
        else process.env.CRON_UI_EXECUTION_SECRET = originalSecret;
        if (originalAllowlist === undefined) delete process.env.TASK_ENV_ALLOWLIST;
        else process.env.TASK_ENV_ALLOWLIST = originalAllowlist;
        if (originalEnvironment === null) fs.rmSync(crontab.env_file, { force: true });
        else fs.writeFileSync(crontab.env_file, originalEnvironment);
      }
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

    it('defaults a selected mail profile to notifications on failure', async () => {
      const res = await request(app).post('/save').send({
        _id: -1, name: 'failure-only-profile', command: 'echo hello',
        schedule: '* * * * *', logging: false, mailing: { profileId: 'operations' },
      });
      expect(res.status).toBe(200);
      const jobs = await new Promise((resolve) => crontab.crontabs(resolve));
      expect(jobs.find((job) => job.name === 'failure-only-profile').mailing).toEqual({ profileId: 'operations', policy: 'onFailure' });
    });

    it('rejects an invalid mail notification policy', async () => {
      const res = await request(app).post('/save').send({
        _id: -1, name: 'invalid-policy', command: 'echo hello',
        schedule: '* * * * *', logging: false, mailing: { profileId: 'operations', policy: 'sometimes' },
      });
      expect(res.status).toBe(400);
    });

    it('renders only safe mail profile ids for task notifications', async () => {
      const page = await request(app).get('/');
      expect(page.text).toContain('id="job-mail-profile"');
      expect(page.text).toContain('<option value="operations">operations</option>');
      expect(page.text).toContain('No email notification');
      expect(page.text).not.toContain('mailer:password');
      const clientScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'script.js'), 'utf8');
      expect(clientScript).toContain("$('#job-mail-profile').val(job.mailing && job.mailing.profileId ? job.mailing.profileId : '');");
      expect(clientScript).toContain("$('#job-mail-policy').val(job.mailing && job.mailing.policy ? job.mailing.policy : 'onFailure');");
      expect(clientScript).toContain("var profileId = $('#job-mail-profile').val();");
    });

    it('sends mail only for the configured execution outcome', () => {
      expect(crontab.should_send_mail({ profileId: 'operations' }, true)).toBe(true);
      expect(crontab.should_send_mail({ profileId: 'operations' }, false)).toBe(false);
      expect(crontab.should_send_mail({ profileId: 'operations', policy: 'onSuccess' }, true)).toBe(false);
      expect(crontab.should_send_mail({ profileId: 'operations', policy: 'onSuccess' }, false)).toBe(true);
      expect(crontab.should_send_mail({ profileId: 'operations', policy: 'always' }, true)).toBe(true);
      expect(crontab.should_send_mail({}, true)).toBe(false);
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
      const latest = crontab.get_backup_names()[0];
      expect(isSqliteFile(path.join(testDbPath, latest))).toBe(true);
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
      expect(res.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
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

  describe('POST /import_crontab', () => {
    it('waits for the complete system import before returning its result', async () => {
      const originalImport = crontab.import_crontab;
      let completed = false;
      crontab.import_crontab = (callback) => setTimeout(() => {
        completed = true;
        callback(null, { imported: 2, unchanged: 1 });
      }, 25);

      try {
        const res = await request(app).post('/import_crontab');
        expect(res.status).toBe(200);
        expect(completed).toBe(true);
        expect(res.body).toEqual({ imported: 2, unchanged: 1 });
      } finally {
        crontab.import_crontab = originalImport;
      }
    });

    it('imports valid entries atomically, creates a backup, and skips duplicates', async () => {
      const backupsBefore = crontab.get_backup_names().length;
      const result = await new Promise((resolve, reject) => {
        crontab.import_crontab((error, summary) => {
          if (error) return reject(error);
          return resolve(summary);
        }, (callback) => callback(null, [
          '# system crontab',
          '*/5 * * * * echo imported-job',
          '@reboot echo boot-job',
          'MAILTO=ops@example.test',
          '*/5 * * * * echo imported-job',
          'invalid cron line',
        ].join('\n')));
      });

      expect(result).toMatchObject({ imported: 2, unchanged: 1 });
      expect(crontab.get_backup_names().length).toBe(backupsBefore + 1);
      const jobs = await new Promise((resolve) => crontab.crontabs(resolve));
      expect(jobs.filter((job) => job.command === 'echo imported-job')).toHaveLength(1);
      expect(jobs.some((job) => job.command === 'echo boot-job' && job.schedule === '@reboot')).toBe(true);
    });

    it('rejects a concurrent system import while the first operation owns the database lock', async () => {
      let releaseFirstImport;
      const firstImport = new Promise((resolve, reject) => {
        crontab.import_crontab((error) => (error ? reject(error) : resolve()), (callback) => {
          releaseFirstImport = callback;
        });
      });
      const conflict = await new Promise((resolve) => {
        crontab.import_crontab((error) => resolve(error), (callback) => callback(null, ''));
      });
      expect(conflict).toBeInstanceOf(Error);
      expect(conflict.statusCode).toBe(409);

      releaseFirstImport(null, '');
      await firstImport;
    });
  });

  describe('POST /import (auto-backup)', () => {
    function createCandidate(name, documents) {
      const candidate = path.join(testDbPath, name);
      createDatabaseFile(candidate, documents);
      const content = fs.readFileSync(candidate);
      fs.rmSync(candidate, { force: true });
      return content;
    }

    function createJob(name, command) {
      return new Promise((resolve, reject) => crontab.create_new(
        name, command, '* * * * *', false, {}, {}, (error, job) => (error ? reject(error) : resolve(job))
      ));
    }

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

    it('previews a merge without changing tasks, then keeps existing tasks and skips exact duplicates', async () => {
      const suffix = crypto.randomUUID();
      const existing = await createJob(`merge-existing-${suffix}`, `echo existing-${suffix}`);
      const candidate = createCandidate(`merge-${suffix}.db`, [
        { _id: 'duplicate', name: existing.name, command: existing.command, schedule: existing.schedule },
        { _id: 'conflict', name: existing.name, command: `echo conflict-${suffix}`, schedule: '* * * * *' },
        { _id: 'new', name: `merge-new-${suffix}`, command: `echo new-${suffix}`, schedule: '*/5 * * * *' },
      ]);
      const before = await new Promise((resolve) => crontab.crontabs(resolve));

      const preview = await request(app).post('/import')
        .field('mode', 'merge').field('dryRun', 'true')
        .attach('import_file', candidate, 'candidate.db');
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ preview: true, mode: 'merge', incoming: 3, added: 2, skipped: 1, conflicts: 1 });
      expect((await new Promise((resolve) => crontab.crontabs(resolve))).length).toBe(before.length);

      const applied = await request(app).post('/import')
        .field('mode', 'merge').field('dryRun', 'false')
        .attach('import_file', candidate, 'candidate.db');
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ preview: false, mode: 'merge', added: 2, skipped: 1, conflicts: 1 });
      const jobs = await new Promise((resolve) => crontab.crontabs(resolve));
      expect(jobs.filter((job) => job.command === existing.command)).toHaveLength(1);
      expect(jobs.some((job) => job.command === `echo conflict-${suffix}`)).toBe(true);
      expect(jobs.some((job) => job.command === `echo new-${suffix}`)).toBe(true);
    });

    it('replaces tasks only when the explicit replace mode is selected', async () => {
      const suffix = crypto.randomUUID();
      const existing = await createJob(`replace-existing-${suffix}`, `echo replace-existing-${suffix}`);
      const candidate = createCandidate(`replace-${suffix}.db`, [{
        _id: 'replacement', name: `replacement-${suffix}`, command: `echo replacement-${suffix}`,
        schedule: '* * * * *',
      }]);
      const applied = await request(app).post('/import')
        .field('mode', 'replace').field('dryRun', 'false')
        .attach('import_file', candidate, 'candidate.db');

      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ mode: 'replace', incoming: 1, replaced: expect.any(Number) });
      const jobs = await new Promise((resolve) => crontab.crontabs(resolve));
      expect(jobs.some((job) => job._id === existing._id)).toBe(false);
      expect(jobs.some((job) => job.command === `echo replacement-${suffix}`)).toBe(true);
    });
  });

  describe('Command textarea', () => {
    it('should render a textarea for the command field', async () => {
      const res = await request(app).get('/');
      expect(res.text).toContain('<textarea');
      expect(res.text).toContain('id="job-command"');
    });
  });

  describe('Database import normalisation', () => {
    function normalise(file) {
      return new Promise((resolve, reject) => crontab.normalise_database(file, (error) => {
        if (error) reject(error);
        else resolve();
      }));
    }

    function records(file) {
      return readJobsFromFile(file);
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
      expect(isSqliteFile(file)).toBe(true);
      const [job] = records(file);
      expect(job._id).not.toBe('externally-controlled-id');
      expect(job.hook).toBeUndefined();
      expect(job.command).toBe('echo imported');
      expect(job.logging).toBe(true);
    });

    it('accepts an empty datastore', async () => {
      const file = writeCandidate('normalise-empty.db', []);
      await normalise(file);
      expect(records(file)).toEqual([]);
    });

    it('migrates an existing NeDB database to SQLite while retaining the legacy source', () => {
      const folder = path.join(testDbPath, `legacy-migration-${Date.now()}`);
      const file = path.join(folder, 'crontab.db');
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        _id: 'legacy-task', name: 'legacy task', command: 'echo legacy', schedule: '* * * * *',
        stopped: false, logging: false, mailing: {}, created: 1, saved: false,
      }));

      const legacyDatabase = new SqliteDatastore({ filename: file });
      expect(isSqliteFile(file)).toBe(true);
      expect(legacyDatabase.getAllData()).toEqual([expect.objectContaining({ _id: 'legacy-task', command: 'echo legacy' })]);
      legacyDatabase.close();
      expect(fs.readdirSync(folder).some((name) => name.startsWith('crontab.db.legacy-nedb-'))).toBe(true);
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

    it('preserves task identity and ownership, but requires publication review after restoration', async () => {
      const suffix = crypto.randomUUID();
      const created = await new Promise((resolve, reject) => crontab.create_new(
        `recovery-metadata-${suffix}`, `echo recovery-metadata-${suffix}`, '* * * * *', false, {},
        { owner: 'restore-owner', createdBy: 'restore-creator' },
        (error, job) => (error ? reject(error) : resolve(job))
      ));
      await new Promise((resolve, reject) => crontab.set_crontab({}, (error) => (error ? reject(error) : resolve()), (_file, callback) => callback(null)));
      const beforeBackup = await new Promise((resolve) => crontab.get_crontab(created._id, (error, job) => resolve(job)));
      expect(beforeBackup.saved).toBe(true);

      await new Promise((resolve, reject) => crontab.backup((error) => (error ? reject(error) : resolve())));
      const backup = fs.readdirSync(testDbPath).filter((file) => file.startsWith('backup-')).sort().at(-1);
      await new Promise((resolve, reject) => crontab.remove(created._id, (error) => (error ? reject(error) : resolve())));
      await new Promise((resolve, reject) => crontab.restore(backup, (error) => (error ? reject(error) : resolve())));

      const restored = await new Promise((resolve) => crontab.get_crontab(created._id, (error, job) => resolve(job)));
      expect(restored).toMatchObject({
        _id: created._id, owner: 'restore-owner', createdBy: 'restore-creator', saved: true, needsPublishReview: true,
      });
      const page = await request(app).get('/');
      expect(page.text).toContain('"needsPublishReview":true');
      expect(page.text).toContain('Review and publish');
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

describe('Crontab publication', () => {
  function createJob(name, command) {
    return new Promise((resolve, reject) => crontab.create_new(
      name, command, '* * * * *', false, {}, {}, (error, job) => (error ? reject(error) : resolve(job))
    ));
  }

  function publish(environment, applyCrontab) {
    return new Promise((resolve, reject) => crontab.set_crontab(
      environment, (error) => (error ? reject(error) : resolve()), applyCrontab
    ));
  }

  it('uses a bounded command boundary and marks only the published snapshot as saved', async () => {
    const publishedJob = await createJob('publication-snapshot', 'echo publication-snapshot');
    let publishedFile;
    await publish({ PATH: '/usr/bin' }, (file, callback) => {
      publishedFile = file;
      createJob('publication-concurrent', 'echo publication-concurrent').then(() => callback(null));
    });

    expect(path.basename(publishedFile)).toBe('crontab');
    expect(fs.readFileSync(publishedFile, 'utf8')).toContain(publishedJob._id);
    const jobs = await new Promise((resolve) => crontab.crontabs(resolve));
    expect(jobs.find((job) => job._id === publishedJob._id).saved).toBe(true);
    expect(jobs.find((job) => job.command === 'echo publication-concurrent').saved).toBe(false);
  });

  it('writes the Docker scheduler file for the unprivileged configured user', async () => {
    const previousDocker = process.env.CRON_IN_DOCKER;
    const previousUser = process.env.CRON_USER;
    process.env.CRON_IN_DOCKER = 'true';
    process.env.CRON_USER = 'node';
    let publishedFile;
    try {
      await publish({}, (file, callback) => { publishedFile = file; callback(null); });
      expect(path.basename(publishedFile)).toBe('node');
    } finally {
      if (previousDocker === undefined) delete process.env.CRON_IN_DOCKER;
      else process.env.CRON_IN_DOCKER = previousDocker;
      if (previousUser === undefined) delete process.env.CRON_USER;
      else process.env.CRON_USER = previousUser;
    }
  });

  it('restores the environment and staged crontab when applying it fails', async () => {
    const stagedCrontab = path.join(testDbPath, 'crontab');
    fs.writeFileSync(crontab.env_file, 'PATH=/before');
    fs.writeFileSync(stagedCrontab, '# previous crontab');

    await expect(publish({ PATH: '/after' }, (_file, callback) => callback(new Error('apply failed'))))
      .rejects.toThrow('apply failed');

    expect(fs.readFileSync(crontab.env_file, 'utf8')).toBe('PATH=/before');
    expect(fs.readFileSync(stagedCrontab, 'utf8')).toBe('# previous crontab');
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
    return new Promise((resolve) => crontab.get_crontab(id, (error, job) => resolve(job)));
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

  it('creates a job when _id uses the numeric creation sentinel', async () => {
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

  it('accepts the URL-encoded creation sentinel sent by the browser form', async () => {
    const response = await request(app).post('/save').type('form').send({
      _id: '-1',
      name: 'urlencoded-create',
      command: 'echo created-from-form',
      schedule: '* * * * *',
      logging: 'false',
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

describe('Task execution environment isolation', () => {
  const originalAllowlist = process.env.TASK_ENV_ALLOWLIST;
  const originalCsrfSecret = process.env.CSRF_SECRET;
  const originalSafeValue = process.env.SAFE_VALUE;

  afterAll(() => {
    if (originalAllowlist === undefined) delete process.env.TASK_ENV_ALLOWLIST;
    else process.env.TASK_ENV_ALLOWLIST = originalAllowlist;
    if (originalCsrfSecret === undefined) delete process.env.CSRF_SECRET;
    else process.env.CSRF_SECRET = originalCsrfSecret;
    if (originalSafeValue === undefined) delete process.env.SAFE_VALUE;
    else process.env.SAFE_VALUE = originalSafeValue;
  });

  it('passes only approved task variables and excludes service secrets', () => {
    process.env.TASK_ENV_ALLOWLIST = 'SAFE_VALUE';
    process.env.CSRF_SECRET = 'service-secret';
    const environment = buildTaskEnvironment({ SAFE_VALUE: 'available', CSRF_SECRET: 'attempted-override', OTHER: 'excluded' });
    expect(environment.SAFE_VALUE).toBe('available');
    expect(environment.CSRF_SECRET).toBeUndefined();
    expect(environment.OTHER).toBeUndefined();
  });

  it('rejects unsafe configuration names in TASK_ENV_ALLOWLIST', () => {
    process.env.TASK_ENV_ALLOWLIST = 'PATH,NODE_OPTIONS';
    expect(() => configuredTaskEnvironmentNames()).toThrow('safe uppercase environment variable names');
  });

  it('starts the container scheduler with the same restricted task environment', () => {
    process.env.TASK_ENV_ALLOWLIST = 'SAFE_VALUE';
    process.env.SAFE_VALUE = 'allowed';
    process.env.CSRF_SECRET = 'scheduler-secret';
    const environment = schedulerEnvironment();
    expect(environment).toMatchObject({ SAFE_VALUE: 'allowed', HOME: '/home/node', USER: 'node', LOGNAME: 'node' });
    expect(environment.CSRF_SECRET).toBeUndefined();
  });
});

describe('Docker scheduler reload confirmation', () => {
  it('does not confirm a newer schedule from a delayed read acknowledgement for the previous schedule', () => {
    let digest = 'initial';
    const acknowledgements = [];
    const signals = [];
    const coordinator = createReloadCoordinator({
      cronFile: '/scheduler/node',
      scheduler: { kill: (signal) => signals.push(signal) },
      readDigest: () => digest,
      writeState: (_file, acknowledgedDigest) => acknowledgements.push(acknowledgedDigest),
    });

    coordinator.confirmCrontabRead();
    digest = 'schedule-a';
    coordinator.recordFileChange();
    digest = 'schedule-b';
    coordinator.recordFileChange();

    // The first delayed acknowledgement belongs to schedule A, not the current file B.
    coordinator.confirmCrontabRead();
    expect(acknowledgements).toEqual(['initial', 'schedule-a']);
    expect(signals).toEqual(['SIGUSR2', 'SIGUSR2']);

    coordinator.confirmCrontabRead();
    expect(acknowledgements).toEqual(['initial', 'schedule-a', 'schedule-b']);
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

  it('accepts a stored digest and refuses a malformed one by name', async () => {
    const digest = await hashPassword('correct horse');
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ alice: digest });
    expect(configuredUsers()).toEqual({ alice: digest });

    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ alice: 'scrypt:nothex:alsonothex' });
    expect(() => configuredUsers()).toThrow('malformed password digest for user alice');
  });

  it('refuses a digest from another tool instead of storing it as a password', () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ alice: '$2b$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ' });
    expect(() => configuredUsers()).toThrow('unsupported format for user alice: bcrypt digest');

    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ alice: '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash' });
    expect(() => configuredUsers()).toThrow('unsupported format for user alice: Argon2 digest');
  });

  it('still accepts an ordinary password that merely contains a dollar sign', () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ alice: 'custo$50', bob: 'a$b$c' });
    expect(configuredUsers()).toEqual({ alice: 'custo$50', bob: 'a$b$c' });
  });
});

describe('Password storage', () => {
  it('never stores the password itself in the digest', async () => {
    const digest = await hashPassword('correct horse battery staple');
    expect(digest).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(digest).not.toContain('correct horse');
    expect(isValidDigestFormat(digest)).toBe(true);
  });

  it('produces a different digest for the same password every time', async () => {
    const first = await hashPassword('same-password');
    const second = await hashPassword('same-password');
    expect(first).not.toBe(second);
    expect(await verifyPassword('same-password', first)).toBe(true);
    expect(await verifyPassword('same-password', second)).toBe(true);
  });

  it('verifies a digest against the right password only', async () => {
    const digest = await hashPassword('right-password');
    expect(await verifyPassword('right-password', digest)).toBe(true);
    expect(await verifyPassword('wrong-password', digest)).toBe(false);
    expect(await verifyPassword('', digest)).toBe(false);
  });

  it('keeps supporting a literal password for loopback development', async () => {
    expect(await verifyPassword('dev-secret', 'dev-secret')).toBe(true);
    expect(await verifyPassword('dev-secre', 'dev-secret')).toBe(false);
    expect(await verifyPassword('anything', undefined)).toBe(false);
  });

  it('reports a malformed digest as a failed sign-in rather than an error', async () => {
    expect(await verifyPassword('anything', 'scrypt:zz:zz')).toBe(false);
    expect(await verifyPassword('anything', 'scrypt:only-two-parts')).toBe(false);
    expect(await verifyPassword('anything', 'bcrypt:whatever')).toBe(false);
  });

  it('recognises a digest from another tool instead of treating it as a password', () => {
    expect(identifyForeignDigest('$2b$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ')).toBe('bcrypt');
    expect(identifyForeignDigest('$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash')).toBe('Argon2');
    expect(identifyForeignDigest('pbkdf2_sha256$100000$salt$hash')).toBe('PBKDF2');
    expect(identifyForeignDigest('sha256:deadbeef')).toBe('SHA or MD5 digest');
    expect(identifyForeignDigest('django_pbkdf2_sha256$1000$abc')).toBe('framework password hasher');
  });

  it('does not mistake an ordinary password for a digest', () => {
    for (const password of ['hunter2', 'Senh@Forte!2026', 'user:pass', 'custo$50', 'a$b$c', 'argonautico', 'md5sum']) {
      expect(identifyForeignDigest(password)).toBeNull();
    }
  });
});

describe('Environment limits', () => {
  // Every name this block writes must be restored, including the security limit: a mistuned value
  // left behind stops the next createApp from building, which reads as an unrelated failure.
  const names = [
    'EXECUTION_HISTORY_PER_JOB', 'COMMAND_TIMEOUT_MS', 'LOG_RETENTION_DAYS', 'BACKUP_RETENTION_COUNT',
    'LOGIN_RATE_LIMIT_MAX',
  ];
  const saved = {};

  beforeEach(() => { for (const name of names) saved[name] = process.env[name]; });
  afterEach(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('falls back to the default for a value that is not a usable number', () => {
    process.env.EXECUTION_HISTORY_PER_JOB = 'abc';
    expect(useBoundedNumber('EXECUTION_HISTORY_PER_JOB', 200, 1, 10_000)).toBe(200);
    process.env.EXECUTION_HISTORY_PER_JOB = '0';
    expect(useBoundedNumber('EXECUTION_HISTORY_PER_JOB', 200, 1, 10_000)).toBe(200);
    process.env.EXECUTION_HISTORY_PER_JOB = '';
    expect(useBoundedNumber('EXECUTION_HISTORY_PER_JOB', 200, 1, 10_000)).toBe(200);
    delete process.env.EXECUTION_HISTORY_PER_JOB;
    expect(useBoundedNumber('EXECUTION_HISTORY_PER_JOB', 200, 1, 10_000)).toBe(200);
  });

  it('accepts a value inside the range', () => {
    process.env.EXECUTION_HISTORY_PER_JOB = '500';
    expect(useBoundedNumber('EXECUTION_HISTORY_PER_JOB', 200, 1, 10_000)).toBe(500);
  });

  it('refuses a mistuned security limit instead of silently weakening it', () => {
    process.env.LOGIN_RATE_LIMIT_MAX = '0';
    expect(() => requireBoundedNumber('LOGIN_RATE_LIMIT_MAX', 1, 1000)).toThrow('between 1 and 1000');
    process.env.LOGIN_RATE_LIMIT_MAX = '100000';
    expect(() => requireBoundedNumber('LOGIN_RATE_LIMIT_MAX', 1, 1000)).toThrow('between 1 and 1000');
  });
});

describe('Import and restore run state', () => {
  it('keeps local run history but drops state for tasks the new set does not contain', async () => {
    const kept = await new Promise((resolve, reject) => {
      crontab.create_new('kept-task', 'echo kept', '* * * * *', false, {}, { owner: 'admin', createdBy: 'admin' },
        (error, job) => (error ? reject(error) : resolve(job)));
    });
    const dropped = await new Promise((resolve, reject) => {
      crontab.create_new('dropped-task', 'echo dropped', '* * * * *', false, {}, { owner: 'admin', createdBy: 'admin' },
        (error, job) => (error ? reject(error) : resolve(job)));
    });
    await new Promise((resolve) => crontab.runjob(kept._id, {}, resolve));
    await new Promise((resolve) => crontab.runjob(dropped._id, {}, resolve));

    expect(crontab.getExecutionPanel(kept).history).toHaveLength(1);
    expect(crontab.getExecutionPanel(dropped).history).toHaveLength(1);

    // Replace the task set with one that only contains the first task.
    const candidate = path.join(testDbPath, `candidate-${crypto.randomUUID()}.db`);
    createDatabaseFile(candidate, [{ _id: kept._id, name: 'kept', command: 'echo kept', schedule: '* * * * *', created: 1 }]);
    await new Promise((resolve, reject) => {
      crontab.replace_database(candidate, (error) => (error ? reject(error) : resolve()));
    });

    // History for a task that still exists survives the replacement, and the state for the task
    // that is gone does not linger. A stale alert cooldown would suppress the first alert of a
    // restored or recreated task, which is why it is not treated as history.
    expect(crontab.getExecutionPanel(kept).history).toHaveLength(1);
    const jobs = await new Promise((resolve) => crontab.crontabs(resolve));
    expect(jobs.map((job) => job._id)).toEqual([kept._id]);
  });
});

describe('Task read failures', () => {
  it('reports a missing task as no error and no document', async () => {
    const result = await new Promise((resolve) => crontab.get_crontab('no-such-task', (error, job) => resolve({ error, job })));
    expect(result.error).toBeNull();
    expect(result.job).toBeUndefined();
  });

  it('separates a failed read from a task that does not exist', async () => {
    // Closing the store is the closest reproducible stand-in for a database that cannot be read.
    const filename = path.join(testDbPath, `read-failure-${crypto.randomUUID()}.db`);
    const store = new SqliteDatastore({ filename });
    await new Promise((resolve, reject) => {
      store.insert({ _id: 'unreadable', name: 'n', command: 'echo', schedule: '* * * * *', created: Date.now() },
        (error) => (error ? reject(error) : resolve()));
    });
    store.close();
    let passed = null;
    try {
      await new Promise((resolve) => {
        store.find({ _id: 'unreadable' }).exec((error, docs) => { passed = { error, docs }; resolve(); });
      });
    } finally {
      fs.unlinkSync(filename);
    }
    expect(passed.error).toBeInstanceOf(Error);
    expect(passed.docs).toBeUndefined();
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

describe('Mail output attachments', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'crontab-ui-mailer-'));

  it('attaches both outputs when they fit the limit', () => {
    fs.writeFileSync(path.join(folder, 'fits.stdout'), 'first');
    fs.writeFileSync(path.join(folder, 'fits.stderr'), 'second');
    const output = collectOutputAttachments(folder, 'fits', 1024);
    expect(output.notices).toEqual([]);
    expect(output.attachments.map((item) => item.filename)).toEqual(['stdout.txt', 'stderr.txt']);
    expect(output.attachments.map((item) => item.content.toString('utf8'))).toEqual(['first', 'second']);
  });

  it('truncates oversized output instead of failing the notification', () => {
    fs.writeFileSync(path.join(folder, 'big.stdout'), 'abcdefghij');
    fs.writeFileSync(path.join(folder, 'big.stderr'), '');
    const output = collectOutputAttachments(folder, 'big', 4);
    expect(output.attachments.map((item) => item.filename)).toEqual(['stdout-truncated.txt', 'stderr.txt']);
    expect(output.attachments[0].content.toString('utf8')).toBe('abcd');
    expect(output.notices).toHaveLength(1);
    expect(output.notices[0]).toContain('exceeds the 4-byte attachment limit');
  });

  it('keeps the readable output when the other stream is missing', () => {
    fs.writeFileSync(path.join(folder, 'partial.stdout'), 'kept');
    const output = collectOutputAttachments(folder, 'partial', 1024);
    expect(output.attachments.map((item) => item.filename)).toEqual(['stdout.txt']);
    expect(output.notices).toEqual(['stderr is not available and was not attached.']);
  });

  it('omits output that resolves outside the output folder', () => {
    const output = collectOutputAttachments(folder, `..${path.sep}escape`, 1024);
    expect(output.attachments).toEqual([]);
    expect(output.notices[0]).toContain('outside the output folder');
  });

  it('omits output that is not a regular file', () => {
    fs.mkdirSync(path.join(folder, 'dir.stdout'), { recursive: true });
    const output = collectOutputAttachments(folder, 'dir', 1024);
    expect(output.attachments).toEqual([]);
    expect(output.notices).toEqual(['stdout is not a regular file and was not attached.', 'stderr is not available and was not attached.']);
  });
});

describe('Mail delivery failure audit ownership', () => {
  function runMailer(operationId) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'crontab-ui-mailer.js'), 'unknown-job', operationId, 'failed', '10', '1'], {
        stdio: 'ignore',
      });
      child.once('exit', resolve);
    });
  }

  it('records a single failure event when the mailer reports the error itself', async () => {
    const operationId = 'operation-mailer-audit-once';
    const exitCode = await runMailer(operationId);
    expect(exitCode).toBe(1);

    const records = fs.readFileSync(crontab.audit_file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.operationId === operationId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: 'mail', jobId: 'unknown-job', status: 'failed' });
  });

  it('does not re-audit a mailer exit that the mailer already reported', () => {
    const operationId = 'operation-mailer-exit-not-duplicated';
    const child = new EventEmitter();
    crontab.watch_mailer_process(child, { operationId, jobId: 'job-exit' });
    child.emit('exit', 1, null);

    const records = fs.readFileSync(crontab.audit_file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.operationId === operationId);
    expect(records).toEqual([]);
  });

  it('audits a failure the parent alone can observe: the mailer not starting', () => {
    const operationId = 'operation-mailer-spawn-failure';
    const child = new EventEmitter();
    crontab.watch_mailer_process(child, { operationId, jobId: 'job-spawn' });
    child.emit('error', new Error('spawn ENOENT'));

    const records = fs.readFileSync(crontab.audit_file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.operationId === operationId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: 'mail', jobId: 'job-spawn', status: 'failed', reason: 'spawn_failed' });
  });
});

describe('Mail profile startup validation', () => {
  const original = process.env.MAIL_PROFILES_JSON;

  afterEach(() => {
    if (original === undefined) delete process.env.MAIL_PROFILES_JSON;
    else process.env.MAIL_PROFILES_JSON = original;
  });

  it('accepts a valid configuration and returns the usable profile ids', () => {
    process.env.MAIL_PROFILES_JSON = JSON.stringify({
      alerts: { transporter: 'smtps://smtp.example.test', from: 'cron@example.test', to: 'ops@example.test' },
    });
    expect(validateAllProfiles()).toEqual(['alerts']);
  });

  it('accepts a deployment with no mail profiles at all', () => {
    delete process.env.MAIL_PROFILES_JSON;
    expect(validateAllProfiles()).toEqual([]);
  });

  it('reports every invalid profile and names it, rather than the first one only', () => {
    process.env.MAIL_PROFILES_JSON = JSON.stringify({
      bad_transport: { transporter: 'http://smtp.example.test', from: 'cron@example.test', to: 'ops@example.test' },
      good: { transporter: 'smtps://smtp.example.test', from: 'cron@example.test', to: 'ops@example.test' },
      bad_recipients: { transporter: 'smtps://smtp.example.test', from: 'cron@example.test', to: [] },
    });
    expect(() => validateAllProfiles()).toThrow(/bad_transport:.*bad_recipients:/s);
  });

  it('rejects malformed configuration instead of silently ignoring it', () => {
    process.env.MAIL_PROFILES_JSON = 'not json';
    expect(() => validateAllProfiles()).toThrow('MAIL_PROFILES_JSON must be a JSON object');
  });

  it('rejects a profile id that no task could ever select', () => {
    process.env.MAIL_PROFILES_JSON = JSON.stringify({
      'not selectable': { transporter: 'smtps://smtp.example.test', from: 'cron@example.test', to: 'ops@example.test' },
    });
    expect(() => validateAllProfiles()).toThrow(/not selectable/);
  });

  it('constrains the accepted profile identifier', () => {
    expect(() => validateProfileId('../escape')).toThrow('Unknown or invalid mail profile');
    expect(validateProfileId('operations_1-a')).toBe('operations_1-a');
  });
});

describe('Mail profile delivery test', () => {
  function probeApp(result) {
    return createApp({ probeMailProfile: () => Promise.resolve(result) });
  }

  it('reports a delivered test without exposing profile configuration', async () => {
    const res = await request(probeApp({ ok: true, response: '250 Accepted' })).post('/test_mail_profile').send({ profileId: 'operations' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, category: 'delivered' });
    expect(res.text).not.toContain('mailer:password');
  });

  it('returns a failure category instead of the raw SMTP error', async () => {
    const res = await request(probeApp({ ok: false, category: 'auth_failed', error: '535 5.7.8 Error: authentication failed: user mailer' }))
      .post('/test_mail_profile').send({ profileId: 'operations' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, category: 'auth_failed' });
    expect(res.text).not.toContain('mailer');
  });

  it('rejects an unknown or malformed profile without contacting any server', async () => {
    let contacted = false;
    const app2 = createApp({ probeMailProfile: () => { contacted = true; return Promise.resolve({ ok: true }); } });
    expect((await request(app2).post('/test_mail_profile').send({ profileId: 'nope' })).status).toBe(404);
    expect((await request(app2).post('/test_mail_profile').send({ profileId: '../escape' })).status).toBe(400);
    expect((await request(app2).post('/test_mail_profile').send({})).status).toBe(400);
    expect(contacted).toBe(false);
  });

  it('rate limits repeated tests of the same profile', async () => {
    let calls = 0;
    const app2 = createApp({ probeMailProfile: () => { calls += 1; return Promise.resolve({ ok: true }); } });
    expect((await request(app2).post('/test_mail_profile').send({ profileId: 'operations' })).status).toBe(200);
    expect((await request(app2).post('/test_mail_profile').send({ profileId: 'operations' })).status).toBe(429);
    expect(calls).toBe(1);
  });

  it('is reserved to administrators and records the outcome in the audit trail', async () => {
    const res = await request(probeApp({ ok: true })).post('/test_mail_profile').send({ profileId: 'operations' });
    expect(res.status).toBe(200);
    const events = fs.readFileSync(crontab.audit_file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.requestId === res.headers['x-request-id']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'test_mail_profile', profileId: 'operations', result: 'delivered' });
  });

  it('classifies transport failures without carrying credentials through', () => {
    expect(categoriseFailure({ code: 'EAUTH', message: '535 authentication failed' })).toBe('auth_failed');
    expect(categoriseFailure({ code: 'EDNS', message: 'getaddrinfo ENOTFOUND smtp.example.test' })).toBe('dns');
    expect(categoriseFailure({ code: 'ETIMEDOUT', message: 'Connection timed out' })).toBe('timeout');
    expect(categoriseFailure({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.1:587' })).toBe('refused');
    expect(categoriseFailure({ code: 'EPROTO', message: 'SSL routines: wrong version number' })).toBe('tls');
    expect(categoriseFailure({ code: 'EOTHER', message: 'something unexpected' })).toBe('unavailable');
  });

  it('denies the test to an authenticated non-administrator', async () => {
    const originalUsers = process.env.BASIC_AUTH_USERS_JSON;
    const originalRoles = process.env.AUTHZ_ROLE_MAP_JSON;
    let contacted = false;
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ operator: 'operator-secret' });
    process.env.AUTHZ_ROLE_MAP_JSON = JSON.stringify({ operator: 'operator' });
    const operatorApp = createApp({ probeMailProfile: () => { contacted = true; return Promise.resolve({ ok: true }); } });
    const agent = request.agent(operatorApp);
    try {
      await agent.post('/login').send({ username: 'operator', password: 'operator-secret' }).expect(302);
      const res = await agent.post('/test_mail_profile').send({ profileId: 'operations' });
      expect(res.status).toBe(403);
      expect(contacted).toBe(false);
    } finally {
      if (originalUsers === undefined) delete process.env.BASIC_AUTH_USERS_JSON;
      else process.env.BASIC_AUTH_USERS_JSON = originalUsers;
      if (originalRoles === undefined) delete process.env.AUTHZ_ROLE_MAP_JSON;
      else process.env.AUTHZ_ROLE_MAP_JSON = originalRoles;
    }
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
  const environmentNames = ['NODE_ENV', 'ALLOW_HTTP', 'TRUSTED_PROXY', 'SSL_CERT', 'SSL_KEY',
    'ALLOW_INSECURE_NO_AUTH', 'BASIC_AUTH_USERS_JSON', 'AUTHZ_ROLE_MAP_JSON', 'CSRF_SECRET'];
  let originalEnvironment;

  beforeEach(() => {
    originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
    for (const name of environmentNames) delete process.env[name];
    process.env.NODE_ENV = 'production';
    process.env.CSRF_SECRET = 'test-csrf-secret';
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ admin: 'transport-secret' });
    process.env.AUTHZ_ROLE_MAP_JSON = JSON.stringify({ admin: 'admin' });
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

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

  it('accepts only the exact HTTP opt-in without relaxing other production checks', () => {
    expect(() => validateProductionTransport({ nodeEnv: 'production', allowHttp: 'true' })).not.toThrow();
    for (const allowHttp of ['false', 'TRUE', '1', true]) {
      expect(() => validateProductionTransport({ nodeEnv: 'production', allowHttp })).toThrow('requires SSL_CERT');
    }
    expect(() => validateProductionTransport({ nodeEnv: 'production', allowHttp: 'true', insecureBypass: true })).toThrow('not allowed');
    expect(() => validateProductionTransport({ nodeEnv: 'production', allowHttp: 'true', trustedProxy: 'anything' })).toThrow('TRUSTED_PROXY');
    process.env.ALLOW_HTTP = 'true';
    delete process.env.CSRF_SECRET;
    expect(() => createApp()).toThrow('CSRF_SECRET is required');
  });

  it('keeps HTTPS enforcement, secure cookies and transport headers by default', async () => {
    expect(() => createApp()).toThrow('requires SSL_CERT');
    process.env.TRUSTED_PROXY = 'loopback';
    const protectedApp = createApp();
    await rawRequest(protectedApp).get('/login').expect(426);
    process.env.ALLOW_HTTP = 'TRUE';
    await rawRequest(createApp()).get('/login').expect(426);
    delete process.env.ALLOW_HTTP;
    const page = await rawRequest(protectedApp).get('/login').set('X-Forwarded-Proto', 'https').expect(200);
    expect(page.headers['strict-transport-security']).toBeDefined();
    expect(page.headers['content-security-policy']).toContain('upgrade-insecure-requests');
    expect(page.headers['set-cookie'].find((cookie) => cookie.startsWith('crontab_ui_csrf='))).toContain('; Secure');
    const signedIn = await request(protectedApp).post('/login').set('X-Forwarded-Proto', 'https')
      .send({ username: 'admin', password: 'transport-secret' }).expect(302);
    expect(signedIn.headers['set-cookie'].find((cookie) => cookie.startsWith('crontab_ui_session='))).toContain('; Secure');
  });

  it('supports HTTP login and CSRF in production without trusting forwarded headers', async () => {
    process.env.ALLOW_HTTP = 'true';
    const protectedApp = createApp();
    expect(protectedApp.get('trust proxy')).toBe(false);
    const client = rawRequest.agent(protectedApp);
    const page = await client.get('/login').expect(200);
    expect(page.headers['strict-transport-security']).toBeUndefined();
    expect(page.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    const cookie = page.headers['set-cookie'].find((value) => value.startsWith('crontab_ui_csrf='));
    expect(cookie).not.toContain('; Secure');
    expect(cookie).toContain('SameSite=Strict');
    const token = decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('='));
    await client.post('/login').send({ username: 'admin', password: 'transport-secret' }).expect(403);
    const signedIn = await client.post('/login').set('X-CSRF-Token', token)
      .send({ username: 'admin', password: 'transport-secret' }).expect(302);
    const sessionCookie = signedIn.headers['set-cookie'].find((value) => value.startsWith('crontab_ui_session='));
    expect(sessionCookie).not.toContain('; Secure');
    expect(sessionCookie).toContain('HttpOnly; SameSite=Strict');
    await client.get('/').expect(200);
    await rawRequest(protectedApp).get('/').expect(401);
    await client.post('/stop').send({}).expect(403);
    await client.post('/logout').set('X-CSRF-Token', token).expect(302);
    await client.get('/').expect(401);
  });
});

describe('Job ownership authorization', () => {
  const originalRoles = process.env.AUTHZ_ROLE_MAP_JSON;
  const originalOperatorPrivileges = process.env.ALLOW_OPERATOR_TASK_EXECUTION;
  const requestFor = (user) => ({ app: { locals: { authEnabled: true } }, auth: { user } });

  beforeAll(() => {
    process.env.AUTHZ_ROLE_MAP_JSON = JSON.stringify({ alice: 'operator', bob: 'operator', viewer: 'viewer', executor: 'executor', admin: 'admin' });
    delete process.env.ALLOW_OPERATOR_TASK_EXECUTION;
  });
  afterAll(() => {
    if (originalRoles === undefined) delete process.env.AUTHZ_ROLE_MAP_JSON;
    else process.env.AUTHZ_ROLE_MAP_JSON = originalRoles;
    if (originalOperatorPrivileges === undefined) delete process.env.ALLOW_OPERATOR_TASK_EXECUTION;
    else process.env.ALLOW_OPERATOR_TASK_EXECUTION = originalOperatorPrivileges;
  });

  it('treats an operator as read-only until elevated task privileges are explicitly enabled', () => {
    expect(canAccessJob(requestFor('alice'), { owner: 'alice' }, 'write')).toBe(false);
    expect(canAccessJob(requestFor('alice'), { owner: 'alice' }, 'execute')).toBe(false);
    expect(canManageTasks(requestFor('alice'))).toBe(false);
  });

  it('allows an explicitly elevated operator to manage only owned jobs', () => {
    process.env.ALLOW_OPERATOR_TASK_EXECUTION = 'true';
    expect(canAccessJob(requestFor('alice'), { owner: 'alice' }, 'write')).toBe(true);
    expect(canAccessJob(requestFor('bob'), { owner: 'alice' }, 'write')).toBe(false);
    delete process.env.ALLOW_OPERATOR_TASK_EXECUTION;
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

  it('blocks task creation for a non-elevated operator', () => {
    let called = false;
    const response = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    requireSaveAccess(
      { body: { _id: '-1' }, app: { locals: { authEnabled: true } }, auth: { user: 'alice' } },
      response,
      () => { called = true; }
    );
    expect(called).toBe(false);
    expect(response.statusCode).toBe(403);
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

  it('replaces SQLite documents transactionally without renaming the active database file', () => {
    const file = path.join(testDbPath, `transactional-replace-${Date.now()}.db`);
    createDatabaseFile(file, [{ _id: 'old', name: 'old', command: 'echo old', schedule: '* * * * *', created: 1 }]);
    const datastore = new SqliteDatastore({ filename: file });
    datastore.replaceDocuments([{ _id: 'new', name: 'new', command: 'echo new', schedule: '0 * * * *', created: 2 }]);
    expect(datastore.getAllData()).toEqual([expect.objectContaining({ _id: 'new', command: 'echo new' })]);
    expect(fs.existsSync(file)).toBe(true);
    datastore.close();
  });
});

describe('CSRF middleware', () => {
  const originalEnvironment = process.env.NODE_ENV;

  afterAll(() => {
    process.env.NODE_ENV = originalEnvironment;
  });

  it('enforces CSRF even when NODE_ENV is test', () => {
    process.env.NODE_ENV = 'test';
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

describe('Session authentication middleware', () => {
  const originalUsers = process.env.BASIC_AUTH_USERS_JSON;
  const originalUser = process.env.BASIC_AUTH_USER;
  const originalPassword = process.env.BASIC_AUTH_PWD;
  const originalSessionTtl = process.env.AUTH_SESSION_TTL_MS;

  afterAll(() => {
    if (originalUsers === undefined) delete process.env.BASIC_AUTH_USERS_JSON;
    else process.env.BASIC_AUTH_USERS_JSON = originalUsers;
    if (originalUser === undefined) delete process.env.BASIC_AUTH_USER;
    else process.env.BASIC_AUTH_USER = originalUser;
    if (originalPassword === undefined) delete process.env.BASIC_AUTH_PWD;
    else process.env.BASIC_AUTH_PWD = originalPassword;
    if (originalSessionTtl === undefined) delete process.env.AUTH_SESSION_TTL_MS;
    else process.env.AUTH_SESSION_TTL_MS = originalSessionTtl;
  });

  // A stand-in for the persisted store, so these tests exercise the middleware contract without
  // the application database. The production store is covered by the datastore tests.
  function memorySessions() {
    const records = new Map();
    return {
      records,
      create: (session) => records.set(session.id, { ...session, revokedAt: null }),
      get: (id) => records.get(id) || null,
      revoke: (id, at) => { if (records.has(id)) records.set(id, { ...records.get(id), revokedAt: at }); },
      revokeUser: (user, at) => {
        let changed = 0;
        for (const record of records.values()) if (record.user === user && record.revokedAt === null) { records.set(record.id, { ...record, revokedAt: at }); changed += 1; }
        return changed;
      },
      prune: () => {},
    };
  }

  function authedApp(sessions) {
    const protectedApp = express();
    protectedApp.use(express.json());
    protectedApp.use(express.urlencoded({ extended: false }));
    setupAuth(protectedApp, { sessions });
    protectedApp.get('/protected', (req, res) => res.json({ user: req.auth.user }));
    return protectedApp;
  }

  it('refuses to run without a session store, since cookies could not be withdrawn', () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ reviewer: 'strong-secret' });
    const unprotected = express();
    expect(() => setupAuth(unprotected)).toThrow('session store is required');
  });

  it('rejects unauthenticated access and accepts configured credentials', async () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ reviewer: 'strong-secret' });
    delete process.env.BASIC_AUTH_USER;
    delete process.env.BASIC_AUTH_PWD;
    const protectedApp = authedApp(memorySessions());
    expect((await request(protectedApp).get('/protected')).status).toBe(401);
    const client = rawRequest.agent(protectedApp);
    await client.post('/login').send({ username: 'reviewer', password: 'strong-secret' }).expect(302);
    const allowed = await client.get('/protected');
    expect(allowed.status).toBe(200);
    expect(allowed.body.user).toBe('reviewer');

    await client.post('/logout').send({}).expect(302);
    expect((await client.get('/protected')).status).toBe(401);
  });

  it('stops accepting a copy of the cookie taken before sign-out', async () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ reviewer: 'strong-secret' });
    const sessions = memorySessions();
    const protectedApp = authedApp(sessions);

    const signedIn = await request(protectedApp).post('/login')
      .send({ username: 'reviewer', password: 'strong-secret' }).expect(302);
    const cookie = signedIn.headers['set-cookie'].find((value) => value.startsWith('crontab_ui_session=')).split(';')[0];

    // A stolen copy of the cookie, kept by someone else.
    const thief = rawRequest.agent(protectedApp);
    expect((await thief.get('/protected').set('Cookie', cookie)).status).toBe(200);

    await request(protectedApp).post('/logout').set('Cookie', cookie).expect(302);
    // This is what signing out could not do before: the copy stops working at once.
    expect((await thief.get('/protected').set('Cookie', cookie)).status).toBe(401);
  });

  it('keeps other sessions of the same user valid until each one is ended', async () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ reviewer: 'strong-secret' });
    const sessions = memorySessions();
    const protectedApp = authedApp(sessions);

    const first = rawRequest.agent(protectedApp);
    await first.post('/login').send({ username: 'reviewer', password: 'strong-secret' }).expect(302);
    const second = rawRequest.agent(protectedApp);
    const secondLogin = await second.post('/login').send({ username: 'reviewer', password: 'strong-secret' }).expect(302);
    const secondCookie = secondLogin.headers['set-cookie'].find((value) => value.startsWith('crontab_ui_session=')).split(';')[0];
    expect(sessions.records.size).toBe(2);
    expect((await first.get('/protected')).status).toBe(200);

    // Ending access for the account withdraws every browser it was open in, which signing out of
    // one of them cannot do on its own.
    sessions.revokeUser('reviewer', Date.now());
    expect((await first.get('/protected')).status).toBe(401);
    expect((await second.get('/protected').set('Cookie', secondCookie)).status).toBe(401);
  });

  it('rejects a cookie whose session record was never created', async () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ reviewer: 'strong-secret' });
    const sessions = memorySessions();
    const protectedApp = authedApp(sessions);
    const signedIn = await request(protectedApp).post('/login')
      .send({ username: 'reviewer', password: 'strong-secret' }).expect(302);
    const cookie = signedIn.headers['set-cookie'].find((value) => value.startsWith('crontab_ui_session=')).split(';')[0];
    sessions.records.clear();

    expect((await request(protectedApp).get('/protected').set('Cookie', cookie)).status).toBe(401);
  });

  it('treats a store that cannot be read as no session rather than trusting the signature', async () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ reviewer: 'strong-secret' });
    const sessions = memorySessions();
    const protectedApp = authedApp(sessions);
    const signedIn = await request(protectedApp).post('/login')
      .send({ username: 'reviewer', password: 'strong-secret' }).expect(302);
    const cookie = signedIn.headers['set-cookie'].find((value) => value.startsWith('crontab_ui_session=')).split(';')[0];

    sessions.get = () => { throw new Error('database is locked'); };
    expect((await request(protectedApp).get('/protected').set('Cookie', cookie)).status).toBe(401);
  });

  it('rejects a tampered session cookie', async () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ reviewer: 'strong-secret' });
    const protectedApp = authedApp(memorySessions());

    const signedIn = await request(protectedApp).post('/login')
      .send({ username: 'reviewer', password: 'strong-secret' }).expect(302);
    const sessionCookie = signedIn.headers['set-cookie'].find((value) => value.startsWith('crontab_ui_session='));
    const sessionToken = sessionCookie.split(';')[0];
    const tamperedCookie = `${sessionToken.slice(0, -1)}x`;

    expect((await request(protectedApp).get('/protected').set('Cookie', tamperedCookie)).status).toBe(401);
  });

  it('rejects an expired session cookie', async () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ reviewer: 'strong-secret' });
    process.env.AUTH_SESSION_TTL_MS = '60000';
    const protectedApp = authedApp(memorySessions());

    const originalNow = Date.now;
    const issuedAt = originalNow();
    try {
      Date.now = () => issuedAt;
      const signedIn = await request(protectedApp).post('/login')
        .send({ username: 'reviewer', password: 'strong-secret' }).expect(302);
      const sessionCookie = signedIn.headers['set-cookie'].find((value) => value.startsWith('crontab_ui_session='));
      Date.now = () => issuedAt + 60_001;

      expect((await request(protectedApp).get('/protected').set('Cookie', sessionCookie)).status).toBe(401);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe('Login abuse protection', () => {
  const originalUsers = process.env.BASIC_AUTH_USERS_JSON;
  const originalRoles = process.env.AUTHZ_ROLE_MAP_JSON;
  const originalLimit = process.env.LOGIN_RATE_LIMIT_MAX;
  const originalWindow = process.env.LOGIN_RATE_LIMIT_WINDOW_MS;

  afterAll(() => {
    if (originalUsers === undefined) delete process.env.BASIC_AUTH_USERS_JSON;
    else process.env.BASIC_AUTH_USERS_JSON = originalUsers;
    if (originalRoles === undefined) delete process.env.AUTHZ_ROLE_MAP_JSON;
    else process.env.AUTHZ_ROLE_MAP_JSON = originalRoles;
    if (originalLimit === undefined) delete process.env.LOGIN_RATE_LIMIT_MAX;
    else process.env.LOGIN_RATE_LIMIT_MAX = originalLimit;
    if (originalWindow === undefined) delete process.env.LOGIN_RATE_LIMIT_WINDOW_MS;
    else process.env.LOGIN_RATE_LIMIT_WINDOW_MS = originalWindow;
  });

  it('warns on the final failed sign-in attempt and rate-limits the next attempt', async () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ reviewer: 'strong-secret' });
    process.env.AUTHZ_ROLE_MAP_JSON = JSON.stringify({ reviewer: 'viewer' });
    process.env.LOGIN_RATE_LIMIT_MAX = '3';
    process.env.LOGIN_RATE_LIMIT_WINDOW_MS = '120000';
    const protectedApp = createApp();

    expect((await request(protectedApp).post('/login').send({ username: 'reviewer', password: 'incorrect' })).status).toBe(401);
    expect((await request(protectedApp).post('/login').send({ username: 'reviewer', password: 'incorrect' })).status).toBe(401);
    expect((await request(protectedApp).post('/login').send({ username: 'reviewer', password: 'strong-secret' })).status).toBe(302);

    // The successful login clears the prior two failures for this source IP.
    expect((await request(protectedApp).post('/login').send({ username: 'reviewer', password: 'incorrect' })).status).toBe(401);
    expect((await request(protectedApp).post('/login').send({ username: 'reviewer', password: 'incorrect' })).status).toBe(401);
    const finalAttempt = await request(protectedApp).post('/login').send({ username: 'reviewer', password: 'incorrect' });
    expect(finalAttempt.status).toBe(401);
    expect(finalAttempt.text).toContain('Try again in 2 minutes.');

    const blocked = await request(protectedApp).post('/login').send({ username: 'reviewer', password: 'incorrect' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toBe('Too many sign-in attempts. Try again in 2 minutes.');
  });
});

describe('Sign-in with a stored digest', () => {
  const originalUsers = process.env.BASIC_AUTH_USERS_JSON;
  const originalRoles = process.env.AUTHZ_ROLE_MAP_JSON;

  afterAll(() => {
    if (originalUsers === undefined) delete process.env.BASIC_AUTH_USERS_JSON;
    else process.env.BASIC_AUTH_USERS_JSON = originalUsers;
    if (originalRoles === undefined) delete process.env.AUTHZ_ROLE_MAP_JSON;
    else process.env.AUTHZ_ROLE_MAP_JSON = originalRoles;
  });

  it('accepts the password for a stored digest and rejects anything else', async () => {
    const digest = await hashPassword('correct-horse');
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ admin: digest });
    process.env.AUTHZ_ROLE_MAP_JSON = JSON.stringify({ admin: 'admin' });
    const digestApp = createApp();

    // Each sign-in attempt carries its own CSRF token, exactly as the login form submits it.
    async function attempt(agent, body) {
      const page = await agent.get('/login');
      const cookie = page.headers['set-cookie'].find((value) => value.startsWith('crontab_ui_csrf='));
      const token = decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('='));
      return agent.post('/login').set('Cookie', cookie).set('X-CSRF-Token', token).send(body);
    }

    expect((await attempt(rawRequest.agent(digestApp), { username: 'admin', password: 'incorrect' })).status).toBe(401);
    expect((await attempt(rawRequest.agent(digestApp), { username: 'absent', password: 'correct-horse' })).status).toBe(401);

    const client = rawRequest.agent(digestApp);
    expect((await attempt(client, { username: 'admin', password: 'correct-horse' })).status).toBe(302);
    expect((await client.get('/')).status).toBe(200);
  });
});

describe('Execution history retention', () => {
  // Task inserts are asynchronous while the retention queries are synchronous, so the job has to
  // be committed before pruning or the orphan sweep would see no tasks at all.
  async function withStore(fn) {
    const filename = path.join(testDbPath, `retention-${crypto.randomUUID()}.db`);
    const store = new SqliteDatastore({ filename });
    const now = Date.now();
    await new Promise((resolve, reject) => {
      store.insert({ _id: 'j1', name: 'retained', command: 'echo', schedule: '* * * * *', created: now }, (error) => (error ? reject(error) : resolve()));
    });
    for (let i = 0; i < 5; i += 1) {
      store.createExecution({
        operationId: `op-${i}`, jobId: 'j1', trigger: 'scheduled', status: 'completed',
        exitCode: 0, durationMs: 5, startedAt: now - i, completedAt: now - i,
      });
    }
    try {
      return await fn(store, now);
    } finally {
      store.close();
      fs.unlinkSync(filename);
    }
  }

  it('keeps the most recent records for a task and drops the rest', async () => {
    await withStore((store, now) => {
      store.pruneExecutions(now - 86_400_000, 2);
      expect(store.listExecutions('j1', 50).map((row) => row.operationId)).toEqual(['op-0', 'op-1']);
    });
  });

  it('lets the age window take precedence over the per-task cap', async () => {
    await withStore((store, now) => {
      store.pruneExecutions(now + 86_400_000, 10);
      expect(store.listExecutions('j1', 50)).toHaveLength(0);
    });
  });

  // A cap that reaches SQLite as NaN binds as NULL, the row-number comparison matches nothing,
  // and the NOT IN would then select every record. This is the shape that silently wiped the
  // history when EXECUTION_HISTORY_PER_JOB was set to a value that is not a number.
  it('refuses an unusable per-task cap instead of deleting the history', async () => {
    for (const cap of [Number('abc'), 0, -1, null, undefined, 1.5, Number.NaN]) {
      await withStore((store, now) => {
        store.pruneExecutions(now - 86_400_000, cap);
        expect(store.listExecutions('j1', 50), `cap ${String(cap)}`).toHaveLength(5);
      });
    }
  });

  it('drops alert state for a task that no longer exists', async () => {
    await withStore((store, now) => {
      store.recordAlert('ghost', now, 3);
      store.recordAlert('j1', now, 1);
      expect(store.getAlertState('ghost')).not.toBeNull();
      store.pruneExecutions(now - 86_400_000, 10);
      expect(store.getAlertState('ghost')).toBeNull();
      expect(store.getAlertState('j1')).not.toBeNull();
    });
  });
});

describe('Failure alert policy', () => {
  it('keeps a task that never used these settings byte-identical to before', () => {
    expect(normaliseMailing({ profileId: 'operations' })).toEqual({ profileId: 'operations', policy: 'onFailure' });
    expect(normaliseMailing({})).toEqual({});
    expect(normaliseMailing(undefined)).toEqual({});
  });

  it('stores only the values the operator actually chose', () => {
    expect(normaliseMailing({ profileId: 'operations', alertAfterFailures: 3 }))
      .toEqual({ profileId: 'operations', policy: 'onFailure', alertAfterFailures: 3 });
    expect(normaliseMailing({ profileId: 'operations', alertCooldownMinutes: 0 }).alertCooldownMinutes).toBe(0);
  });

  it('rejects thresholds outside the supported range', () => {
    for (const value of [0, -1, 101, 1.5, 'abc', {}]) {
      expect(() => normaliseMailing({ profileId: 'operations', alertAfterFailures: value })).toThrow(/alertAfterFailures/);
    }
    expect(() => normaliseMailing({ profileId: 'operations', alertCooldownMinutes: 10081 })).toThrow(/alertCooldownMinutes/);
  });

  it('rejects a threshold without a profile to alert through', () => {
    expect(() => normaliseMailing({ alertAfterFailures: 3 })).toThrow(/requires a profileId/);
    expect(() => normaliseMailing({ policy: 'onFailure', alertCooldownMinutes: 5 })).toThrow(/requires a profileId/);
  });

  it('rejects an unknown notification field rather than dropping it', () => {
    expect(() => normaliseMailing({ profileId: 'operations', retries: 3 })).toThrow('mailing contains unsupported fields');
  });

  it('stays silent until the failure threshold is reached', () => {
    const mailing = { alertAfterFailures: 3 };
    expect(failureAlertDue(mailing, { consecutiveFailures: 1, lastAlertAt: null })).toEqual({ send: false, reason: 'below_failure_threshold' });
    expect(failureAlertDue(mailing, { consecutiveFailures: 2, lastAlertAt: null })).toEqual({ send: false, reason: 'below_failure_threshold' });
    expect(failureAlertDue(mailing, { consecutiveFailures: 3, lastAlertAt: null })).toEqual({ send: true, reason: null });
    expect(failureAlertDue(mailing, { consecutiveFailures: 9, lastAlertAt: null }).send).toBe(true);
  });

  it('holds further alerts during the cooldown', () => {
    const mailing = { alertAfterFailures: 2, alertCooldownMinutes: 60 };
    const now = 1_700_000_000_000;
    const justAlerted = now - 60_000;
    expect(failureAlertDue(mailing, { consecutiveFailures: 3, lastAlertAt: justAlerted, now }).send).toBe(false);
    expect(failureAlertDue(mailing, { consecutiveFailures: 3, lastAlertAt: now - 61 * 60_000, now }).send).toBe(true);
    expect(failureAlertDue(mailing, { consecutiveFailures: 3, lastAlertAt: now, now: now, }).send).toBe(false);
  });

  it('treats a zero cooldown as no cooldown at all', () => {
    const mailing = { alertAfterFailures: 1, alertCooldownMinutes: 0 };
    const now = 1_700_000_000_000;
    expect(failureAlertDue(mailing, { consecutiveFailures: 1, lastAlertAt: now, now }).send).toBe(true);
  });

  it('falls back to alerting on the first failure and hourly when unset', () => {
    const now = 1_700_000_000_000;
    expect(failureAlertDue({}, { consecutiveFailures: 1, lastAlertAt: null, now }).send).toBe(true);
    expect(failureAlertDue({}, { consecutiveFailures: 1, lastAlertAt: now - 59 * 60_000, now }).send).toBe(false);
    expect(failureAlertDue({}, { consecutiveFailures: 1, lastAlertAt: now - 61 * 60_000, now }).send).toBe(true);
  });
});

describe('Alert behaviour across a real run sequence', () => {
  let spawned;

  beforeEach(() => {
    spawned = [];
    crontab.set_mailer_dispatcher((args) => {
      spawned.push({ jobId: args[0], operationId: args[1], outcome: args[2] });
      return new EventEmitter();
    });
  });

  afterEach(() => {
    crontab.set_mailer_dispatcher(null);
  });

  function createJob(mailing, command = 'exit 1') {
    return new Promise((resolve, reject) => {
      crontab.create_new('alert-seq', command, '* * * * *', false, mailing, {}, (error, job) => (error ? reject(error) : resolve(job)));
    });
  }

  function runJob(job) {
    return new Promise((resolve) => crontab.runjob(job._id, {}, () => resolve()));
  }

  function setCommand(job, command) {
    return new Promise((resolve, reject) => crontab.update(job._id, {
      name: job.name, command, schedule: job.schedule, logging: false, mailing: job.mailing,
    }, (error) => (error ? reject(error) : resolve())));
  }

  it('does not alert on the first failure when a threshold of three is set', async () => {
    const job = await createJob({ profileId: 'operations', policy: 'onFailure', alertAfterFailures: 3, alertCooldownMinutes: 60 });
    await runJob(job);
    await runJob(job);
    expect(spawned).toHaveLength(0);
    await runJob(job);
    expect(spawned).toHaveLength(1);
  });

  it('sends a single alert for a continuing failure inside the cooldown', async () => {
    const job = await createJob({ profileId: 'operations', policy: 'onFailure', alertAfterFailures: 1, alertCooldownMinutes: 60 });
    for (let i = 0; i < 6; i += 1) await runJob(job);
    expect(spawned).toHaveLength(1);
  });

  it('alerts again after a success, because the cooldown belonged to a finished incident', async () => {
    const job = await createJob({ profileId: 'operations', policy: 'onFailure', alertAfterFailures: 1, alertCooldownMinutes: 60 });
    await runJob(job);
    expect(spawned).toHaveLength(1);
    await setCommand(job, 'echo recovered');
    await runJob(job);
    expect(spawned).toHaveLength(1);
    await setCommand(job, 'exit 1');
    await runJob(job);
    expect(spawned).toHaveLength(2);
  });

  it('reports the alert state in the panel so a deliberate silence is legible', async () => {
    const job = await createJob({ profileId: 'operations', policy: 'onFailure', alertAfterFailures: 1, alertCooldownMinutes: 60 });
    const before = crontab.getExecutionPanel(job);
    expect(before.alert).toBeNull();
    await runJob(job);
    const after = crontab.getExecutionPanel(job);
    expect(after.alert).toMatchObject({ jobId: job._id });
    expect(after.alert.alertedAtFailures).toBe(1);
  });

  it('forgets the alert state when the task is removed', async () => {
    const job = await createJob({ profileId: 'operations', policy: 'onFailure' });
    await runJob(job);
    expect(crontab.getExecutionPanel(job).alert).not.toBeNull();
    await new Promise((resolve) => crontab.remove(job._id, resolve));
    expect(crontab.getExecutionPanel(job).alert).toBeNull();
  });
});

describe('Per-task routes with authentication enabled', () => {
  const originalUsers = process.env.BASIC_AUTH_USERS_JSON;
  const originalRoles = process.env.AUTHZ_ROLE_MAP_JSON;

  afterAll(() => {
    if (originalUsers === undefined) delete process.env.BASIC_AUTH_USERS_JSON;
    else process.env.BASIC_AUTH_USERS_JSON = originalUsers;
    if (originalRoles === undefined) delete process.env.AUTHZ_ROLE_MAP_JSON;
    else process.env.AUTHZ_ROLE_MAP_JSON = originalRoles;
  });

  async function signedInAdmin() {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ admin: 'admin-secret' });
    process.env.AUTHZ_ROLE_MAP_JSON = JSON.stringify({ admin: 'admin' });
    const authedApp = createApp();
    const client = request.agent(authedApp);
    await client.post('/login').send({ username: 'admin', password: 'admin-secret' }).expect(302);
    return { authedApp, client };
  }

  // A GET carries no body, and body-parser 2.x leaves req.body undefined in that case. These
  // routes all read the task id from the body or the query, so they used to raise a TypeError
  // before their own validation whenever authentication was enabled.
  it('serves the log and execution routes for a signed-in administrator', async () => {
    const { client } = await signedInAdmin();
    const job = await new Promise((resolve, reject) => crontab.create_new(
      'authed-read', 'echo authed-read', '* * * * *', true, {}, {}, (error, created) => (error ? reject(error) : resolve(created))
    ));

    for (const route of ['/logger', '/stdout', '/executions']) {
      const res = await client.get(route).query({ id: job._id });
      expect(res.status, `${route} answered ${res.status}`).toBe(200);
    }
    expect((await client.get('/executions').query({ id: job._id })).body).toMatchObject({ jobId: job._id });
  });

  it('answers a missing or malformed task id instead of raising an error', async () => {
    const { client } = await signedInAdmin();
    expect((await client.get('/executions')).status).toBe(400);
    expect((await client.get('/logger')).status).toBe(400);
    expect((await client.get('/executions').query({ id: '../escape' })).status).toBe(400);
    expect((await client.get('/executions').query({ id: 'inexistente' })).status).toBe(404);
  });

  it('accepts a state-changing request that carries no body', async () => {
    const { client } = await signedInAdmin();
    const res = await client.post('/stop').set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
  });
});

describe('Login client IP trust', () => {
  const originalUsers = process.env.BASIC_AUTH_USERS_JSON;
  const originalRoles = process.env.AUTHZ_ROLE_MAP_JSON;
  const originalLimit = process.env.LOGIN_RATE_LIMIT_MAX;
  const originalProxy = process.env.TRUSTED_PROXY;

  afterAll(() => {
    if (originalUsers === undefined) delete process.env.BASIC_AUTH_USERS_JSON;
    else process.env.BASIC_AUTH_USERS_JSON = originalUsers;
    if (originalRoles === undefined) delete process.env.AUTHZ_ROLE_MAP_JSON;
    else process.env.AUTHZ_ROLE_MAP_JSON = originalRoles;
    if (originalLimit === undefined) delete process.env.LOGIN_RATE_LIMIT_MAX;
    else process.env.LOGIN_RATE_LIMIT_MAX = originalLimit;
    if (originalProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = originalProxy;
  });

  it('uses the forwarded client IP only when the direct proxy is trusted', async () => {
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ reviewer: 'strong-secret' });
    process.env.AUTHZ_ROLE_MAP_JSON = JSON.stringify({ reviewer: 'viewer' });
    process.env.LOGIN_RATE_LIMIT_MAX = '1';
    process.env.TRUSTED_PROXY = 'loopback';
    const protectedApp = createApp();

    const firstClient = '198.51.100.10';
    const otherClient = '198.51.100.11';
    expect((await request(protectedApp).post('/login').set('X-Forwarded-For', firstClient)
      .send({ username: 'reviewer', password: 'incorrect' })).status).toBe(401);
    expect((await request(protectedApp).post('/login').set('X-Forwarded-For', otherClient)
      .send({ username: 'reviewer', password: 'incorrect' })).status).toBe(401);
    expect((await request(protectedApp).post('/login').set('X-Forwarded-For', firstClient)
      .send({ username: 'reviewer', password: 'incorrect' })).status).toBe(429);
  });
});

describe('Review and publish HTTP flow', () => {
  const originalEnvironment = process.env.NODE_ENV;
  const originalUsers = process.env.BASIC_AUTH_USERS_JSON;
  const originalRoles = process.env.AUTHZ_ROLE_MAP_JSON;

  afterAll(() => {
    if (originalEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment;
    if (originalUsers === undefined) delete process.env.BASIC_AUTH_USERS_JSON;
    else process.env.BASIC_AUTH_USERS_JSON = originalUsers;
    if (originalRoles === undefined) delete process.env.AUTHZ_ROLE_MAP_JSON;
    else process.env.AUTHZ_ROLE_MAP_JSON = originalRoles;
  });

  it('requires authenticated admin CSRF confirmation before publishing from the review action', async () => {
    process.env.NODE_ENV = 'development';
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ admin: 'review-secret' });
    process.env.AUTHZ_ROLE_MAP_JSON = JSON.stringify({ admin: 'admin' });
    const suffix = crypto.randomUUID();
    const job = await new Promise((resolve, reject) => crontab.create_new(
      `http-publish-${suffix}`, `echo http-publish-${suffix}`, '* * * * *', false, {},
      { owner: 'admin', createdBy: 'admin' }, (error, created) => (error ? reject(error) : resolve(created))
    ));
    let publishedFile;
    const protectedApp = createApp({
      setCrontab: (environment, callback) => crontab.set_crontab(environment, callback, (file, applied) => {
        publishedFile = file;
        applied(null);
      }),
    });
    const client = rawRequest.agent(protectedApp);
    const loginPage = await client.get('/login');
    const cookie = loginPage.headers['set-cookie'].find((value) => value.startsWith('crontab_ui_csrf='));
    const token = decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('='));
    await client.post('/login').set('Cookie', cookie).set('X-CSRF-Token', token)
      .send({ username: 'admin', password: 'review-secret' }).expect(302);

    const rejected = await client.post('/crontab').send({ env_vars: 'PATH=/usr/bin' });
    expect(rejected.status).toBe(403);

    const published = await client.post('/crontab')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ env_vars: 'PATH=/usr/bin' });
    expect(published.status).toBe(200);
    expect(fs.readFileSync(publishedFile, 'utf8')).toContain(job._id);

    const persisted = await new Promise((resolve) => crontab.get_crontab(job._id, (error, job) => resolve(job)));
    expect(persisted).toMatchObject({ saved: true, needsPublishReview: false });
    const operationId = published.headers['x-request-id'];
    const auditEntries = fs.readFileSync(crontab.audit_file, 'utf8').trim().split('\n').map(JSON.parse);
    expect(auditEntries).toContainEqual(expect.objectContaining({
      operationId, operation: 'apply_crontab', actor: 'admin', outcome: 'completed', status: 200,
    }));
  });
});

describe('Administrative data boundaries', () => {
  const originalUsers = process.env.BASIC_AUTH_USERS_JSON;
  const originalRoles = process.env.AUTHZ_ROLE_MAP_JSON;
  const originalNodeEnvironment = process.env.NODE_ENV;
  const originalEnvironment = fs.existsSync(crontab.env_file) ? fs.readFileSync(crontab.env_file, 'utf8') : null;

  afterAll(() => {
    if (originalUsers === undefined) delete process.env.BASIC_AUTH_USERS_JSON;
    else process.env.BASIC_AUTH_USERS_JSON = originalUsers;
    if (originalRoles === undefined) delete process.env.AUTHZ_ROLE_MAP_JSON;
    else process.env.AUTHZ_ROLE_MAP_JSON = originalRoles;
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
    if (originalEnvironment === null) fs.rmSync(crontab.env_file, { force: true });
    else fs.writeFileSync(crontab.env_file, originalEnvironment);
  });

  it('does not expose global configuration or administrative operations to a viewer', async () => {
    process.env.NODE_ENV = 'development';
    process.env.BASIC_AUTH_USERS_JSON = JSON.stringify({ viewer: 'viewer-secret', admin: 'admin-secret' });
    process.env.AUTHZ_ROLE_MAP_JSON = JSON.stringify({ viewer: 'viewer', admin: 'admin' });
    fs.writeFileSync(crontab.env_file, 'ADMIN_ONLY_VALUE=not-for-viewers');
    const protectedApp = createApp();
    const viewer = request.agent(protectedApp);

    const loginPage = await viewer.get('/login');
    const cookie = loginPage.headers['set-cookie'].find((value) => value.startsWith('crontab_ui_csrf='));
    const token = decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('='));
    await viewer.post('/login').set('Cookie', cookie).set('X-CSRF-Token', token)
      .send({ username: 'viewer', password: 'viewer-secret' }).expect(302);
    const page = await viewer.get('/');
    expect(page.status).toBe(200);
    expect(page.text).not.toContain('ADMIN_ONLY_VALUE=not-for-viewers');
    expect(page.text).not.toContain('>Backups<');
    expect((await viewer.get('/export')).status).toBe(403);
    expect((await viewer.get('/preview_crontab')).status).toBe(403);
    expect((await viewer.get('/restore?db=backup-2026-01-01.db')).status).toBe(403);
  });
});

describe('Application bootstrap', () => {
  it('creates isolated applications and exposes a closable HTTP server', async () => {
    const anotherApp = createApp();
    expect(anotherApp).not.toBe(app);
    anotherApp.set('port', 0);
    const server = startServer(anotherApp);
    await new Promise((resolve) => server.once('listening', resolve));
    expect(server.listening).toBe(true);
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it('exports the builders without building an application on require', () => {
    const exported = require('../app');
    expect(Object.keys(exported).sort()).toEqual(['createApp', 'startServer']);
    // A default application would be callable as an Express request handler.
    expect(typeof exported).toBe('object');
    expect(exported).not.toBe(app);
  });
});

afterAll(() => {
  crontab.close_db();
  fs.rmSync(testDbPath, { recursive: true, force: true });
});
