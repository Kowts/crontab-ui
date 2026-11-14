'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { CgroupManager } = require('./agent-cgroups');

function executionError(message, statusCode = 422, code = 'STRUCTURED_EXECUTION_REJECTED') {
  return Object.assign(new Error(message), { statusCode, code });
}

function configuredTrustedOwnerUids(value = process.env.STRUCTURED_EXECUTION_TRUSTED_OWNER_UIDS) {
  if (typeof value !== 'string' || !value.trim()) return [];
  const entries = value.split(',').map((item) => item.trim());
  if (entries.some((entry) => !/^\d+$/.test(entry))) {
    throw executionError('Structured execution trusted UID policy is invalid', 503, 'EXECUTOR_POLICY_INVALID');
  }
  const uids = entries.map(Number);
  if (uids.some((uid) => !Number.isSafeInteger(uid) || uid < 0)) {
    throw executionError('Structured execution trusted UID policy is invalid', 503, 'EXECUTOR_POLICY_INVALID');
  }
  return [...new Set(uids)];
}

function configuredRoots(value = process.env.STRUCTURED_EXECUTION_ROOTS, trustedOwnerUids = []) {
  if (process.platform !== 'linux') throw executionError('Structured container execution requires Linux', 503, 'EXECUTOR_UNAVAILABLE');
  if (typeof value !== 'string' || !value.trim()) {
    throw executionError('Structured execution roots are not configured', 503, 'EXECUTOR_UNAVAILABLE');
  }
  const roots = value.split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    if (!path.isAbsolute(item) || path.normalize(item) !== item || /[\0\r\n]/.test(item)) {
      throw executionError('Structured execution root policy is invalid', 503, 'EXECUTOR_POLICY_INVALID');
    }
    let canonical;
    try { canonical = fs.realpathSync(item); } catch (_error) {
      throw executionError('A configured structured execution root is unavailable', 503, 'EXECUTOR_POLICY_INVALID');
    }
    const stat = fs.statSync(canonical);
    if (!stat.isDirectory() || (stat.mode & 0o022)
      || (stat.uid === process.getuid() && !trustedOwnerUids.includes(stat.uid))) {
      throw executionError('A configured structured execution root has unsafe permissions', 503, 'EXECUTOR_POLICY_INVALID');
    }
    return canonical;
  });
  if (!roots.length || new Set(roots).size !== roots.length) {
    throw executionError('Structured execution roots are not configured correctly', 503, 'EXECUTOR_POLICY_INVALID');
  }
  return roots;
}

function configuredExecutables(value = process.env.STRUCTURED_EXECUTION_EXECUTABLES, trustedOwnerUids = []) {
  if (process.platform !== 'linux') throw executionError('Structured container execution requires Linux', 503, 'EXECUTOR_UNAVAILABLE');
  if (typeof value !== 'string' || !value.trim()) {
    throw executionError('Structured execution runtimes are not configured', 503, 'EXECUTOR_UNAVAILABLE');
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    if (!path.isAbsolute(item) || path.normalize(item) !== item || /[\0\r\n]/.test(item)) {
      throw executionError('Structured execution runtime policy is invalid', 503, 'EXECUTOR_POLICY_INVALID');
    }
    let canonical;
    try { canonical = fs.realpathSync(item); } catch (_error) {
      throw executionError('A configured structured runtime is unavailable', 503, 'EXECUTOR_POLICY_INVALID');
    }
    const stat = fs.statSync(canonical);
    try { fs.accessSync(canonical, fs.constants.X_OK); } catch (_error) {
      throw executionError('A configured structured runtime is not executable', 503, 'EXECUTOR_POLICY_INVALID');
    }
    if (!stat.isFile() || (stat.mode & 0o022)
      || (stat.uid === process.getuid() && !trustedOwnerUids.includes(stat.uid))) {
      throw executionError('A configured structured runtime has unsafe permissions', 503, 'EXECUTOR_POLICY_INVALID');
    }
    return canonical;
  });
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalPath(candidate, { roots, kind, executable = false, unrestrictedParents = false, trustedOwnerUids = [] }) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || path.normalize(candidate) !== candidate
    || /[\0\r\n]/.test(candidate)) {
    throw executionError('Structured execution path is invalid');
  }
  let resolved;
  try { resolved = fs.realpathSync(candidate); } catch (_error) {
    throw executionError('A structured execution path is unavailable');
  }
  const root = roots.find((item) => isWithin(item, resolved));
  if (!unrestrictedParents && !root) throw executionError('A structured execution path is outside the configured roots', 403, 'EXECUTOR_POLICY_DENIED');
  let stat;
  try { stat = fs.statSync(resolved); } catch (_error) {
    throw executionError('A structured execution path is unavailable');
  }
  if ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory())
    || (typeof process.getuid === 'function' && stat.uid === process.getuid() && !trustedOwnerUids.includes(stat.uid))) {
    throw executionError('A structured execution path has the wrong type');
  }
  if (executable) {
    try { fs.accessSync(resolved, fs.constants.X_OK); } catch (_error) {
      throw executionError('The configured runtime is not executable');
    }
  }
  const stopAt = unrestrictedParents ? path.parse(resolved).root : root;
  let current = kind === 'file' ? path.dirname(resolved) : resolved;
  while (current && isWithin(stopAt, current)) {
    let ancestor;
    try { ancestor = fs.statSync(current); } catch (_error) {
      throw executionError('A structured execution directory is unavailable');
    }
    if ((ancestor.mode & 0o022) || (typeof process.getuid === 'function'
      && ancestor.uid === process.getuid() && !trustedOwnerUids.includes(ancestor.uid))) {
      throw executionError('A structured execution path has unsafe writable permissions', 403, 'EXECUTOR_POLICY_DENIED');
    }
    if (current === stopAt) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const fingerprint = crypto.createHash('sha256')
    .update(resolved)
    .update(String(stat.dev))
    .update(String(stat.ino))
    .update(String(stat.size))
    .update(String(stat.mtimeMs))
    .digest('hex');
  return { path: resolved, root: root || null, fingerprint };
}

function executableInfo(environment, approvedExecutables, trustedOwnerUids = []) {
  const executable = canonicalPath(environment.executablePath, {
    roots: [], kind: 'file', executable: true, unrestrictedParents: true, trustedOwnerUids,
  });
  let linkStat;
  try { linkStat = fs.lstatSync(environment.executablePath); } catch (_error) {
    throw executionError('The configured runtime is unavailable');
  }
  if (linkStat.isSymbolicLink()) {
    if (linkStat.uid === process.getuid() && !trustedOwnerUids.includes(linkStat.uid)) {
      throw executionError('The configured runtime link has unsafe ownership', 403, 'EXECUTOR_POLICY_DENIED');
    }
    let parent = path.dirname(environment.executablePath);
    while (true) {
      let stat;
      try { stat = fs.statSync(parent); } catch (_error) {
        throw executionError('The configured runtime link directory is unavailable');
      }
      if ((stat.mode & 0o022) || (stat.uid === process.getuid() && !trustedOwnerUids.includes(stat.uid))) {
        throw executionError('The configured runtime link path has unsafe permissions', 403, 'EXECUTOR_POLICY_DENIED');
      }
      if (parent === path.parse(parent).root) break;
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  if (!approvedExecutables.includes(executable.path)) {
    throw executionError('The runtime is not in the local executable allowlist', 403, 'EXECUTOR_POLICY_DENIED');
  }
  return { ...executable, launchPath: environment.executablePath };
}

function probeExecutionEnvironment(environment, callback, options = {}) {
  let roots;
  let executable;
  try {
    if (!['container-local', 'native-local'].includes(environment.targetId)) {
      throw executionError('The local execution agent is unavailable', 503, 'EXECUTOR_UNAVAILABLE');
    }
    if (environment.targetId === 'native-local' && process.env.CRON_IN_DOCKER === 'true') {
      throw executionError('Native local execution is unavailable inside Docker', 503, 'EXECUTOR_UNAVAILABLE');
    }
    const trustedOwnerUids = environment.targetId === 'native-local'
      ? configuredTrustedOwnerUids(options.trustedOwnerUids) : [];
    roots = configuredRoots(options.scriptRoots, trustedOwnerUids);
    executable = executableInfo(environment, configuredExecutables(options.executables, trustedOwnerUids), trustedOwnerUids);
    if (environment.targetId === 'native-local') createNativeExecutionPolicy(options);
  } catch (error) {
    return callback(error);
  }

  const probeArgs = {
    python: ['--version'],
    node: ['--version'],
    bash: ['--version'],
  }[environment.runtimeType];
  if (!probeArgs) return callback(null, { runtimeVersion: 'unverified', message: 'Executable permissions verified; binary version is not probed.' });

  let child;
  try {
    child = spawn(executable.launchPath, probeArgs, {
      shell: false,
      cwd: roots[0],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (_error) {
    return callback(executionError('The configured runtime could not be started'));
  }
  let output = '';
  let settled = false;
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(error, result);
  };
  const collect = (chunk) => {
    output += chunk.toString('utf8');
    if (output.length > 4096) {
      child.kill('SIGKILL');
      finish(executionError('Runtime validation output exceeded its limit'));
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.once('error', () => finish(executionError('The configured runtime could not be started')));
  child.once('close', (code) => {
    if (code !== 0) return finish(executionError('The configured runtime validation failed'));
    const runtimeVersion = output.split(/\r?\n/, 1)[0].trim().slice(0, 120);
    return finish(null, { runtimeVersion: runtimeVersion || 'unknown', message: 'Runtime validation completed.' });
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish(executionError('Runtime validation timed out'));
  }, 5000);
  return roots;
}

function createNativeExecutionPolicy(options = {}) {
  if (process.platform !== 'linux') throw executionError('Native structured execution requires Linux', 503, 'EXECUTOR_UNAVAILABLE');
  if (process.env.CRON_IN_DOCKER === 'true') {
    throw executionError('Native local execution is unavailable inside Docker', 503, 'EXECUTOR_UNAVAILABLE');
  }
  const wrapperPath = options.wrapperPath || process.env.STRUCTURED_EXECUTION_CGROUP_WRAPPER;
  if (typeof wrapperPath !== 'string' || !path.isAbsolute(wrapperPath)) {
    throw executionError('The native cgroup execution wrapper is not configured', 503, 'EXECUTOR_POLICY_INVALID');
  }
  let realWrapper;
  let wrapperStat;
  try {
    realWrapper = fs.realpathSync(wrapperPath);
    wrapperStat = fs.statSync(realWrapper);
    fs.accessSync(realWrapper, fs.constants.X_OK);
  } catch (_error) {
    throw executionError('The native cgroup execution wrapper is unavailable', 503, 'EXECUTOR_POLICY_INVALID');
  }
  if (realWrapper !== wrapperPath || !wrapperStat.isFile() || wrapperStat.uid !== 0 || (wrapperStat.mode & 0o022)) {
    throw executionError('The native cgroup execution wrapper has unsafe ownership or permissions', 503, 'EXECUTOR_POLICY_INVALID');
  }
  const memoryMaxBytes = Number(options.memoryMaxBytes ?? process.env.STRUCTURED_EXECUTION_MEMORY_MAX_BYTES ?? 536870912);
  const cpuQuotaPercent = Number(options.cpuQuotaPercent ?? process.env.STRUCTURED_EXECUTION_CPU_QUOTA_PERCENT ?? 100);
  const pidsMax = Number(options.pidsMax ?? process.env.STRUCTURED_EXECUTION_PIDS_MAX ?? 64);
  if (!Number.isSafeInteger(memoryMaxBytes) || memoryMaxBytes < 16777216 || memoryMaxBytes > 1099511627776
    || !Number.isSafeInteger(cpuQuotaPercent) || cpuQuotaPercent < 1 || cpuQuotaPercent > 1000
    || !Number.isSafeInteger(pidsMax) || pidsMax < 1 || pidsMax > 65536) {
    throw executionError('Native cgroup resource policy is invalid', 503, 'EXECUTOR_POLICY_INVALID');
  }
  let cgroupManager;
  try {
    cgroupManager = new CgroupManager({ memoryMaxBytes, cpuQuotaPercent, pidsMax });
  } catch (_error) {
    throw executionError('Native structured execution requires delegated cgroup v2 controllers', 503, 'CGROUP_UNAVAILABLE');
  }
  return { cgroupManager, wrapperPath: realWrapper };
}

function prepareStructuredExecution(job, environment, options = {}) {
  if (!environment) throw executionError('Execution environment does not exist', 422);
  if (!environment.enabled) throw executionError('Execution environment is disabled', 409, 'ENVIRONMENT_DISABLED');
  if (!['container-local', 'native-local'].includes(environment.targetId)) {
    throw executionError('The local execution agent is unavailable', 503, 'EXECUTOR_UNAVAILABLE');
  }
  if (environment.validationStatus !== 'valid') {
    throw executionError('Execution environment must be validated before use', 409, 'ENVIRONMENT_NOT_VALIDATED');
  }
  const trustedOwnerUids = environment.targetId === 'native-local'
    ? configuredTrustedOwnerUids(options.trustedOwnerUids) : [];
  const roots = configuredRoots(options.scriptRoots, trustedOwnerUids);
  const executable = executableInfo(environment, configuredExecutables(options.executables, trustedOwnerUids), trustedOwnerUids);
  const structured = job.structured_execution;
  if (!structured || !Array.isArray(structured.arguments) || Object.keys(structured.environment_variables || {}).length) {
    throw executionError('Structured task definition is invalid');
  }
  const script = canonicalPath(structured.script_path, { roots, kind: 'file', trustedOwnerUids });
  const extensions = { python: ['.py'], node: ['.js', '.mjs', '.cjs'], bash: ['.sh'], binary: null };
  const allowedExtensions = extensions[environment.runtimeType];
  if (!Object.hasOwn(extensions, environment.runtimeType)
    || (allowedExtensions && !allowedExtensions.includes(path.extname(script.path).toLowerCase()))) {
    throw executionError('Script extension does not match the execution runtime');
  }
  const workingDirectory = structured.working_directory || environment.defaultWorkingDirectory || path.dirname(script.path);
  const working = canonicalPath(workingDirectory, { roots, kind: 'directory', trustedOwnerUids });
  const timeoutMs = structured.timeout_ms;
  const maximumTimeoutMs = options.maximumTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 24 * 60 * 60 * 1000
    || (maximumTimeoutMs !== undefined && maximumTimeoutMs !== 0 && timeoutMs > maximumTimeoutMs)
    || (maximumTimeoutMs !== undefined && maximumTimeoutMs !== 0 && timeoutMs === 0)) {
    throw executionError('Structured execution timeout exceeds the configured limit');
  }
  const processEnvironment = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG && !/[\0\r\n]/.test(process.env.LANG) ? process.env.LANG : 'C.UTF-8',
  };
  for (const name of ['LC_ALL', 'TZ']) {
    if (process.env[name] && !/[\0\r\n]/.test(process.env[name])) processEnvironment[name] = process.env[name];
  }
  const plan = {
    executable: executable.launchPath,
    args: [script.path, ...structured.arguments],
    cwd: working.path,
    env: processEnvironment,
    timeoutMs,
    runtime: {
      executionMode: 'structured',
      environmentId: environment.id,
      environmentRevision: environment.revision,
      runtimeType: environment.runtimeType,
      executableFingerprint: executable.fingerprint,
      scriptPath: script.path,
      scriptFingerprint: script.fingerprint,
    },
  };
  if (environment.targetId === 'native-local') return { ...plan, ...createNativeExecutionPolicy(options) };
  return plan;
}

module.exports = {
  configuredExecutables,
  configuredRoots,
  configuredTrustedOwnerUids,
  createNativeExecutionPolicy,
  prepareStructuredExecution,
  probeExecutionEnvironment,
};
