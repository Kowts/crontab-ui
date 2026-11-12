'use strict';

// Validates the deployment environment before the service starts or is upgraded.
// Usage: node scripts/predeploy-check.js   (reads the process environment)
const { validateProductionTransport } = require('../config/transport');

const env = process.env;
const problems = [];

function check(name, fn) {
  try {
    fn();
  } catch (error) {
    problems.push(`${name}: ${error.message}`);
  }
}

check('BASIC_AUTH_USERS_JSON', () => {
  if (!env.BASIC_AUTH_USERS_JSON) throw new Error('is required');
  const users = JSON.parse(env.BASIC_AUTH_USERS_JSON);
  if (!users || typeof users !== 'object' || Array.isArray(users) || !Object.keys(users).length) {
    throw new Error('must be a non-empty JSON object');
  }
});

check('AUTHZ_ROLE_MAP_JSON', () => {
  if (!env.AUTHZ_ROLE_MAP_JSON) throw new Error('is required');
  JSON.parse(env.AUTHZ_ROLE_MAP_JSON);
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
