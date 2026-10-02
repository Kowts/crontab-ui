'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'crontab_ui_csrf';
const secret = process.env.CSRF_SECRET || crypto.randomBytes(32).toString('hex');

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map((entry) => {
      const index = entry.indexOf('=');
      return index === -1
        ? []
        : [entry.slice(0, index).trim(), decodeURIComponent(entry.slice(index + 1).trim())];
    }).filter((entry) => entry.length)
  );
}

function sign(token) {
  return `${token}.${crypto.createHmac('sha256', secret).update(token).digest('base64url')}`;
}

function valid(value) {
  if (!value || !value.includes('.')) return false;
  const token = value.slice(0, value.lastIndexOf('.'));
  const expected = sign(token);
  const actual = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function issueToken(req, res) {
  const token = sign(crypto.randomBytes(24).toString('base64url'));
  const secure = process.env.NODE_ENV === 'production' && process.env.ALLOW_HTTP !== 'true' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; SameSite=Strict${secure}`);
  req.csrfToken = token;
  if (res.locals) res.locals.csrfToken = token;
}

function csrfProtection(req, res, next) {
  const cookieToken = cookies(req)[COOKIE_NAME];
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!valid(cookieToken)) issueToken(req, res);
    else {
      req.csrfToken = cookieToken;
      if (res.locals) res.locals.csrfToken = cookieToken;
    }
    return next();
  }

  const submittedToken = req.get('X-CSRF-Token') || req.body?._csrf;
  if (!valid(cookieToken) || !submittedToken || !valid(submittedToken) || submittedToken !== cookieToken) {
    return res.status(403).json({ message: 'Invalid CSRF token' });
  }
  req.csrfToken = cookieToken;
  if (res.locals) res.locals.csrfToken = cookieToken;
  return next();
}

module.exports = csrfProtection;
