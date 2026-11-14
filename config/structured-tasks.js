'use strict';

const { destinationPath } = require('./execution-environments');

const taskFields = new Set([
  'environment_id', 'script_path', 'working_directory', 'arguments', 'timeout_ms', 'environment_variables',
]);

function validateStructuredTask(value, maximumTimeoutMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !taskFields.has(key))) {
    throw Object.assign(new Error('Invalid structured execution payload'), { statusCode: 400 });
  }
  if (typeof value.environment_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.environment_id)) {
    throw Object.assign(new Error('Invalid execution environment id'), { statusCode: 422 });
  }
  const scriptPath = destinationPath(value.script_path);
  const workingDirectory = value.working_directory === undefined || value.working_directory === null || value.working_directory === ''
    ? null : destinationPath(value.working_directory);
  const args = value.arguments === undefined ? [] : value.arguments;
  if (!Array.isArray(args) || args.length > 100
    || args.some((argument) => typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0'))
    || args.reduce((length, argument) => length + argument.length, 0) > 16000) {
    throw Object.assign(new Error('Invalid structured execution arguments'), { statusCode: 422 });
  }
  const timeoutMs = value.timeout_ms === undefined ? maximumTimeoutMs : value.timeout_ms;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 24 * 60 * 60 * 1000
    || (maximumTimeoutMs !== 0 && timeoutMs > maximumTimeoutMs)
    || (maximumTimeoutMs !== 0 && timeoutMs === 0)) {
    throw Object.assign(new Error('Structured execution timeout exceeds the configured limit'), { statusCode: 422 });
  }
  const environmentVariables = value.environment_variables === undefined ? {} : value.environment_variables;
  if (!environmentVariables || typeof environmentVariables !== 'object' || Array.isArray(environmentVariables)
    || Object.keys(environmentVariables).length !== 0) {
    throw Object.assign(new Error('Per-task environment variables are not supported'), { statusCode: 422 });
  }
  return {
    environment_id: value.environment_id,
    script_path: scriptPath,
    working_directory: workingDirectory,
    arguments: args.slice(),
    timeout_ms: timeoutMs,
    environment_variables: {},
  };
}

module.exports = { validateStructuredTask };
