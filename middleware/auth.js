'use strict';

const crypto = require('crypto');
const { verifyPassword, isValidDigestFormat, identifyForeignDigest } = require('../config/passwords');

const SESSION_COOKIE = 'crontab_ui_session';
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function configuredUsers() {
  const raw = process.env.BASIC_AUTH_USERS_JSON;
  if (!raw) return null;

  let users;
  try {
    users = JSON.parse(raw);
  } catch (_error) {
    throw new Error('BASIC_AUTH_USERS_JSON must be a JSON object of users');
  }

  if (!users || Array.isArray(users) || typeof users !== 'object' || Object.keys(users).length === 0
    || Object.entries(users).some(([user, password]) => !user || typeof password !== 'string' || !password)) {
    throw new Error('BASIC_AUTH_USERS_JSON must contain non-empty user names and passwords');
  }
  // A value that looks like a digest must be a well formed one, otherwise a truncated or
  // mistyped hash would leave the account permanently unable to sign in with no explanation.
  for (const [user, password] of Object.entries(users)) {
    if (password.startsWith('scrypt:') && !isValidDigestFormat(password)) {
      throw new Error(`BASIC_AUTH_USERS_JSON contains a malformed password digest for user ${user}`);
    }
    // A hash from another tool would be compared as literal text, so the account could never sign
    // in and nothing would say why. Naming the algorithm at startup is the only useful moment.
    const foreign = identifyForeignDigest(password);
    if (foreign) {
      throw new Error(`BASIC_AUTH_USERS_JSON stores a password in an unsupported format for user ${user}: ${foreign} digest. Generate one with npx crontab-ui-hash.`);
    }
  }
  return users;
}

function authenticatedUsers() {
  const user = process.env.BASIC_AUTH_USER;
  const pwd = process.env.BASIC_AUTH_PWD;
  return configuredUsers() || (user && pwd ? { [user]: pwd } : null);
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '').split(';').map((entry) => {
      const index = entry.indexOf('=');
      return index === -1 ? [] : [entry.slice(0, index).trim(), decodeURIComponent(entry.slice(index + 1).trim())];
    }).filter((entry) => entry.length)
  );
}

function sessionTtl() {
  const configured = Number(process.env.AUTH_SESSION_TTL_MS || DEFAULT_SESSION_TTL_MS);
  if (!Number.isSafeInteger(configured) || configured < 60_000 || configured > 7 * 24 * 60 * 60 * 1000) {
    throw new Error('AUTH_SESSION_TTL_MS must be between 60000 and 604800000');
  }
  return configured;
}

function cookieOptions({ maxAge = null } = {}) {
  const secure = process.env.NODE_ENV === 'production' && process.env.ALLOW_HTTP !== 'true' ? '; Secure' : '';
  const maxAgePart = maxAge === null ? '' : `; Max-Age=${Math.floor(maxAge / 1000)}`;
  return `Path=/; HttpOnly; SameSite=Strict${secure}${maxAgePart}`;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function issueSession(res, user, secret, ttl, sessionId) {
  const payload = Buffer.from(JSON.stringify({ sid: sessionId, user, expiresAt: Date.now() + ttl })).toString('base64url');
  const token = `${payload}.${sign(payload, secret)}`;
  res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieOptions({ maxAge: ttl })}`);
}

// The signature proves the cookie was issued by this service; the stored record proves it has not
// been withdrawn. A store that cannot be read is treated as no session at all, because accepting
// the request would mean falling back to trusting the signature alone.
function readSession(req, secret, sessions) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !token.includes('.')) return null;
  const separator = token.lastIndexOf('.');
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(signature, sign(payload, secret))) return null;
  let claimed;
  try {
    claimed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (_error) {
    return null;
  }
  if (!claimed || typeof claimed.user !== 'string' || !Number.isSafeInteger(claimed.expiresAt) || claimed.expiresAt <= Date.now()) return null;
  if (typeof claimed.sid !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(claimed.sid)) return null;
  let record;
  try {
    record = sessions.get(claimed.sid);
  } catch (error) {
    console.error(`Unable to read the session record: ${error.message}`);
    return null;
  }
  if (!record || record.revokedAt !== null) return null;
  if (record.user !== claimed.user || record.expiresAt <= Date.now()) return null;
  return { user: record.user, sid: record.id, expiresAt: record.expiresAt };
}

function isLocalPath(value, baseUrl) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return false;
  return !baseUrl || value === baseUrl || value.startsWith(`${baseUrl}/`);
}

function redirectPath(req, baseUrl) {
  const requestPath = `${req.baseUrl || ''}${req.path || '/'}`;
  return isLocalPath(requestPath, baseUrl) ? requestPath : (baseUrl || '/');
}

function setupAuth(app, { baseUrl = '', resetLoginRateLimit = () => {}, sessions, audit = () => {} } = {}) {
  const users = authenticatedUsers();
  if (!users) return false;
  if (!sessions || typeof sessions.create !== 'function' || typeof sessions.get !== 'function') {
    // Without a store the cookie could not be withdrawn, which is exactly the property that was
    // missing. Refusing to start is better than silently serving sessions that cannot be revoked.
    throw new Error('A session store is required when authentication is enabled');
  }

  const secret = process.env.AUTH_SESSION_SECRET || process.env.CSRF_SECRET || crypto.randomBytes(32).toString('base64url');
  const ttl = sessionTtl();
  const loginPath = `${baseUrl}/login`;
  const logoutPath = `${baseUrl}/logout`;
  const currentSession = (req) => readSession(req, secret, sessions);

  function renderLogin(req, res, status = 200, error = null) {
    return res.status(status).render('login', {
      csrfToken: req.csrfToken || '',
      error,
      returnTo: isLocalPath(req.query.returnTo, baseUrl)
        ? req.query.returnTo
        : (baseUrl || '/'),
    });
  }

  app.get(loginPath, (req, res) => {
    if (currentSession(req)) return res.redirect(baseUrl || '/');
    return renderLogin(req, res);
  });

  app.post(loginPath, async (req, res, next) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    let accepted = false;
    try {
      // The verification runs even for an unknown user, so a wrong username and a wrong password
      // take a comparable amount of time and do not disclose which accounts exist.
      accepted = await verifyPassword(password, users[username]);
    } catch (error) {
      return next(error);
    }
    if (!users[username] || !accepted) {
      const attemptsExhausted = Number(req.rateLimit?.remaining) === 0;
      const minutes = res.locals.loginRateLimitMinutes || 1;
      const error = attemptsExhausted
        ? (res.locals.t ? res.locals.t('loginRateLimited', { minutes }) : `Too many sign-in attempts. Try again in ${minutes} minutes.`)
        : (res.locals.t ? res.locals.t('invalidCredentials') : 'Invalid username or password.');
      return renderLogin(req, res, 401, error);
    }
    const now = Date.now();
    const sessionId = crypto.randomBytes(24).toString('base64url');
    try {
      sessions.prune(now);
      sessions.create({ id: sessionId, user: username, issuedAt: now, expiresAt: now + ttl });
    } catch (error) {
      // Refusing to issue a session the store does not know about is the only safe outcome: a
      // cookie without a record would be permanently unrevocable.
      console.error(`Unable to create a session record: ${error.message}`);
      return next(error);
    }
    issueSession(res, username, secret, ttl, sessionId);
    audit({ type: 'auth', action: 'sign_in', user: username, sourceIp: req.ip });
    resetLoginRateLimit(req);
    const returnTo = isLocalPath(req.body?.returnTo, baseUrl)
      ? req.body.returnTo
      : (baseUrl || '/');
    return res.redirect(returnTo);
  });

  app.post(logoutPath, (req, res) => {
    // Withdrawing the record is what makes signing out mean something. Clearing the cookie alone
    // left any copy of it working until it expired.
    const session = currentSession(req);
    if (session) {
      try {
        sessions.revoke(session.sid, Date.now());
        audit({ type: 'auth', action: 'sign_out', user: session.user, sourceIp: req.ip });
      } catch (error) {
        console.error(`Unable to revoke the session record: ${error.message}`);
      }
    }
    res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions({ maxAge: 0 })}`);
    return res.redirect(loginPath);
  });

  app.use((req, res, next) => {
    const session = currentSession(req);
    if (session && Object.hasOwn(users, session.user)) {
      req.auth = { user: session.user, sessionId: session.sid };
      return next();
    }
    if (req.method === 'GET' && String(req.get('Accept') || '').includes('text/html')) {
      return res.redirect(`${loginPath}?returnTo=${encodeURIComponent(redirectPath(req, baseUrl))}`);
    }
    return res.status(401).json({ message: 'Authentication required' });
  });

  return true;
}

module.exports = setupAuth;
module.exports.configuredUsers = configuredUsers;
module.exports.authenticatedUsers = authenticatedUsers;
module.exports.SESSION_COOKIE = SESSION_COOKIE;
