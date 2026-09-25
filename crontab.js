'use strict';

const Datastore = require('@seald-io/nedb');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { CronExpressionParser } = require('cron-parser');
const cronstrue = require('cronstrue/i18n');

const humanCronLocale = process.env.HUMANCRON ?? 'en';

const dbFolder = process.env.CRON_DB_PATH || path.join(__dirname, 'crontabs');
console.log(`Cron db path: ${dbFolder}`);

const logFolder = path.join(dbFolder, 'logs');
const auditFile = path.join(logFolder, 'operations.jsonl');
const envFile = path.join(dbFolder, 'env.db');
const crontabDbFile = path.join(dbFolder, 'crontab.db');

const db = new Datastore({ filename: crontabDbFile, autocompactionInterval: 60000 });
const commandTimeoutMs = Number(process.env.COMMAND_TIMEOUT_MS || 300000);
const commandMaxBuffer = Number(process.env.COMMAND_MAX_BUFFER || 1024 * 1024);
const logRetentionDays = Number(process.env.LOG_RETENTION_DAYS || 30);
const backupRetentionCount = Number(process.env.BACKUP_RETENTION_COUNT || 30);
const backupRetentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 90);

let cronPath = '/tmp';
let databaseOperationActive = false;
if (process.env.CRON_PATH !== undefined) {
  console.log(`Path to crond files set using env variables ${process.env.CRON_PATH}`);
  cronPath = process.env.CRON_PATH;
}

db.loadDatabase((err) => {
  if (err) throw err;
});

if (!fs.existsSync(logFolder)) {
  fs.mkdirSync(logFolder);
}

function buildCrontab(name, command, schedule, stopped, logging, mailing) {
  return {
    name,
    command,
    schedule,
    ...(stopped !== null && { stopped }),
    timestamp: new Date().toString(),
    logging,
    mailing: mailing || {},
  };
}

function makeCommand(tab) {
  const stderr = path.join(cronPath, `${tab._id}.stderr`);
  const stdout = path.join(cronPath, `${tab._id}.stdout`);
  const logFile = path.join(logFolder, `${tab._id}.log`);
  const logFileStdout = path.join(logFolder, `${tab._id}.stdout.log`);

  let cmd = tab.command;
  if (cmd[cmd.length - 1] !== ';') {
    cmd += ';';
  }

  let result = `({ ${cmd} } | tee ${stdout})`;
  result = `(${result} 3>&1 1>&2 2>&3 | tee ${stderr}) 3>&1 1>&2 2>&3`;
  result = `(${result})`;

  if (tab.logging && tab.logging === 'true') {
    result += `; if test -f ${stderr}; then date >> "${logFile}"; cat ${stderr} >> "${logFile}"; fi`;
    result += `; if test -f ${stdout}; then date >> "${logFileStdout}"; cat ${stdout} >> "${logFileStdout}"; fi`;
  }

  if (tab.hook) {
    result += `; if test -f ${stdout}; then ${tab.hook} < ${stdout}; fi`;
  }

  if (tab.mailing && JSON.stringify(tab.mailing) !== '{}') {
    result += `; /usr/local/bin/node ${__dirname}/bin/crontab-ui-mailer.js ${tab._id} ${stdout} ${stderr}`;
  }

  return result;
}

function addEnvVars(envVars, command) {
  if (envVars) {
    return `(${envVars.replace(/\s*\n\s*/g, ' ').trim()}; (${command}))`;
  }
  return command;
}

exports.db_folder = dbFolder;
exports.log_folder = logFolder;
exports.audit_file = auditFile;
exports.env_file = envFile;
exports.crontab_db_file = crontabDbFile;

exports.create_new = (name, command, schedule, logging, mailing, callback = () => {}) => {
  const tab = buildCrontab(name, command, schedule, false, logging, mailing);
  tab.created = Date.now();
  tab.saved = false;
  db.insert(tab, callback);
};

exports.update = (data, callback = () => {}) => {
  const tab = buildCrontab(data.name, data.command, data.schedule, null, data.logging, data.mailing);
  tab.saved = false;
  db.update({ _id: data._id }, tab, callback);
};

exports.status = (_id, stopped, callback = () => {}) => {
  db.update({ _id }, { $set: { stopped, saved: false } }, callback);
};

exports.remove = (_id, callback = () => {}) => {
  db.remove({ _id }, {}, callback);
};

exports.crontabs = (callback) => {
  db.find({}).sort({ created: -1 }).exec((err, docs) => {
    if (err) {
      console.error(err);
      return callback([]);
    }
    for (const doc of docs) {
      if (doc.schedule === '@reboot') {
        doc.next = 'Next Reboot';
      } else {
        try {
          doc.human = cronstrue.toString(doc.schedule, { locale: humanCronLocale });
          doc.next = CronExpressionParser.parse(doc.schedule).next().toString();
        } catch (e) {
          console.error(e);
          doc.next = 'invalid';
        }
      }
    }
    callback(docs);
  });
};

exports.get_crontab = (_id, callback) => {
  db.find({ _id }).exec((err, docs) => {
    callback(docs[0]);
  });
};

function audit(event) {
  fs.appendFile(auditFile, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, () => {});
}

function applyRetention() {
  const cutoff = Date.now() - (logRetentionDays * 24 * 60 * 60 * 1000);
  try {
    for (const file of fs.readdirSync(logFolder)) {
      const fullPath = path.join(logFolder, file);
      if (file !== path.basename(auditFile) && fs.statSync(fullPath).mtimeMs < cutoff) fs.unlinkSync(fullPath);
    }
  } catch (error) {
    audit({ type: 'retention', status: 'failed', scope: 'logs', error: error.message });
  }

  try {
    const backupCutoff = Date.now() - (backupRetentionDays * 24 * 60 * 60 * 1000);
    const backups = exports.get_backup_names();
    const expired = backups.filter((backup, index) => {
      const ageExpired = fs.statSync(path.join(dbFolder, backup)).mtimeMs < backupCutoff;
      return index >= backupRetentionCount || ageExpired;
    });
    for (const backup of expired) fs.unlinkSync(path.join(dbFolder, backup));
  } catch (error) {
    audit({ type: 'retention', status: 'failed', scope: 'backups', error: error.message });
  }
}

exports.runjob = (_id, callback = () => {}) => {
  db.find({ _id }).exec((err, docs) => {
    if (err || !docs.length) return callback(err || new Error('Job not found'));
    const res = docs[0];
    const envVars = exports.get_env();
    let cmd = makeCommand(res);
    cmd = addEnvVars(envVars, cmd);

    const operationId = crypto.randomUUID();
    audit({ operationId, type: 'runjob', jobId: _id, status: 'started' });

    exec(cmd, { timeout: commandTimeoutMs, maxBuffer: commandMaxBuffer }, (error, _stdout, _stderr) => {
      const exitCode = error && typeof error.code === 'number' ? error.code : 0;
      audit({ operationId, type: 'runjob', jobId: _id, status: error ? 'failed' : 'completed', exitCode, error: error?.message });
      callback(error, { operationId, exitCode });
    });
  });
};

exports.set_crontab = (envVars, callback) => {
  exports.crontabs((tabs) => {
    let crontabString = '';
    if (envVars) {
      crontabString += `${envVars}\n`;
    }
    for (const tab of tabs) {
      if (!tab.stopped) {
        crontabString += `${tab.schedule} ${makeCommand(tab)}\n`;
      }
    }

    fs.writeFile(envFile, envVars, (err) => {
      if (err) {
        console.error(err);
        return callback(err);
      }
      const fileName = process.env.CRON_IN_DOCKER !== undefined ? 'root' : 'crontab';
      fs.writeFile(path.join(cronPath, fileName), crontabString, (err) => {
        if (err) {
          console.error(err);
          return callback(err);
        }
        exec(`crontab ${path.join(cronPath, fileName)}`, (err) => {
          if (err) {
            console.error(err);
            return callback(err);
          }
          db.update({}, { $set: { saved: true } }, { multi: true });
          callback();
        });
      });
    });
  });
};

exports.get_backup_names = () => {
  const backups = fs.readdirSync(dbFolder)
    .filter((file) => file.indexOf('backup') === 0);

  const backupDate = (name) => {
    const t = name.split('backup')[1];
    return new Date(t.substring(0, t.length - 3)).valueOf();
  };

  backups.sort((a, b) => backupDate(b) - backupDate(a));
  return backups;
};

exports.backup = (callback) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dbFolder, `backup-${timestamp}.db`);
  const copyDatabase = () => fs.mkdir(dbFolder, { recursive: true }, (mkdirErr) => {
    if (mkdirErr) return callback(mkdirErr);
    return fs.writeFile(
      dest,
      db.getAllData().map((document) => JSON.stringify(document)).join('\n'),
      (err) => {
        if (err) {
          console.error(err);
          return callback(err);
        }
        applyRetention();
        return callback();
      }
    );
  });

  db.compactDatafile((err) => {
    if (err) return callback(err);
    return copyDatabase();
  });
};

function withDatabaseLock(operation, callback) {
  if (databaseOperationActive) {
    const error = new Error('Another database operation is already in progress');
    error.statusCode = 409;
    return callback(error);
  }
  databaseOperationActive = true;
  return operation((...args) => {
    databaseOperationActive = false;
    callback(...args);
  });
}

function validateDatabaseFile(fileName, callback) {
  const candidate = new Datastore({ filename: fileName });
  candidate.loadDatabase((err) => {
    if (err) return callback(err);
    return candidate.find({}).exec((findErr) => callback(findErr));
  });
}

exports.replace_database = (temporaryFile, callback) => withDatabaseLock((done) => {
  validateDatabaseFile(temporaryFile, (validationError) => {
    if (validationError) return done(validationError);
    return exports.backup((backupError) => {
      if (backupError) return done(backupError);
      return fs.rename(temporaryFile, crontabDbFile, (renameError) => {
        if (renameError) return done(renameError);
        return db.loadDatabase((loadError) => done(loadError));
      });
    });
  });
}, callback);

exports.restore = (dbName, callback) => {
  const source = path.join(dbFolder, dbName);
  const temporaryFile = path.join(dbFolder, `.restore-${crypto.randomUUID()}.db`);
  fs.copyFile(source, temporaryFile, (copyError) => {
    if (copyError) return callback(copyError);
    return exports.replace_database(temporaryFile, (error) => {
      if (error) fs.unlink(temporaryFile, () => {});
      callback(error);
    });
  });
};

exports.reload_db = () => {
  db.loadDatabase();
};

exports.get_env = () => {
  if (fs.existsSync(envFile)) {
    return fs.readFileSync(envFile, 'utf8').replace('\n', '\n');
  }
  return '';
};

exports.import_crontab = () => {
  exec('crontab -l', (error, stdout) => {
    const lines = stdout.split('\n');
    const namePrefix = Date.now();

    lines.forEach((line, index) => {
      line = line.replace(/\t+/g, ' ');
      const regex = /^((@[a-zA-Z]+\s+)|(([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+))/;
      const command = line.replace(regex, '').trim();
      const schedule = line.replace(command, '').trim();

      let isValid = false;
      try {
        isValid = CronExpressionParser.parse(schedule) !== null;
      } catch (_e) { /* ignore */ }

      if (command && schedule && isValid) {
        const name = `${namePrefix}_${index}`;
        db.findOne({ command, schedule }, (err, doc) => {
          if (err) throw err;
          if (!doc) {
            exports.create_new(name, command, schedule, null);
          } else {
            doc.command = command;
            doc.schedule = schedule;
            exports.update(doc);
          }
        });
      }
    });
  });
};

exports.preview_crontab = (envVars, callback) => {
  exports.crontabs((tabs) => {
    let crontabString = '';
    if (envVars) {
      crontabString += `${envVars}\n`;
    }
    for (const tab of tabs) {
      if (!tab.stopped) {
        crontabString += `${tab.schedule} ${makeCommand(tab)}\n`;
      }
    }
    callback(crontabString);
  });
};

exports.autosave_crontab = (callback) => {
  const envVars = exports.get_env();
  exports.set_crontab(envVars, callback);
};
