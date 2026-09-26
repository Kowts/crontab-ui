'use strict';

const basicAuth = require('express-basic-auth');

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
  return users;
}

function setupAuth(app) {
  const users = authenticatedUsers();

  if (users) {
    app.use((req, res, next) => {
      res.setHeader('WWW-Authenticate', 'Basic realm="Restricted Area"');
      next();
    });
    app.use(basicAuth({
      users,
      challenge: true,
    }));
    return true;
  }

  return false;
}

function authenticatedUsers() {
  const user = process.env.BASIC_AUTH_USER;
  const pwd = process.env.BASIC_AUTH_PWD;
  return configuredUsers() || (user && pwd ? { [user]: pwd } : null);
}

module.exports = setupAuth;
module.exports.configuredUsers = configuredUsers;
module.exports.authenticatedUsers = authenticatedUsers;
