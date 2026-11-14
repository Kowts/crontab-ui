'use strict';

const crypto = require('crypto');
const { getAuthProvider } = require('../middleware/auth');
const { hashPassword } = require('../config/passwords');
const { normaliseUsername } = require('../config/users');
const { migrateLegacyUsers } = require('../lib/user-migration');
const crontab = require('../crontab');

function createBackup() {
  return new Promise((resolve, reject) => {
    crontab.backup((error, backup) => error ? reject(error) : resolve(backup));
  });
}

function usage() {
  console.log('Usage: npm run users -- migrate');
  console.log('       AUTH_PROVIDER=sqlite npm run users -- recover-admin <username>');
}

async function run(command, args = process.argv.slice(3)) {
  if (command === 'migrate') {
    if (args.length) throw new Error('The migrate command takes no arguments');
    const backup = await createBackup();
    const result = await migrateLegacyUsers(crontab.users, process.env);
    crontab.audit({ type: 'user_migration', operation: 'import_environment_users', actor: 'local-cli', backup, ...result });
    console.log(`Verified backup created: ${backup}`);
    console.log(`User migration complete: ${result.imported} imported, ${result.existing} already present.`);
    console.log('Set AUTH_PROVIDER=sqlite and restart the service after verifying at least one active admin.');
    return result;
  }

  if (command === 'recover-admin') {
    if (getAuthProvider() !== 'sqlite') throw new Error('Set AUTH_PROVIDER=sqlite before recovering a SQLite administrator');
    if (args.length !== 1) throw new Error('recover-admin requires a username');
    const username = normaliseUsername(args[0]);
    const backup = await createBackup();
    const password = crypto.randomBytes(24).toString('base64url');
    const passwordHash = await hashPassword(password);
    const user = crontab.users.recoverAdministrator({
      id: crypto.randomUUID(), username, passwordHash, actor: 'cli-recovery',
    });
    crontab.audit({ type: 'user_admin_recovery', operation: 'recover_admin', userId: user.id, username, backup, actor: 'cli-recovery' });
    console.log(`Verified backup created: ${backup}`);
    console.log(`Administrator access recovered for ${username}.`);
    console.log(`Temporary password (shown once): ${password}`);
    console.log('Sign in locally, then use Users & Permissions to set a new password.');
    return user;
  }

  usage();
  throw new Error('Unknown user administration command');
}

if (require.main === module) {
  const command = process.argv[2];
  run(command).catch((error) => {
    console.error(`User administration failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, usage };
