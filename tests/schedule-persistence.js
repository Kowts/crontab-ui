'use strict';

/* global describe, it, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { persistSchedule, persistedScheduleFile, restoreSchedule } = require('../lib/schedule-store');

let workDir;
beforeEach(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-store-')); });
afterEach(() => { fs.rmSync(workDir, { recursive: true, force: true }); });

describe('Persisted schedule', () => {
  it('restores the published schedule after the scheduler file is lost', () => {
    const data = path.join(workDir, 'data');
    const cronFile = path.join(workDir, 'cron', 'node');
    fs.mkdirSync(path.dirname(cronFile), { recursive: true });
    fs.writeFileSync(cronFile, '* * * * * echo hi\n');
    persistSchedule(data, 'node', cronFile);

    fs.writeFileSync(cronFile, '');
    expect(restoreSchedule(data, 'node', cronFile)).toBe('restored');
    expect(fs.readFileSync(cronFile, 'utf8')).toBe('* * * * * echo hi\n');
    expect(restoreSchedule(data, 'node', cronFile)).toBe('unchanged');
  });

  it('does nothing when no schedule was ever persisted', () => {
    expect(restoreSchedule(path.join(workDir, 'data'), 'node', path.join(workDir, 'node'))).toBe('absent');
  });

  it('never installs a persisted schedule that fails validation', () => {
    const data = path.join(workDir, 'data');
    const cronFile = path.join(workDir, 'node');
    fs.mkdirSync(path.dirname(persistedScheduleFile(data, 'node')), { recursive: true });
    fs.writeFileSync(persistedScheduleFile(data, 'node'), 'corrupted\u0000');
    fs.writeFileSync(cronFile, '* * * * * echo keep\n');

    expect(() => restoreSchedule(data, 'node', cronFile, {
      validate: () => { throw new Error('invalid schedule'); },
    })).toThrow('invalid schedule');
    expect(fs.readFileSync(cronFile, 'utf8')).toBe('* * * * * echo keep\n');
  });
});

function runInCrontab(script, env = {}) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 20000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', ...env },
  });
  const lines = result.stdout.trim().split('\n').filter((line) => line.startsWith('{'));
  return { ...result, json: JSON.parse(lines[lines.length - 1] || 'null') };
}

describe('Publication and recovery failures', () => {
  const publish = `
    const crontab = require('./crontab');
    const fs = require('fs');
    const run = (apply) => new Promise((resolve) => crontab.set_crontab('', (error) => resolve(error ? error.message : null), apply));
    (async () => {
      await new Promise((resolve) => crontab.create_new('job', 'echo 1', '* * * * *', false, {}, {}, resolve));
      const cronFile = process.env.CRON_PATH + '/node';
      const persisted = process.env.CRON_DB_PATH + '/schedule/node';
      const out = {};
      out.firstError = await run((_file, done) => done(null));
      out.firstPersisted = fs.existsSync(persisted) ? fs.readFileSync(persisted, 'utf8') : null;
      await new Promise((resolve) => crontab.create_new('second', 'echo 2', '*/5 * * * *', false, {}, {}, resolve));
      out.lostAckError = await run((_file, done) => done(new Error('Scheduler did not confirm reload')));
      out.afterFailurePersisted = fs.readFileSync(persisted, 'utf8');
      out.afterFailureCron = fs.readFileSync(cronFile, 'utf8');
      out.unpublished = await new Promise((resolve) => crontab.crontabs((tabs) => resolve(tabs.filter((t) => !t.saved).length)));
      console.log(JSON.stringify(out));
      process.exit(0);
    })();
  `;

  it('persists a confirmed schedule and keeps it when a later reload is not acknowledged', () => {
    const cron = path.join(workDir, 'cron');
    const result = runInCrontab(publish, { CRON_DB_PATH: path.join(workDir, 'data'), CRON_PATH: cron, CRON_IN_DOCKER: 'true' });
    expect(result.status).toBe(0);
    expect(result.json.firstError).toBeNull();
    expect(result.json.firstPersisted).toContain('* * * * *');
    expect(result.json.lostAckError).toContain('did not confirm');
    expect(result.json.afterFailurePersisted).toBe(result.json.firstPersisted);
    expect(result.json.afterFailureCron).toBe(result.json.firstPersisted);
    expect(result.json.unpublished).toBeGreaterThan(0);
  });

  it('keeps the local backup and audits the failure when the external copy cannot be written', () => {
    const blocked = path.join(workDir, 'not-a-directory');
    fs.writeFileSync(blocked, 'file');
    const result = runInCrontab(`
      const crontab = require('./crontab');
      crontab.backup((error, name) => {
        const audit = require('fs').readFileSync(crontab.audit_file, 'utf8');
        console.log(JSON.stringify({ error: error && error.message, name, audit }));
        process.exit(0);
      });
    `, { CRON_DB_PATH: path.join(workDir, 'data'), CRON_PATH: path.join(workDir, 'cron'), BACKUP_EXTERNAL_DIR: path.join(blocked, 'inner') });
    expect(result.json.error).toBeFalsy();
    expect(result.json.name).toMatch(/^backup-.*\.db$/);
    expect(result.json.audit).toContain('"backup_external"');
    expect(result.json.audit).toContain('"failed"');
  });

  it('fails a backup cleanly, leaving no partial file, when the data volume is not writable', () => {
    const data = path.join(workDir, 'data');
    const result = runInCrontab(`
      const fs = require('fs');
      const crontab = require('./crontab');
      const original = fs.renameSync;
      fs.renameSync = (from, to) => { if (String(to).includes('backup-')) { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; } return original(from, to); };
      crontab.backup((error) => {
        console.log(JSON.stringify({ error: error && error.message, leftovers: fs.readdirSync(crontab.db_folder).filter((f) => f.startsWith('.backup-') || f.startsWith('backup-')) }));
        process.exit(0);
      });
    `, { CRON_DB_PATH: data, CRON_PATH: path.join(workDir, 'cron') });
    expect(result.json.error).toContain('ENOSPC');
    expect(result.json.leftovers).toEqual([]);
  });
});
