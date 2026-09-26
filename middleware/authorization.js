'use strict';

const ROLE_LEVEL = Object.freeze({
  viewer: 0,
  executor: 1,
  operator: 2,
  admin: 3,
});

function configuredRoles() {
  const raw = process.env.AUTHZ_ROLE_MAP_JSON;
  if (!raw) return {};

  let roles;
  try {
    roles = JSON.parse(raw);
  } catch (_error) {
    throw new Error('AUTHZ_ROLE_MAP_JSON must be a JSON object of user roles');
  }

  if (!roles || Array.isArray(roles) || typeof roles !== 'object') {
    throw new Error('AUTHZ_ROLE_MAP_JSON must be a JSON object of user roles');
  }

  for (const [user, role] of Object.entries(roles)) {
    if (!user || typeof role !== 'string' || !Object.hasOwn(ROLE_LEVEL, role)) {
      throw new Error('AUTHZ_ROLE_MAP_JSON contains an invalid user role');
    }
  }
  return roles;
}

function requireRole(requiredRole) {
  if (!Object.hasOwn(ROLE_LEVEL, requiredRole)) {
    throw new Error(`Unknown required role: ${requiredRole}`);
  }

  return (req, res, next) => {
    // Authentication is deliberately optional only for loopback development.
    // In that mode there is no authenticated identity on which to base RBAC.
    if (!req.app.locals.authEnabled) return next();

    const role = configuredRoles()[req.auth?.user];
    if (!role || ROLE_LEVEL[role] < ROLE_LEVEL[requiredRole]) {
      return res.status(403).json({ message: 'Insufficient role for this operation' });
    }
    return next();
  };
}

function validateRoleAssignments(users, roles) {
  for (const user of Object.keys(users || {})) {
    if (!roles[user]) throw new Error(`Authenticated user ${user} has no assigned role`);
  }
  for (const user of Object.keys(roles)) {
    if (!Object.hasOwn(users || {}, user)) throw new Error(`Role assignment references unknown user ${user}`);
  }
}

module.exports = { configuredRoles, requireRole, validateRoleAssignments };
