'use strict';

const path = require('path');

const runtimeTypes = new Set(['python', 'node', 'bash', 'binary']);
const targetIds = new Set(['container-local', 'native-local', 'ubuntu-local']);
const writableFields = new Set([
  'name', 'runtime_type', 'target_id', 'executable_path', 'default_working_directory', 'description', 'enabled',
]);

function destinationPath(value, optional = false) {
  if (optional && value === undefined) return undefined;
  if (optional && value === null) return null;
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n\\]/.test(value)
    || !value.startsWith('/') || value === '/' || path.posix.normalize(value) !== value) {
    throw Object.assign(new Error('Path must be an absolute, normalised path in the execution target'), { statusCode: 422 });
  }
  return value;
}

function validateEnvironmentPayload(payload, { partial = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Object.assign(new Error('Invalid execution environment payload'), { statusCode: 400 });
  }
  const allowedFields = new Set([...writableFields, ...(partial ? ['revision'] : ['code'])]);
  if (Object.keys(payload).some((key) => !allowedFields.has(key))) {
    throw Object.assign(new Error('Unknown execution environment field'), { statusCode: 400 });
  }

  if (partial && (!Number.isSafeInteger(payload.revision) || payload.revision < 1)) {
    throw Object.assign(new Error('A valid environment revision is required'), { statusCode: 400 });
  }
  if (partial && !Object.keys(payload).some((key) => writableFields.has(key))) {
    throw Object.assign(new Error('At least one environment field must be updated'), { statusCode: 400 });
  }
  if (!partial && (typeof payload.code !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(payload.code))) {
    throw Object.assign(new Error('Invalid environment code'), { statusCode: 422 });
  }

  const required = partial ? [] : ['name', 'runtime_type', 'target_id', 'executable_path'];
  for (const key of required) {
    if (!Object.hasOwn(payload, key)) throw Object.assign(new Error(`Missing environment field: ${key}`), { statusCode: 422 });
  }

  const result = {};
  if (!partial || Object.hasOwn(payload, 'name')) {
    if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.trim().length > 120 || /[\r\n]/.test(payload.name)) {
      throw Object.assign(new Error('Invalid environment name'), { statusCode: 422 });
    }
    result.name = payload.name.trim();
  }
  if (!partial || Object.hasOwn(payload, 'runtime_type')) {
    if (!runtimeTypes.has(payload.runtime_type)) throw Object.assign(new Error('Invalid runtime type'), { statusCode: 422 });
    result.runtimeType = payload.runtime_type;
  }
  if (!partial || Object.hasOwn(payload, 'target_id')) {
    if (!targetIds.has(payload.target_id)) throw Object.assign(new Error('Invalid execution target'), { statusCode: 422 });
    result.targetId = payload.target_id;
  }
  if (!partial || Object.hasOwn(payload, 'executable_path')) {
    result.executablePath = destinationPath(payload.executable_path);
  }
  if (Object.hasOwn(payload, 'default_working_directory')) {
    result.defaultWorkingDirectory = destinationPath(payload.default_working_directory, true);
  }
  if (Object.hasOwn(payload, 'description')) {
    if (payload.description !== null && (typeof payload.description !== 'string' || payload.description.length > 2000)) {
      throw Object.assign(new Error('Invalid environment description'), { statusCode: 422 });
    }
    result.description = payload.description;
  }
  if (Object.hasOwn(payload, 'enabled')) {
    if (typeof payload.enabled !== 'boolean') throw Object.assign(new Error('Invalid enabled value'), { statusCode: 422 });
    result.enabled = payload.enabled;
  } else if (!partial) {
    result.enabled = true;
  }
  if (partial) result.revision = payload.revision;
  if (!partial) result.code = payload.code;
  return result;
}

function validateEnvironmentFilters(query) {
  const filters = {};
  if (query.target_id !== undefined) {
    if (!targetIds.has(query.target_id)) throw Object.assign(new Error('Invalid execution target filter'), { statusCode: 400 });
    filters.targetId = query.target_id;
  }
  if (query.runtime_type !== undefined) {
    if (!runtimeTypes.has(query.runtime_type)) throw Object.assign(new Error('Invalid runtime type filter'), { statusCode: 400 });
    filters.runtimeType = query.runtime_type;
  }
  if (query.enabled !== undefined) {
    if (!['true', 'false'].includes(query.enabled)) throw Object.assign(new Error('Invalid enabled filter'), { statusCode: 400 });
    filters.enabled = query.enabled === 'true';
  }
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    throw Object.assign(new Error('Invalid pagination'), { statusCode: 400 });
  }
  filters.limit = limit;
  filters.offset = offset;
  return filters;
}

module.exports = { destinationPath, validateEnvironmentPayload, validateEnvironmentFilters };
