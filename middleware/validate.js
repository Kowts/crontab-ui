'use strict';

const path = require('path');

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

function validateEnvironmentPayload(req, res, next) {
  const value = req.body.env_vars;
  if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) {
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
  validateIdParam,
  validateEnvironmentPayload,
  validateImportMetadata,
};
