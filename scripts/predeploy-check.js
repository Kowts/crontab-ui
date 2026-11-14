'use strict';

// Validates the deployment environment before the service starts or is upgraded.
// Usage: node scripts/predeploy-check.js   (reads the process environment)
const { validateProductionTransport } = require('../config/transport');
const path = require('path');
const Database = require('better-sqlite3');

const env = process.env;
const problems = [];

function check(name, fn) {
  try {
    fn();
  } catch (error) {
    problems.push(`${name}: ${error.message}`);
  }
}

check('AUTH_PROVIDER', () => {
  const provider = env.AUTH_PROVIDER || 'env';
  if (!['env', 'sqlite'].includes(provider)) throw new Error('must be env or sqlite');
  if (provider === 'env') {
    if (!env.BASIC_AUTH_USERS_JSON) throw new Error('BASIC_AUTH_USERS_JSON is required for AUTH_PROVIDER=env');
    const users = JSON.parse(env.BASIC_AUTH_USERS_JSON);
    if (!users || typeof users !== 'object' || Array.isArray(users) || !Object.keys(users).length) {
      throw new Error('BASIC_AUTH_USERS_JSON must be a non-empty JSON object');
    }
    if (!env.AUTHZ_ROLE_MAP_JSON) throw new Error('AUTHZ_ROLE_MAP_JSON is required for AUTH_PROVIDER=env');
    JSON.parse(env.AUTHZ_ROLE_MAP_JSON);
    return;
  }

  const dbDirectory = env.CRON_DB_PATH || path.join(__dirname, '..', 'crontabs');
  const filename = path.join(dbDirectory, 'crontab.db');
  const database = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const hasUsers = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    if (!hasUsers) throw new Error('users table is missing; run the user migration CLI first');
    const admins = database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1").get().count;
    if (admins < 1) throw new Error('at least one active SQLite administrator is required');
  } finally {
    database.close();
  }
});

check('CSRF_SECRET', () => {
  if (!env.CSRF_SECRET || env.CSRF_SECRET.length < 32) throw new Error('must be at least 32 characters');
});

check('transport', () => validateProductionTransport({
  nodeEnv: 'production',
  nativeTls: Boolean(env.SSL_CERT && env.SSL_KEY),
  trustedProxy: env.TRUSTED_PROXY,
  insecureBypass: env.ALLOW_INSECURE_NO_AUTH === 'true',
  allowHttp: env.ALLOW_HTTP,
}));

check('COMMAND_TIMEOUT_MS', () => {
  if (env.COMMAND_TIMEOUT_MS === undefined) return;
  const value = Number(env.COMMAND_TIMEOUT_MS);
  if (!Number.isInteger(value) || value < 0) throw new Error('must be a non-negative integer');
});

if (problems.length) {
  console.error('Pre-deploy check failed:');
  problems.forEach((problem) => console.error(`  - ${problem}`));
  process.exit(1);
}
console.log('Pre-deploy check passed.');
