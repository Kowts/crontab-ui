'use strict';

const nodemailer = require('nodemailer');
const { getProfile } = require('./mail-profiles');

// Transport failures are reported to the browser as a category, never as the raw driver message:
// SMTP errors routinely quote the server response, which can include the username, the rejected
// recipient, or the advertised hostname. The full detail belongs in the server-side audit log.
const FAILURE_CATEGORIES = [
  { code: 'auth_failed', pattern: /auth|credential|password|5\d\d\s|login failed/i },
  { code: 'tls', pattern: /ssl|tls|certificate|self.signed|EPROTO|ERR_TLS/i },
  { code: 'dns', pattern: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i },
  { code: 'refused', pattern: /ECONNREFUSED|ECONNRESET|EPIPE|disconnect/i },
  { code: 'timeout', pattern: /ETIMEDOUT|ESOCKET|timeout|timed out/i },
  { code: 'rejected', pattern: /rejected|blocked|not allowed|550|551|552|553|554/i },
];

const CATEGORY_ORDER = ['auth_failed', 'tls', 'dns', 'refused', 'timeout', 'rejected'];

function categoriseFailure(error) {
  const text = `${error && error.code ? error.code : ''} ${error && error.message ? error.message : ''}`;
  const match = FAILURE_CATEGORIES.find((category) => category.pattern.test(text));
  return match ? match.code : 'unavailable';
}

function testTransporter(transporter, mail) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      transporter.sendMail(mail, (error, info) => {
        if (error) return settle({ ok: false, category: categoriseFailure(error), error: error.message });
        return settle({ ok: true, response: String(info && info.response ? info.response : '').slice(0, 256) });
      });
    } catch (error) {
      settle({ ok: false, category: categoriseFailure(error), error: error.message });
    }
  });
}

// Sends a fixed test message to the recipients already defined by the server-side profile. No
// address, subject, or body content is accepted from the request, so the action cannot be used to
// send mail anywhere else or to reflect content back to the browser.
async function sendTestMessage(profileId) {
  const profile = getProfile(profileId);
  const transporter = nodemailer.createTransport(profile.transporter, {
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  const result = await testTransporter(transporter, {
    from: profile.from,
    to: profile.to,
    subject: 'Crontab UI mail profile test',
    text: 'This message confirms that the Crontab UI mail profile is configured and reachable.',
  });
  if (transporter.close) transporter.close();
  return result;
}

module.exports = { sendTestMessage, categoriseFailure, CATEGORY_ORDER };
