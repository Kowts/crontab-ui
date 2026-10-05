'use strict';

const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;
const DEFAULT_TASK_ENV_ALLOWLIST = Object.freeze(['PATH', 'LANG', 'LC_ALL', 'TZ', 'MAILTO', 'COMMAND_TIMEOUT_MS']);
const WINDOWS_RUNTIME_VARIABLES = Object.freeze(['COMSPEC', 'PATHEXT', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'WINDIR']);
const FORBIDDEN_VARIABLES = new Set([
  'BASIC_AUTH_USER', 'BASIC_AUTH_PWD', 'BASIC_AUTH_USERS_JSON', 'CSRF_SECRET', 'MAIL_PROFILES_JSON',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
]);

function isForbidden(name) {
  return FORBIDDEN_VARIABLES.has(name) || name.startsWith('LD_') || name.startsWith('DYLD_');
}

function configuredTaskEnvironmentNames() {
  const raw = process.env.TASK_ENV_ALLOWLIST;
  const names = raw === undefined || raw.trim() === ''
    ? DEFAULT_TASK_ENV_ALLOWLIST
    : raw.split(',').map((name) => name.trim()).filter(Boolean);

  if (!names.length || names.some((name) => !VARIABLE_NAME.test(name) || isForbidden(name))) {
    throw new Error('TASK_ENV_ALLOWLIST must contain only safe uppercase environment variable names');
  }
  return new Set(names);
}

function processValue(name) {
  const matchingName = Object.keys(process.env).find((key) => key.toUpperCase() === name);
  return matchingName === undefined ? undefined : process.env[matchingName];
}

/**
 * Builds a fresh environment for task processes. It deliberately does not inherit
 * process.env, so web credentials and service secrets cannot be read by commands.
 */
function buildTaskEnvironment(configuredEnvironment = {}) {
  const allowlist = configuredTaskEnvironmentNames();
  const environment = {};
  const runtimeNames = process.platform === 'win32' ? WINDOWS_RUNTIME_VARIABLES : [];

  for (const name of new Set([...runtimeNames, ...allowlist])) {
    if (isForbidden(name)) continue;
    const value = processValue(name);
    if (value !== undefined) environment[name] = value;
  }

  for (const [name, value] of Object.entries(configuredEnvironment)) {
    if (allowlist.has(name) && !isForbidden(name)) environment[name] = value;
  }
  return environment;
}

module.exports = { buildTaskEnvironment, configuredTaskEnvironmentNames, isForbidden };
