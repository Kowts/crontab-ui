'use strict';

const crontab = require('../crontab');
const { configuredRoles, operatorTaskPrivilegesEnabled } = require('./authorization');

function canManageTasks(req) {
  if (!req.app.locals.authEnabled) return true;
  const role = configuredRoles()[req.auth?.user];
  return role === 'admin' || (role === 'operator' && operatorTaskPrivilegesEnabled());
}

function canExecuteTasks(req) {
  if (!req.app.locals.authEnabled) return true;
  const role = configuredRoles()[req.auth?.user];
  return role === 'admin' || role === 'executor' || (role === 'operator' && operatorTaskPrivilegesEnabled());
}

function canAccessJob(req, job, action) {
  if (!req.app.locals.authEnabled) return true;
  const role = configuredRoles()[req.auth?.user];
  if (role === 'admin') return true;
  if (!job.owner) return false;
  if (job.owner !== req.auth?.user) return false;
  if (action === 'read') return ['viewer', 'executor', 'operator'].includes(role);
  if (action === 'execute') return canExecuteTasks(req);
  return canManageTasks(req);
}

function requireJobAccess(action) {
  return (req, res, next) => {
    if (!req.app.locals.authEnabled) return next();
    const jobId = req.body?._id || req.query?.id;
    // Without an identifier there is nothing to authorize against. Answering here keeps a
    // malformed request from reaching the datastore as a lookup for an empty key.
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) {
      return res.status(400).json({ message: 'Invalid or missing id parameter' });
    }
    crontab.get_crontab(jobId, (error, job) => {
      // A database failure is not the same as a task that does not exist, and must not be
      // answered as "not found": that would tell an operator the task is gone during an outage.
      if (error) return res.status(500).json({ message: 'Unable to read the task' });
      if (!job) return res.status(404).json({ message: 'Job not found' });
      if (!canAccessJob(req, job, action)) return res.status(403).json({ message: 'Not authorized for this job' });
      req.job = job;
      return next();
    });
  };
}

function requireSaveAccess(req, res, next) {
  const body = req.body || {};
  // Browser form encoding serialises the creation sentinel as a string.
  if (body._id === -1 || body._id === '-1') {
    if (canManageTasks(req)) return next();
    return res.status(403).json({ message: 'Operator task execution is disabled' });
  }
  if (typeof body._id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body._id)) return next();
  return requireJobAccess('write')(req, res, next);
}

module.exports = { canAccessJob, requireJobAccess, requireSaveAccess, canManageTasks, canExecuteTasks };
