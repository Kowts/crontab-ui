'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const mime = require('mime-types');
const dayjs = require('dayjs');
const relativeTime = require('dayjs/plugin/relativeTime');
const busboy = require('connect-busboy');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const crontab = require('./crontab');
const restore = require('./restore');
const packageJson = require('./package.json');
const { base_url: baseUrl, routes } = require('./routes');
const setupAuth = require('./middleware/auth');
const { authenticatedUsers } = require('./middleware/auth');
const { configuredRoles, requireRole, validateRoleAssignments } = require('./middleware/authorization');
const csrfProtection = require('./middleware/csrf');
const errorHandler = require('./middleware/error');
const {
  validateBackupParam,
  validateIdParam,
  validateEnvironmentPayload,
  validateImportMetadata,
} = require('./middleware/validate');
const { getProfile, listProfileIds, validateAllProfiles, validateProfileId } = require('./config/mail-profiles');
const { normaliseMailing } = require('./config/alert-policy');
const { requireBoundedNumber } = require('./config/limits');
const { sendTestMessage } = require('./config/mail-probe');
const { validateProductionTransport } = require('./config/transport');
const { canAccessJob, requireJobAccess, requireSaveAccess, canManageTasks, canExecuteTasks } = require('./middleware/job-authorization');
const { dictionaries, localeFromRequest, normalizeLocale, translate } = require('./config/i18n');

dayjs.extend(relativeTime);

function createApp({ setCrontab = crontab.set_crontab, probeMailProfile = sendTestMessage } = {}) {
const app = express();
app.locals.baseURL = baseUrl;
app.set('host', process.env.HOST || '127.0.0.1');
app.set('port', process.env.PORT || 8000);

const credentials = {
  key: process.env.SSL_KEY ? fs.readFileSync(process.env.SSL_KEY) : '',
  cert: process.env.SSL_CERT ? fs.readFileSync(process.env.SSL_CERT) : '',
};
if ((credentials.key && !credentials.cert) || (credentials.cert && !credentials.key)) {
  throw new Error('Please provide both SSL_KEY and SSL_CERT');
}
const startHttpsServer = credentials.key && credentials.cert;
app.locals.tlsCredentials = startHttpsServer ? credentials : null;
const trustedProxy = process.env.TRUSTED_PROXY;
const allowHttp = process.env.ALLOW_HTTP === 'true';
validateProductionTransport({
  nodeEnv: process.env.NODE_ENV,
  nativeTls: startHttpsServer,
  trustedProxy,
  insecureBypass: process.env.ALLOW_INSECURE_NO_AUTH === 'true',
  allowHttp: process.env.ALLOW_HTTP,
});
if (trustedProxy) app.set('trust proxy', trustedProxy);

const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(app.get('host'));

// Sign-in throttling is a security limit, so a mistyped value must stop the service rather than
// be silently replaced by a weaker one.
function boundedEnvironmentNumber(name, fallback, minimum, maximum) {
  const configured = requireBoundedNumber(name, minimum, maximum);
  return configured === undefined ? fallback : configured;
}

app.get(`${baseUrl}/healthz`, (req, res) => {
  const address = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return res.sendStatus(404);
  return res.json({ status: 'ok' });
});
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !allowHttp && !req.secure) {
    return res.status(426).json({ message: 'HTTPS is required' });
  }
  return next();
});
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  const startedAt = Date.now();
  res.once('finish', () => {
    // Authentication and authorization failures occur before route middleware.
    if ([401, 403].includes(res.statusCode)) {
      crontab.audit({
        type: 'http_request',
        operationId: req.requestId,
        requestId: req.requestId,
        operation: 'access_denied',
        actor: req.auth?.user || null,
        sourceIp: req.ip,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        outcome: 'denied',
        durationMs: Date.now() - startedAt,
      });
    }
  });
  next();
});
const authEnabled = Boolean(authenticatedUsers());
app.locals.authEnabled = authEnabled;
if (authEnabled) validateRoleAssignments(authenticatedUsers(), configuredRoles());
if (process.env.NODE_ENV === 'production' && !process.env.CSRF_SECRET) {
  throw new Error('CSRF_SECRET is required in production');
}
if (!authEnabled && !isLoopback && process.env.ALLOW_INSECURE_NO_AUTH !== 'true') {
  throw new Error('BASIC_AUTH_USER and BASIC_AUTH_PWD are required when HOST is not loopback');
}
// A profile that cannot be delivered must fail the deployment, not the first task that selects it.
validateAllProfiles();

// Security headers: all browser assets are served locally, including third-party libraries.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      upgradeInsecureRequests: allowHttp ? null : [],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  strictTransportSecurity: process.env.NODE_ENV !== 'production' || allowHttp ? false : undefined,
}));

function serializeForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' }));
// body-parser 2.x leaves req.body undefined for a request with no body or no recognised content
// type, where earlier versions set it to an empty object. Every handler below reads req.body
// directly, so a plain GET would otherwise raise a TypeError before reaching its own validation.
// Normalising once here keeps that assumption true for all routes, including future ones.
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  return next();
});
app.use(busboy({ limits: { files: 1, fileSize: 1024 * 1024, fields: 10 } }));
app.use(csrfProtection);
app.use((req, res, next) => {
  const locale = localeFromRequest(req);
  res.locals.locale = locale;
  res.locals.t = (key, values) => translate(locale, key, values);
  next();
});

// The public root also serves its own css, js, images and fonts subdirectories.
app.use(baseUrl, express.static(path.join(__dirname, 'public')));
app.use(`${baseUrl}/vendor/cronstrue`, express.static(path.join(__dirname, 'node_modules', 'cronstrue', 'dist')));

// Static assets are cacheable and do not consume the quota reserved for application operations.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Failed sign-in attempts need a tighter quota than normal application traffic.
// A successful sign-in resets the source-IP counter so a legitimate user is not
// penalised by earlier typing mistakes.
const loginRateLimitWindowMs = boundedEnvironmentNumber('LOGIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
const loginRateLimitMax = boundedEnvironmentNumber('LOGIN_RATE_LIMIT_MAX', 10, 1, 1000);
const loginRateLimitMinutes = Math.ceil(loginRateLimitWindowMs / 60_000);
const loginRateLimitStore = new rateLimit.MemoryStore();
const loginRateLimitKey = (req) => rateLimit.ipKeyGenerator(req.ip);

app.use(routes.login, (req, res, next) => {
  res.locals.loginRateLimitMinutes = loginRateLimitMinutes;
  next();
}, rateLimit({
  windowMs: loginRateLimitWindowMs,
  max: loginRateLimitMax,
  store: loginRateLimitStore,
  keyGenerator: loginRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method !== 'POST',
  handler: (req, res) => {
    const message = res.locals.t
      ? res.locals.t('loginRateLimited', { minutes: loginRateLimitMinutes })
      : `Too many sign-in attempts. Try again in ${loginRateLimitMinutes} minutes.`;
    if (String(req.get('Accept') || '').includes('text/html')) {
      return res.status(429).render('login', { csrfToken: req.csrfToken || '', error: message, returnTo: baseUrl || '/' });
    }
    return res.status(429).json({ message });
  },
}));

// Authentication is installed after static assets and CSRF protection so the
// sign-in page can load its local styling and safely submit credentials.
setupAuth(app, {
  baseUrl,
  sessions: crontab.sessions,
  audit: (event) => crontab.audit(event),
  resetLoginRateLimit: (req) => loginRateLimitStore.resetKey(loginRateLimitKey(req)),
});

// --- Routes ---

function commandFingerprint(command) {
  return typeof command === 'string'
    ? crypto.createHash('sha256').update(command).digest('hex')
    : undefined;
}

function auditOperation(operation, resource = () => ({})) {
  return (req, res, next) => {
    const startedAt = Date.now();
    res.once('finish', () => {
      const details = resource(req);
      crontab.audit({
        type: 'http_operation',
        operationId: req.requestId,
        requestId: req.requestId,
        operation,
        actor: req.auth?.user || (app.locals.authEnabled ? null : 'local'),
        role: req.auth?.user ? configuredRoles()[req.auth.user] || null : null,
        sourceIp: req.ip,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        outcome: res.statusCode < 400 ? 'completed' : 'failed',
        durationMs: Date.now() - startedAt,
        ...details,
      });
    });
    next();
  };
}

app.get(routes.root, requireRole('viewer'), (req, res) => {
  crontab.crontabs((docs) => {
    docs = docs.filter((job) => canAccessJob(req, job, 'read'));
    const currentRole = app.locals.authEnabled ? configuredRoles()[req.auth?.user] : 'admin';
    const isAdmin = currentRole === 'admin';
    docs = docs.map((job) => ({
      ...job,
      permissions: {
        execute: canAccessJob(req, job, 'execute'),
        write: canAccessJob(req, job, 'write'),
      },
    }));
    res.render('index', {
      routes: serializeForHtml(routes),
      crontabs: serializeForHtml(docs),
      backups: isAdmin ? crontab.get_backup_names() : [],
      env: serializeForHtml(isAdmin ? crontab.get_env() : ''),
      currentRole,
      canManageTasks: canManageTasks(req),
      canExecuteTasks: canExecuteTasks(req),
      dayjs,
      messages: serializeForHtml(dictionaries[res.locals.locale]),
      mailProfileIds: listProfileIds(),
      csrfToken: req.csrfToken || '',
    });
  });
});

app.post(routes.locale, requireRole('viewer'), (req, res) => {
  if (!['en', 'pt'].includes(req.body.locale)) return res.status(400).json({ message: 'Invalid locale' });
  res.cookie('crontab_ui_locale', normalizeLocale(req.body.locale), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && !allowHttp,
    path: baseUrl || '/',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
  return res.status(204).end();
});

app.post(routes.save, requireRole('operator'), requireSaveAccess, auditOperation('save_job', (req) => ({
  jobId: typeof req.body._id === 'string' ? req.body._id : null,
  commandSha256: commandFingerprint(req.body.command),
})), (req, res) => {
  const { name, command, schedule } = req.body;
  let mailing = req.body.mailing === undefined ? {} : req.body.mailing;
  if (typeof mailing === 'string') {
    try {
      mailing = JSON.parse(mailing);
    } catch (_error) {
      return res.status(400).json({ message: 'Invalid job payload' });
    }
  }
  // URL-encoded browser form data represents the creation sentinel as "-1".
  const isCreate = req.body._id === -1 || req.body._id === '-1';
  const isUpdate = typeof req.body._id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(req.body._id);
  if (!isCreate && !isUpdate) {
    return res.status(400).json({ message: 'Invalid job id' });
  }
  if (typeof name !== 'string' || name.length > 128 || /[\r\n]/.test(name)
    || typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\r\n]/.test(command)
    || typeof schedule !== 'string' || schedule.length > 128 || /[\r\n]/.test(schedule)
    || typeof mailing !== 'object' || mailing === null) {
    return res.status(400).json({ message: 'Invalid job payload' });
  }
  // The accepted fields, the bounds and the stored shape all come from one place, so a task can
  // never be saved with a notification setting the run path would not honour.
  try {
    mailing = normaliseMailing(mailing);
  } catch (_error) {
    return res.status(400).json({ message: 'Invalid job payload' });
  }
  try {
    if (schedule !== '@reboot') require('cron-parser').CronExpressionParser.parse(schedule);
    if (mailing.profileId) {
      getProfile(mailing.profileId);
    }
  } catch (_error) {
    return res.status(400).json({ message: 'Invalid cron schedule or mail profile' });
  }
  if (isCreate) {
    const owner = req.auth?.user || 'local';
    crontab.create_new(req.body.name, req.body.command, req.body.schedule, req.body.logging, mailing, { owner, createdBy: owner }, (err) => {
      if (err) return res.status(500).json({ message: 'Unable to save job' });
      return res.end();
    });
  } else {
    crontab.update(req.body._id, { ...req.body, mailing }, (err) => {
      if (err) return res.status(500).json({ message: 'Unable to save job' });
      return res.end();
    });
  }
});

app.post(routes.stop, requireRole('operator'), validateIdParam, requireJobAccess('write'), auditOperation('stop_job', (req) => ({ jobId: req.body._id })), (req, res) => {
  crontab.status(req.body._id, true, (err) => {
    if (err) return res.status(500).json({ message: 'Unable to stop job' });
    return res.json({ id: req.body._id, stopped: true });
  });
});

app.post(routes.start, requireRole('operator'), validateIdParam, requireJobAccess('write'), auditOperation('start_job', (req) => ({ jobId: req.body._id })), (req, res) => {
  crontab.status(req.body._id, false, (err) => {
    if (err) return res.status(500).json({ message: 'Unable to start job' });
    return res.json({ id: req.body._id, stopped: false });
  });
});

app.post(routes.remove, requireRole('operator'), validateIdParam, requireJobAccess('write'), auditOperation('remove_job', (req) => ({ jobId: req.body._id })), (req, res) => {
  crontab.remove(req.body._id, (err) => {
    if (err) return res.status(500).json({ message: 'Unable to remove job' });
    return res.end();
  });
});

app.post(routes.run, requireRole('executor'), validateIdParam, requireJobAccess('execute'), auditOperation('request_run_job', (req) => ({ jobId: req.body._id })), (req, res) => {
  crontab.startManualRun(req.body._id, {
    requestId: req.requestId,
    actor: req.auth?.user || (app.locals.authEnabled ? null : 'local'),
    sourceIp: req.ip,
  }, (err, result) => {
    if (err) return res.status(err.statusCode || 500).json({ message: err.message || 'Job execution failed' });
    return res.status(202).json(result);
  });
});

app.get(routes.run_status, requireRole('viewer'), (req, res) => {
  const operationId = String(req.query.operationId || '');
  const run = crontab.getManualRun(operationId);
  if (!run) return res.status(404).json({ message: 'Execution not found' });
  return crontab.get_crontab(run.jobId, (error, job) => {
    if (error) return res.status(500).json({ message: 'Unable to read the task' });
    if (!job || !canAccessJob(req, job, 'read')) return res.status(403).json({ message: 'Not authorized for this job' });
    return res.json(run);
  });
});

app.post(routes.cancel_run, requireRole('executor'), (req, res) => {
  const operationId = String(req.body.operationId || '');
  const run = crontab.getManualRun(operationId);
  if (!run) return res.status(404).json({ message: 'Execution not found' });
  return crontab.get_crontab(run.jobId, (error, job) => {
    if (error) return res.status(500).json({ message: 'Unable to read the task' });
    if (!job || !canAccessJob(req, job, 'execute')) return res.status(403).json({ message: 'Not authorized for this job' });
    const cancelled = crontab.cancelManualRun(operationId, { requestId: req.requestId, actor: req.auth?.user || 'local', sourceIp: req.ip });
    if (!cancelled) return res.status(409).json({ message: 'Execution is no longer active' });
    return res.status(202).json(cancelled);
  });
});

app.post(routes.crontab, requireRole('admin'), validateEnvironmentPayload, auditOperation('apply_crontab'), (req, res, next) => {
  setCrontab(req.jobEnvironment, (err) => {
    if (err) next(err);
    else res.end();
  });
});

app.post(routes.backup, requireRole('admin'), auditOperation('create_backup'), (req, res, next) => {
  crontab.backup((err) => {
    if (err) next(err);
    else res.end();
  });
});

// A profile test performs a real delivery, so it is rate limited per profile to keep the action
// from being usable as a way to flood the configured recipients.
const mailTestCooldownMs = 15_000;
const lastMailTest = new Map();

app.post(routes.test_mail_profile, requireRole('admin'), auditOperation('test_mail_profile', (req) => ({
  profileId: typeof req.body.profileId === 'string' ? req.body.profileId : null,
  result: req.mailTestResult || null,
})), async (req, res) => {
  const profileId = req.body.profileId;
  if (typeof profileId !== 'string') return res.status(400).json({ message: 'Invalid mail profile' });
  try {
    validateProfileId(profileId);
  } catch (_error) {
    return res.status(400).json({ message: 'Invalid mail profile' });
  }
  if (!listProfileIds().includes(profileId)) return res.status(404).json({ message: 'Unknown mail profile' });
  const now = Date.now();
  const attemptedAt = lastMailTest.get(profileId) || 0;
  if (now - attemptedAt < mailTestCooldownMs) {
    return res.status(429).json({ message: 'A test was already sent for this profile. Try again shortly.' });
  }
  lastMailTest.set(profileId, now);

  let result;
  try {
    result = await probeMailProfile(profileId);
  } catch (_error) {
    // getProfile already passed at startup and on the check above, so this is an unexpected
    // internal failure. Report it without echoing driver detail back to the browser.
    return res.status(502).json({ message: 'Unable to test the mail profile' });
  }
  if (result.ok) {
    req.mailTestResult = 'delivered';
    return res.json({ ok: true, category: 'delivered' });
  }
  req.mailTestResult = result.category;
  return res.status(502).json({ ok: false, category: result.category });
});

app.get(routes.restore, requireRole('admin'), validateBackupParam, (req, res) => {
  if (!crontab.get_backup_names().includes(req.dbName)) return res.status(404).json({ message: 'Backup not found' });
  restore.crontabs(req.dbName, (docs) => {
    res.render('restore', {
      routes: serializeForHtml(routes),
      crontabs: serializeForHtml(docs),
      backups: crontab.get_backup_names(),
      db: req.dbName,
      messages: serializeForHtml(dictionaries[res.locals.locale]),
    });
  });
});

app.post(routes.delete_backup, requireRole('admin'), validateBackupParam, auditOperation('delete_backup', (req) => ({ backup: req.dbName })), (req, res, next) => {
  crontab.delete_backup(req.dbName, (err) => {
    if (err) return next(err);
    return res.end();
  });
});

app.post(routes.restore_backup, requireRole('admin'), validateBackupParam, auditOperation('restore_backup', (req) => ({ backup: req.dbName })), (req, res) => {
  return crontab.restore(req.dbName, (err) => {
    if (err) return res.status(err.statusCode || 500).json({ message: 'Unable to restore backup' });
    return res.end();
  });
});

app.get(routes.export, requireRole('admin'), (req, res) => {
  const file = crontab.crontab_db_file;
  const filename = path.basename(file);
  const mimetype = mime.lookup(file);

  res.setHeader('Content-disposition', `attachment; filename=${filename}`);
  res.setHeader('Content-type', mimetype);
  fs.createReadStream(file).pipe(res);
});

app.post(routes.import, requireRole('admin'), auditOperation('import_database'), (req, res, next) => {
  const temporaryFile = path.join(crontab.db_folder, `.import-${crypto.randomUUID()}.db`);
  let uploaded = false;
  let uploadWritten = false;
  let parsingFinished = false;
  let processing = false;
  let settled = false;
  let uploadOutput = null;
  let importMode = 'merge';
  let dryRun = false;
  const receivedFields = new Set();

  const cleanupTemporary = (callback = () => {}) => {
    if (uploadOutput && !uploadOutput.closed && !uploadOutput.destroyed) {
      uploadOutput.once('close', () => fs.rm(temporaryFile, { force: true }, callback));
      uploadOutput.destroy();
      return;
    }
    fs.rm(temporaryFile, { force: true }, callback);
  };
  const fail = (error, statusCode) => {
    if (settled) return;
    settled = true;
    cleanupTemporary(() => {
      if (statusCode) res.status(statusCode).json({ message: error.message });
      else next(error);
    });
  };
  const succeed = (summary) => {
    if (settled) return;
    settled = true;
    cleanupTemporary(() => res.status(200).json(summary));
  };
  const processUpload = () => {
    if (settled || processing || !uploaded || !uploadWritten || !parsingFinished) return;
    processing = true;
    crontab.normalise_database(temporaryFile, (normaliseError) => {
      if (normaliseError) return fail(normaliseError);
      if (dryRun) {
        return crontab.inspect_import(temporaryFile, importMode, (inspectError, summary) => {
          if (inspectError) return fail(inspectError);
          return succeed({ preview: true, ...summary });
        });
      }
      return crontab.apply_import(temporaryFile, importMode, (applyError, summary) => {
        if (applyError) return fail(applyError);
        return succeed({ preview: false, ...summary });
      });
    });
  };

  req.once('aborted', () => {
    if (!settled) {
      settled = true;
      cleanupTemporary();
    }
  });
  req.pipe(req.busboy);
  req.busboy.on('file', (fieldName, file, filename) => {
    if (settled) {
      file.resume();
      return;
    }
    if (uploaded) {
      file.resume();
      return fail(new Error('A single .db import file is required'), 400);
    }
    const uploadedFilename = typeof filename === 'object' ? filename.filename : filename;
    if (!validateImportMetadata(fieldName, uploadedFilename)) {
      file.resume();
      return fail(new Error('A single .db import file is required'), 400);
    }
    uploaded = true;
    const output = fs.createWriteStream(temporaryFile, { flags: 'wx' });
    uploadOutput = output;
    file.pipe(output);
    file.once('limit', () => {
      output.destroy();
      fail(new Error('Import file exceeds the size limit'), 413);
    });
    output.once('error', (error) => fail(error));
    output.once('finish', () => {
      uploadWritten = true;
      processUpload();
    });
  });
  req.busboy.on('finish', () => {
    parsingFinished = true;
    if (!uploaded) return fail(new Error('A database file is required'), 400);
    return processUpload();
  });
  req.busboy.on('field', (fieldName, value) => {
    if (settled) return;
    if (receivedFields.has(fieldName)) return fail(new Error('Invalid import options'), 400);
    receivedFields.add(fieldName);
    if (fieldName === 'mode' && ['merge', 'replace'].includes(value)) {
      importMode = value;
      return;
    }
    if (fieldName === 'dryRun' && (value === 'true' || value === 'false')) {
      dryRun = value === 'true';
      return;
    }
    return fail(new Error('Invalid import options'), 400);
  });
  req.busboy.once('filesLimit', () => fail(new Error('A single .db import file is required'), 400));
  req.busboy.once('error', (error) => fail(error));
});

app.post(routes.import_crontab, requireRole('admin'), auditOperation('import_system_crontab'), (req, res, next) => {
  crontab.import_crontab((err, result) => {
    if (err) return next(err);
    return res.status(200).json(result);
  });
});

app.get(routes.preview_crontab, requireRole('admin'), (req, res) => {
  const envVars = crontab.get_env();
  crontab.preview_crontab(envVars, (result) => {
    res.type('text/plain').send(result);
  });
});

function sendLog(filePath, req, res) {
  if (fs.existsSync(filePath)) {
    res.type('text/plain');
    res.set('Cache-Control', 'no-store');
    res.sendFile(filePath);
  } else {
    res.type('text/plain').send('No errors logged yet');
  }
}

app.get(routes.logger, requireRole('viewer'), validateIdParam, requireJobAccess('read'), (req, res) => {
  sendLog(path.join(crontab.log_folder, `${req.query.id}.log`), req, res);
});

app.get(routes.stdout, requireRole('viewer'), validateIdParam, requireJobAccess('read'), (req, res) => {
  sendLog(path.join(crontab.log_folder, `${req.query.id}.stdout.log`), req, res);
});

// The execution panel replaces opening one log per task: it answers, in one request, when the task
// last ran, how long it took, what it returned, and when it last worked. Access follows the same
// job ownership rules as reading that task's logs, and no command or output is ever included.
app.get(routes.executions, requireRole('viewer'), validateIdParam, requireJobAccess('read'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  // requireJobAccess only attaches the job when authentication is enabled, so the task is loaded
  // here as well to keep the 404 for an unknown task in either mode.
  return crontab.get_crontab(req.jobId, (error, job) => {
    if (error) return res.status(500).json({ message: 'Unable to read the task' });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    return res.json(crontab.getExecutionPanel(job));
  });
});

// error handler
app.use(errorHandler);
  return app;
}

function startServer(application = createApp()) {
  const tlsCredentials = application.locals.tlsCredentials;
  const server = tlsCredentials
    ? https.createServer(tlsCredentials, application)
    : http.createServer(application);

  server.listen(application.get('port'), application.get('host'), () => {
  console.log('Node version:', process.versions.node);

  fs.access(crontab.db_folder, fs.constants.W_OK, (err) => {
    if (err) {
      console.error('Write access to', crontab.db_folder, 'DENIED.');
      process.exit(1);
    }
  });

  if (process.argv.includes('--autosave') || process.env.ENABLE_AUTOSAVE) {
    crontab.autosave_crontab(() => {});
    fs.watchFile(crontab.crontab_db_file, () => {
      crontab.autosave_crontab(() => {
        console.log('Attempted to autosave crontab');
      });
    });
  }

  if (process.argv.includes('--reset')) {
    console.log('Resetting crontab-ui');

    for (const file of [crontab.crontab_db_file, crontab.env_file]) {
      console.log(`Deleting ${file}`);
      try {
        fs.unlinkSync(file);
      } catch (_e) {
        console.log(`Unable to delete ${file}`);
      }
    }

    crontab.reload_db();
  }

    const protocol = tlsCredentials ? 'https' : 'http';
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : application.get('port');
    console.log(`Crontab UI (${packageJson.version}) is running at ${protocol}://${application.get('host')}:${port}${baseUrl}`);
  });
  return server;
}

// Requiring this module must not open the database, create directories, or
// reject a misconfigured deployment. The application is built explicitly by
// the entry point (bootstrap.js) or by the caller.
module.exports = { createApp, startServer };
