'use strict';

const path = require('path');
const { parseEnvironment } = require('../config/environment');

function sanitizeFilename(name) {
  if (!name) return name;
  return path.basename(name);
}

function validateDbParam(req, res, next) {
  const db = req.query.db || req.body.db;
  if (db) {
    const sanitized = sanitizeFilename(db);
    if (sanitized !== db) {
      return res.status(400).json({ message: 'Invalid db parameter' });
    }
    req.dbName = sanitized;
  }
  next();
}

function validateIdParam(req, res, next) {
  const id = req.query.id || req.body._id;
  if (id) {
    if (/[^a-zA-Z0-9_-]/.test(id)) {
      return res.status(400).json({ message: 'Invalid id parameter' });
    }
    req.jobId = id;
  }
  next();
}

function validateBackupParam(req, res, next) {
  const db = req.query.db || req.body.db;
  if (typeof db !== 'string' || !/^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/.test(db)) {
    return res.status(400).json({ message: 'Invalid backup parameter' });
  }
  req.dbName = db;
  return next();
}

function validateEnvironmentPayload(req, res, next) {
  try {
    req.jobEnvironment = parseEnvironment(req.body.env_vars);
  } catch (_error) {
    return res.status(400).json({ message: 'Invalid environment variables payload' });
  }
  return next();
}

function validateImportMetadata(fieldName, filename) {
  return fieldName === 'import_file'
    && typeof filename === 'string'
    && filename.toLowerCase().endsWith('.db')
    && filename.length <= 255;
}

module.exports = {
  validateDbParam,
  validateBackupParam,
  validateIdParam,
  validateEnvironmentPayload,
  validateImportMetadata,
};
