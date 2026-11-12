'use strict';

const fs = require('fs');

const sensitiveKey = /pass(word)?|secret|token|authorization|api[-_]?key|credential|cookie/i;
const urlCredentials = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
const maxDepth = 6;

// Audit records are written by many callers; masking here guarantees that none of them can leak a
// secret into the log by passing it as metadata or inside an error message.
function redact(value, depth = 0) {
  if (typeof value === 'string') return value.replace(urlCredentials, '$1[REDACTED]@');
  if (value === null || typeof value !== 'object') return value;
  if (depth >= maxDepth) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, sensitiveKey.test(key) ? '[REDACTED]' : redact(item, depth + 1),
  ]));
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').reduce((records, line) => {
    if (!line) return records;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn or foreign line must not hide the remaining records.
    }
    return records;
  }, []);
}

// Newest first. Rotated files are included so a search is not limited to the active file.
function searchAudit(files, filters = {}, limit = 100) {
  const from = filters.from ? Date.parse(filters.from) : null;
  const to = filters.to ? Date.parse(filters.to) : null;
  const matches = (record) => {
    if (filters.jobId && record.jobId !== filters.jobId) return false;
    if (filters.type && record.type !== filters.type) return false;
    if (filters.status && record.status !== filters.status) return false;
    if (filters.trigger && record.trigger !== filters.trigger) return false;
    if (filters.operationId && record.operationId !== filters.operationId) return false;
    const time = Date.parse(record.timestamp);
    if (from !== null && !(time >= from)) return false;
    if (to !== null && !(time <= to)) return false;
    return true;
  };
  const results = [];
  for (const file of files) {
    const records = readRecords(file).filter(matches).reverse();
    results.push(...records);
    if (results.length >= limit) break;
  }
  return results.slice(0, limit);
}

module.exports = { redact, searchAudit };
