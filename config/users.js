'use strict';

const USER_ROLES = Object.freeze(['viewer', 'executor', 'operator', 'admin']);
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

function normaliseUsername(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('Invalid username'), { statusCode: 422 });
  const username = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw Object.assign(new Error('Username must be 3-64 lowercase letters, digits, dot, underscore or hyphen'), { statusCode: 422 });
  }
  return username;
}

function validateUserRole(value) {
  if (typeof value !== 'string' || !USER_ROLES.includes(value)) {
    throw Object.assign(new Error('Invalid user role'), { statusCode: 422 });
  }
  return value;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256 || /[\0\r\n]/.test(value)) {
    throw Object.assign(new Error('Password must contain 12-256 characters without line breaks'), { statusCode: 422 });
  }
  return value;
}

module.exports = { USER_ROLES, normaliseUsername, validatePassword, validateUserRole };
