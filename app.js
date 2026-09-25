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
const csrfProtection = require('./middleware/csrf');
const errorHandler = require('./middleware/error');
const { validateDbParam, validateIdParam } = require('./middleware/validate');

dayjs.extend(relativeTime);

const app = express();
app.locals.baseURL = baseUrl;
app.set('host', process.env.HOST || '127.0.0.1');
app.set('port', process.env.PORT || 8000);

const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(app.get('host'));
const authEnabled = setupAuth(app);
if (!authEnabled && !isLoopback && process.env.ALLOW_INSECURE_NO_AUTH !== 'true') {
  throw new Error('BASIC_AUTH_USER and BASIC_AUTH_PWD are required when HOST is not loopback');
}

// security headers (relaxed for local/HTTP usage and CDN assets)
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

// ssl credentials
const credentials = {
  key: process.env.SSL_KEY ? fs.readFileSync(process.env.SSL_KEY) : '',
  cert: process.env.SSL_CERT ? fs.readFileSync(process.env.SSL_CERT) : '',
};

if ((credentials.key && !credentials.cert) || (credentials.cert && !credentials.key)) {
  console.error('Please provide both SSL_KEY and SSL_CERT');
  process.exit(1);
}

const startHttpsServer = credentials.key && credentials.cert;

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

app.use(baseUrl, express.static(path.join(__dirname, 'public')));
app.use(baseUrl, express.static(path.join(__dirname, 'public', 'css')));
app.use(baseUrl, express.static(path.join(__dirname, 'public', 'js')));

// --- Routes ---

app.get(routes.root, (req, res) => {
  crontab.crontabs((docs) => {
    res.render('index', {
      routes: serializeForHtml(routesRelative),
      crontabs: serializeForHtml(docs),
      backups: crontab.get_backup_names(),
      env: serializeForHtml(crontab.get_env()),
      dayjs,
    });
  });
});

app.post(routes.save, (req, res) => {
  const { name, command, schedule, logging, mailing } = req.body;
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
  } catch (_error) {
    return res.status(400).json({ message: 'Invalid cron schedule' });
  }
  if (req.body._id == -1) { // eslint-disable-line eqeqeq
    crontab.create_new(req.body.name, req.body.command, req.body.schedule, req.body.logging, req.body.mailing, (err) => {
      if (err) return res.status(500).json({ message: 'Unable to save job' });
      return res.end();
    });
  } else {
    crontab.update(req.body, (err) => {
      if (err) return res.status(500).json({ message: 'Unable to save job' });
      return res.end();
    });
  }
});

app.post(routes.stop, (req, res) => {
  crontab.status(req.body._id, true, (err) => {
    if (err) return res.status(500).json({ message: 'Unable to stop job' });
    return res.end();
  });
});

app.post(routes.start, (req, res) => {
  crontab.status(req.body._id, false, (err) => {
    if (err) return res.status(500).json({ message: 'Unable to start job' });
    return res.end();
  });
});

app.post(routes.remove, (req, res) => {
  crontab.remove(req.body._id, (err) => {
    if (err) return res.status(500).json({ message: 'Unable to remove job' });
    return res.end();
  });
});

app.post(routes.run, (req, res) => {
  crontab.runjob(req.body._id);
  res.end();
});

app.post(routes.crontab, (req, res, next) => {
  crontab.set_crontab(req.body.env_vars, (err) => {
    if (err) next(err);
    else res.end();
  });
});

app.post(routes.backup, (req, res, next) => {
  crontab.backup((err) => {
    if (err) next(err);
    else res.end();
  });
});

app.get(routes.restore, validateDbParam, (req, res) => {
  restore.crontabs(req.dbName, (docs) => {
    res.render('restore', {
      routes: serializeForHtml(routesRelative),
      crontabs: serializeForHtml(docs),
      backups: crontab.get_backup_names(),
      db: req.dbName,
    });
  });
});

app.post(routes.delete_backup, validateDbParam, (req, res) => {
  if (!crontab.get_backup_names().includes(req.dbName)) return res.status(404).json({ message: 'Backup not found' });
  restore.delete(req.dbName);
  res.end();
});

app.post(routes.restore_backup, validateDbParam, (req, res) => {
  if (!crontab.get_backup_names().includes(req.dbName)) return res.status(404).json({ message: 'Backup not found' });
  return crontab.restore(req.dbName, (err) => {
    if (err) return res.status(err.statusCode || 500).json({ message: 'Unable to restore backup' });
    return res.end();
  });
});

app.get(routes.export, (req, res) => {
  const file = crontab.crontab_db_file;
  const filename = path.basename(file);
  const mimetype = mime.lookup(file);

  res.setHeader('Content-disposition', `attachment; filename=${filename}`);
  res.setHeader('Content-type', mimetype);
  fs.createReadStream(file).pipe(res);
});

app.post(routes.import, (req, res, next) => {
  const temporaryFile = path.join(crontab.db_folder, `.import-${crypto.randomUUID()}.db`);
  let uploaded = false;
  req.pipe(req.busboy);
  req.busboy.on('file', (_fieldname, file) => {
    if (uploaded) return file.resume();
    uploaded = true;
    const output = fs.createWriteStream(temporaryFile, { flags: 'wx' });
    file.pipe(output);
    file.on('limit', () => output.destroy(new Error('Import file exceeds the size limit')));
    output.on('error', next);
    output.on('close', () => crontab.replace_database(temporaryFile, (err) => {
      if (err) return next(err);
      return res.redirect(routes.root);
    }));
  });
  req.busboy.on('finish', () => {
    if (!uploaded && !res.headersSent) res.status(400).json({ message: 'A database file is required' });
  });
});

app.post(routes.import_crontab, (req, res, next) => {
  crontab.backup((err) => {
    if (err) return next(err);
    crontab.import_crontab();
    res.end();
  });
});

app.get(routes.preview_crontab, (req, res) => {
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

app.get(routes.logger, validateIdParam, (req, res) => {
  sendLog(path.join(crontab.log_folder, `${req.query.id}.log`), req, res);
});

app.get(routes.stdout, validateIdParam, (req, res) => {
  sendLog(path.join(crontab.log_folder, `${req.query.id}.stdout.log`), req, res);
});

// error handler
app.use(errorHandler);

process.on('SIGINT', () => {
  console.log('Exiting crontab-ui');
  process.exit();
});

process.on('SIGTERM', () => {
  console.log('Exiting crontab-ui');
  process.exit();
});

const server = startHttpsServer
  ? https.createServer(credentials, app)
  : http.createServer(app);

server.listen(app.get('port'), app.get('host'), () => {
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

  const protocol = startHttpsServer ? 'https' : 'http';
  console.log(`Crontab UI (${packageJson.version}) is running at ${protocol}://${app.get('host')}:${app.get('port')}${baseUrl}`);
});

module.exports = app;
