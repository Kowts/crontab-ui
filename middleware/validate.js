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

module.exports = { validateDbParam, validateIdParam };
