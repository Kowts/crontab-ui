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
const { base_url: baseUrl, routes, relative: routesRelative } = require('./routes');
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
const { getProfile } = require('./config/mail-profiles');
const { validateProductionTransport } = require('./config/transport');
const { canAccessJob, requireJobAccess, requireSaveAccess } = require('./middleware/job-authorization');
const { dictionaries, localeFromRequest, normalizeLocale, translate } = require('./config/i18n');

dayjs.extend(relativeTime);

function createApp() {
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
validateProductionTransport({
  nodeEnv: process.env.NODE_ENV,
  nativeTls: startHttpsServer,
  trustedProxy,
  insecureBypass: process.env.ALLOW_INSECURE_NO_AUTH === 'true',
});
if (trustedProxy) app.set('trust proxy', trustedProxy);

const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(app.get('host'));
app.get(`${baseUrl}/healthz`, (req, res) => {
  const address = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return res.sendStatus(404);
  return res.json({ status: 'ok' });
});
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.secure) {
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
const authEnabled = setupAuth(app);
app.locals.authEnabled = authEnabled;
if (authEnabled) validateRoleAssignments(authenticatedUsers(), configuredRoles());
if (process.env.NODE_ENV === 'production' && !process.env.CSRF_SECRET) {
  throw new Error('CSRF_SECRET is required in production');
}
if (!authEnabled && !isLoopback && process.env.ALLOW_INSECURE_NO_AUTH !== 'true') {
  throw new Error('BASIC_AUTH_USER and BASIC_AUTH_PWD are required when HOST is not loopback');
}

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
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  strictTransportSecurity: process.env.NODE_ENV !== 'production' ? false : undefined,
}));

// rate limiting
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
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
app.use(busboy({ limits: { files: 1, fileSize: 1024 * 1024, fields: 10 } }));
app.use(csrfProtection);
app.use((req, res, next) => {
  const locale = localeFromRequest(req);
  res.locals.locale = locale;
  res.locals.t = (key, values) => translate(locale, key, values);
  next();
});

app.use(baseUrl, express.static(path.join(__dirname, 'public')));
app.use(baseUrl, express.static(path.join(__dirname, 'public', 'css')));
app.use(baseUrl, express.static(path.join(__dirname, 'public', 'js')));
app.use(`${baseUrl}/vendor/cronstrue`, express.static(path.join(__dirname, 'node_modules', 'cronstrue', 'dist')));

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
    docs = docs.map((job) => ({
      ...job,
      permissions: {
        execute: canAccessJob(req, job, 'execute'),
        write: canAccessJob(req, job, 'write'),
      },
    }));
    res.render('index', {
      routes: serializeForHtml(routesRelative),
      crontabs: serializeForHtml(docs),
      backups: crontab.get_backup_names(),
      env: serializeForHtml(crontab.get_env()),
      currentRole,
      dayjs,
      messages: serializeForHtml(dictionaries[res.locals.locale]),
    });
  });
});

app.post(routes.locale, requireRole('viewer'), (req, res) => {
  if (!['en', 'pt'].includes(req.body.locale)) return res.status(400).json({ message: 'Invalid locale' });
  res.cookie('crontab_ui_locale', normalizeLocale(req.body.locale), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
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
    || typeof mailing !== 'object' || mailing === null
    || Object.keys(mailing).some((key) => key !== 'profileId')
    || (mailing.profileId !== undefined && (typeof mailing.profileId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(mailing.profileId)))) {
    return res.status(400).json({ message: 'Invalid job payload' });
  }
  try {
    if (schedule !== '@reboot') require('cron-parser').CronExpressionParser.parse(schedule);
    if (mailing.profileId) getProfile(mailing.profileId);
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
  return crontab.get_crontab(run.jobId, (job) => {
    if (!job || !canAccessJob(req, job, 'read')) return res.status(403).json({ message: 'Not authorized for this job' });
    return res.json(run);
  });
});

app.post(routes.cancel_run, requireRole('executor'), (req, res) => {
  const operationId = String(req.body.operationId || '');
  const run = crontab.getManualRun(operationId);
  if (!run) return res.status(404).json({ message: 'Execution not found' });
  return crontab.get_crontab(run.jobId, (job) => {
    if (!job || !canAccessJob(req, job, 'execute')) return res.status(403).json({ message: 'Not authorized for this job' });
    const cancelled = crontab.cancelManualRun(operationId, { requestId: req.requestId, actor: req.auth?.user || 'local', sourceIp: req.ip });
    if (!cancelled) return res.status(409).json({ message: 'Execution is no longer active' });
    return res.status(202).json(cancelled);
  });
});

app.post(routes.crontab, requireRole('admin'), validateEnvironmentPayload, auditOperation('apply_crontab'), (req, res, next) => {
  crontab.set_crontab(req.jobEnvironment, (err) => {
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

app.get(routes.restore, requireRole('viewer'), validateBackupParam, (req, res) => {
  if (!crontab.get_backup_names().includes(req.dbName)) return res.status(404).json({ message: 'Backup not found' });
  restore.crontabs(req.dbName, (docs) => {
    res.render('restore', {
      routes: serializeForHtml(routesRelative),
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

app.get(routes.export, requireRole('viewer'), (req, res) => {
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

  const cleanupTemporary = (callback = () => {}) => fs.rm(temporaryFile, { force: true }, callback);
  const fail = (error, statusCode) => {
    if (settled) return;
    settled = true;
    cleanupTemporary(() => {
      if (statusCode) res.status(statusCode).json({ message: error.message });
      else next(error);
    });
  };
  const succeed = () => {
    if (settled) return;
    settled = true;
    res.redirect(routes.root);
  };
  const processUpload = () => {
    if (settled || processing || !uploaded || !uploadWritten || !parsingFinished) return;
    processing = true;
    crontab.normalise_database(temporaryFile, (normaliseError) => {
      if (normaliseError) return fail(normaliseError);
      return crontab.replace_database(temporaryFile, (replaceError) => {
        if (replaceError) return fail(replaceError);
        return succeed();
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
  req.busboy.once('filesLimit', () => fail(new Error('A single .db import file is required'), 400));
  req.busboy.once('error', (error) => fail(error));
});

app.post(routes.import_crontab, requireRole('admin'), auditOperation('import_system_crontab'), (req, res, next) => {
  crontab.import_crontab((err, result) => {
    if (err) return next(err);
    return res.status(200).json(result);
  });
});

app.get(routes.preview_crontab, requireRole('viewer'), (req, res) => {
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

const defaultApp = createApp();

module.exports = defaultApp;
module.exports.createApp = createApp;
module.exports.startServer = startServer;
