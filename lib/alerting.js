'use strict';

const http = require('http');
const https = require('https');

function parseWebhookUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('ALERT_WEBHOOK_URL must use http or https');
  return url;
}

function postWebhook(url, payload, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST',
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (response) => {
      response.resume();
      response.on('end', () => (response.statusCode < 400 ? resolve() : reject(new Error(`Webhook responded ${response.statusCode}`))));
    });
    request.on('timeout', () => request.destroy(new Error('Webhook timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

// Reports each condition once when it starts failing and once when it recovers, so a scheduler
// that stays down does not produce an alert on every check.
function createWatchdog({ checks, notify }) {
  const failing = new Set();
  return {
    check() {
      for (const [name, evaluate] of Object.entries(checks)) {
        let problem = null;
        try {
          problem = evaluate();
        } catch (error) {
          problem = error.message;
        }
        if (problem && !failing.has(name)) {
          failing.add(name);
          notify({ condition: name, state: 'firing', detail: problem });
        } else if (!problem && failing.has(name)) {
          failing.delete(name);
          notify({ condition: name, state: 'resolved' });
        }
      }
    },
    failing: () => [...failing],
  };
}

function startWatchdog({ health, audit, env = process.env, post = postWebhook, intervalMs = 30000 }) {
  const webhook = parseWebhookUrl(env.ALERT_WEBHOOK_URL);
  const watchdog = createWatchdog({
    checks: {
      scheduler: () => (health().scheduler.running === false ? (health().scheduler.reason || 'scheduler not running') : null),
      audit: () => (health().audit.ok ? null : `audit log not writable: ${health().audit.lastError}`),
    },
    notify(alert) {
      console.error(`ALERT ${alert.state} ${alert.condition}${alert.detail ? `: ${alert.detail}` : ''}`);
      audit({ type: 'alert', status: alert.state, condition: alert.condition, detail: alert.detail });
      if (!webhook) return;
      post(webhook, { service: 'crontab-ui', timestamp: new Date().toISOString(), ...alert })
        .catch((error) => console.error(`Unable to deliver alert webhook: ${error.message}`));
    },
  });
  watchdog.check();
  const timer = setInterval(() => watchdog.check(), intervalMs);
  timer.unref();
  return { watchdog, stop: () => clearInterval(timer) };
}

module.exports = { createWatchdog, parseWebhookUrl, postWebhook, startWatchdog };
