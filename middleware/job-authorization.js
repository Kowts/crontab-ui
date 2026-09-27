'use strict';

const crontab = require('../crontab');
const { configuredRoles } = require('./authorization');

function canAccessJob(req, job, action) {
  if (!req.app.locals.authEnabled) return true;
  const role = configuredRoles()[req.auth?.user];
  if (role === 'admin') return true;
  if (!job.owner) return false;
  if (job.owner !== req.auth?.user) return false;
  if (action === 'read') return ['viewer', 'executor', 'operator'].includes(role);
  if (action === 'execute') return ['executor', 'operator'].includes(role);
  return role === 'operator';
}

function requireJobAccess(action) {
  return (req, res, next) => {
    if (!req.app.locals.authEnabled) return next();
    const jobId = req.body._id || req.query.id;
    crontab.get_crontab(jobId, (job) => {
      if (!job) return res.status(404).json({ message: 'Job not found' });
      if (!canAccessJob(req, job, action)) return res.status(403).json({ message: 'Not authorized for this job' });
      req.job = job;
      return next();
    });
  };
}

function requireSaveAccess(req, res, next) {
  // Browser form encoding serialises the creation sentinel as a string.
  if (req.body._id === -1 || req.body._id === '-1') return next();
  if (typeof req.body._id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(req.body._id)) return next();
  return requireJobAccess('write')(req, res, next);
}

module.exports = { canAccessJob, requireJobAccess, requireSaveAccess };
