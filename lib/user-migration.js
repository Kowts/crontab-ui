'use strict';

const crypto = require('crypto');
const {
  hashPassword,
  identifyForeignDigest,
  isValidDigestFormat,
  verifyPassword,
} = require('../config/passwords');
const { normaliseUsername, validateUserRole } = require('../config/users');

function readLegacyUsers(environment = process.env) {
  let users;
  if (environment.BASIC_AUTH_USERS_JSON) {
    try { users = JSON.parse(environment.BASIC_AUTH_USERS_JSON); } catch (_error) {
      throw new Error('BASIC_AUTH_USERS_JSON must be valid JSON before migration');
    }
  } else if (environment.BASIC_AUTH_USER && environment.BASIC_AUTH_PWD) {
    users = { [environment.BASIC_AUTH_USER]: environment.BASIC_AUTH_PWD };
  } else {
    throw new Error('No legacy authentication users were configured for migration');
  }
  if (!users || typeof users !== 'object' || Array.isArray(users) || !Object.keys(users).length) {
    throw new Error('Legacy authentication users must be a non-empty object');
  }

  let roles;
  try { roles = JSON.parse(environment.AUTHZ_ROLE_MAP_JSON || '{}'); } catch (_error) {
    throw new Error('AUTHZ_ROLE_MAP_JSON must be valid JSON before migration');
  }
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) {
    throw new Error('AUTHZ_ROLE_MAP_JSON must be an object');
  }

  const normalisedRoles = new Map(Object.entries(roles).map(([username, role]) => [normaliseUsername(username), validateUserRole(role)]));
  const records = [];
  const usernames = new Set();
  for (const [rawUsername, password] of Object.entries(users)) {
    const username = normaliseUsername(rawUsername);
    if (usernames.has(username)) throw new Error(`Legacy user names collide after normalisation: ${username}`);
    usernames.add(username);
    const role = normalisedRoles.get(username);
    if (!role) throw new Error(`Legacy user ${username} has no valid RBAC role`);
    if (typeof password !== 'string' || !password) throw new Error(`Legacy user ${username} has no password`);
    if (password.startsWith('scrypt:') && !isValidDigestFormat(password)) {
      throw new Error(`Legacy user ${username} has a malformed scrypt password hash`);
    }
    const foreignDigest = identifyForeignDigest(password);
    if (foreignDigest) throw new Error(`Legacy user ${username} uses an unsupported ${foreignDigest} password hash`);
    records.push({ username, role, password });
  }
  if ([...normalisedRoles.keys()].some((username) => !usernames.has(username))) {
    throw new Error('AUTHZ_ROLE_MAP_JSON contains a role without a matching authentication user');
  }
  if (!records.some((record) => record.role === 'admin')) {
    throw new Error('Legacy configuration must include at least one administrator');
  }
  return records;
}

async function migrateLegacyUsers(userStore, environment = process.env) {
  const legacyUsers = readLegacyUsers(environment);
  const imports = [];
  for (const user of legacyUsers) {
    const existing = userStore.getAuthentication(user.username);
    if (existing) {
      let passwordMatches;
      if (user.password.startsWith('scrypt:')) {
        const left = Buffer.from(user.password);
        const right = Buffer.from(existing.passwordHash);
        passwordMatches = left.length === right.length && crypto.timingSafeEqual(left, right);
      } else {
        passwordMatches = await verifyPassword(user.password, existing.passwordHash);
      }
      if (existing.role !== user.role || !existing.active || !passwordMatches) {
        throw Object.assign(new Error(`Existing SQLite account conflicts with legacy account ${user.username}`), {
          statusCode: 409, code: 'USER_IMPORT_CONFLICT',
        });
      }
      continue;
    }
    const passwordHash = user.password.startsWith('scrypt:') ? user.password : await hashPassword(user.password);
    imports.push({ id: crypto.randomUUID(), username: user.username, passwordHash, role: user.role, now: Date.now() });
  }
  if (imports.length) userStore.import(imports);
  if (!userStore.countActiveAdministrators()) {
    throw Object.assign(new Error('At least one active administrator is required'), { statusCode: 422, code: 'ACTIVE_ADMIN_REQUIRED' });
  }
  return { imported: imports.length, existing: legacyUsers.length - imports.length };
}

module.exports = { migrateLegacyUsers, readLegacyUsers };
