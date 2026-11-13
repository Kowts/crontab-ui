'use strict';

/* global describe, it, expect */
const { createWatchdog, parseWebhookUrl, startWatchdog } = require('../lib/alerting');

describe('External scheduler heartbeat', () => {
  const { schedulerHealth } = require('../lib/scheduler-health');
  const heartbeat = (age) => ({ maxAgeMs: 20000, read: () => age });

  it('reports a fresh heartbeat as running and a stale or missing one as stopped', () => {
    expect(schedulerHealth({ inDocker: true, heartbeat: heartbeat(3000) })).toMatchObject({ running: true, external: true });
    expect(schedulerHealth({ inDocker: true, heartbeat: heartbeat(60000) }).running).toBe(false);
    expect(schedulerHealth({ inDocker: true, heartbeat: heartbeat(null) }).running).toBe(false);
  });
});

describe('Operational alerts', () => {
  it('notifies once when a condition starts failing and once when it recovers', () => {
    let problem = null;
    const alerts = [];
    const watchdog = createWatchdog({ checks: { scheduler: () => problem }, notify: (alert) => alerts.push(alert) });

    watchdog.check();
    problem = 'scheduler not running';
    watchdog.check();
    watchdog.check();
    expect(watchdog.failing()).toEqual(['scheduler']);
    problem = null;
    watchdog.check();
    expect(alerts).toEqual([
      { condition: 'scheduler', state: 'firing', detail: 'scheduler not running' },
      { condition: 'scheduler', state: 'resolved' },
    ]);
  });

  it('treats a throwing check as a failing condition', () => {
    const alerts = [];
    createWatchdog({ checks: { audit: () => { throw new Error('boom'); } }, notify: (a) => alerts.push(a) }).check();
    expect(alerts[0]).toMatchObject({ condition: 'audit', state: 'firing', detail: 'boom' });
  });

  it('audits, logs and posts the webhook for scheduler and audit failures', () => {
    const audits = [];
    const posts = [];
    const state = { scheduler: { running: false }, audit: { ok: false, lastError: 'ENOSPC' } };
    startWatchdog({
      health: () => state,
      audit: (event) => audits.push(event),
      env: { ALERT_WEBHOOK_URL: 'https://alerts.example.test/hook' },
      post: (url, payload) => { posts.push({ url: url.href, payload }); return Promise.resolve(); },
      intervalMs: 3600000,
    }).stop();
    expect(audits.map((a) => a.condition)).toEqual(['scheduler', 'audit']);
    expect(posts).toHaveLength(2);
    expect(posts[0].url).toBe('https://alerts.example.test/hook');
    expect(posts[1].payload).toMatchObject({ service: 'crontab-ui', condition: 'audit', state: 'firing' });
  });

  it('accepts only http(s) webhook URLs', () => {
    expect(parseWebhookUrl('')).toBeNull();
    expect(() => parseWebhookUrl('file:///etc/passwd')).toThrow('http or https');
  });
});
