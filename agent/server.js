'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const packageJson = require('../package.json');
const { verifyAgentRequest } = require('../lib/agent-protocol');
const { resolveEnvironment, resolveTask } = require('../lib/local-agent-policy');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_LOG_PAGE_BYTES = 64 * 1024;

function isWindowsPipe(socketPath) {
  return process.platform === 'win32' && socketPath.startsWith('\\\\.\\pipe\\');
}

function safeError(error) {
  return {
    statusCode: Number.isInteger(error.statusCode) ? error.statusCode : 500,
    code: typeof error.code === 'string' ? error.code : 'AGENT_REQUEST_FAILED',
    message: error.statusCode ? error.message : 'Local execution agent request failed',
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function fingerprintRequest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function fileStat(pathname, kind, ownerUids, expectedRealPath = null) {
  let realPath;
  let stat;
  let linkStat;
  try {
    linkStat = fs.lstatSync(pathname);
    realPath = fs.realpathSync(pathname);
    stat = fs.statSync(realPath);
  } catch (_error) {
    throw Object.assign(new Error('An approved execution file is unavailable'), { statusCode: 403, code: 'AGENT_FILE_UNAVAILABLE' });
  }
  const isApprovedExecutableLink = kind === 'file' && linkStat.isSymbolicLink()
    && typeof expectedRealPath === 'string' && realPath === expectedRealPath && ownerUids.includes(linkStat.uid);
  if ((realPath !== pathname && !isApprovedExecutableLink)
    || (expectedRealPath && realPath !== expectedRealPath)
    || (kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory())
    || !ownerUids.includes(stat.uid) || stat.uid === process.getuid() || (stat.mode & 0o022)) {
    throw Object.assign(new Error('An approved execution file has unsafe ownership or permissions'), { statusCode: 403, code: 'AGENT_FILE_POLICY_DENIED' });
  }
  let current = kind === 'file' ? path.dirname(realPath) : realPath;
  while (true) {
    let parentStat;
    try { parentStat = fs.statSync(current); } catch (_error) {
      throw Object.assign(new Error('An execution path ancestor is unavailable'), { statusCode: 403, code: 'AGENT_FILE_POLICY_DENIED' });
    }
    if ((parentStat.mode & 0o022) || parentStat.uid === process.getuid()) {
      throw Object.assign(new Error('An execution path ancestor is writable by group or others'), { statusCode: 403, code: 'AGENT_FILE_POLICY_DENIED' });
    }
    if (current === path.parse(current).root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (isApprovedExecutableLink) {
    current = path.dirname(pathname);
    while (true) {
      let parentStat;
      try { parentStat = fs.statSync(current); } catch (_error) {
        throw Object.assign(new Error('An executable link ancestor is unavailable'), { statusCode: 403, code: 'AGENT_FILE_POLICY_DENIED' });
      }
      if ((parentStat.mode & 0o022) || parentStat.uid === process.getuid()) {
        throw Object.assign(new Error('An executable link ancestor is writable by group, others, or the agent'), { statusCode: 403, code: 'AGENT_FILE_POLICY_DENIED' });
      }
      if (current === path.parse(current).root) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return {
    path: pathname,
    realPath,
    fingerprint: crypto.createHash('sha256').update(`${realPath}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`).digest('hex'),
  };
}

function runtimeVersion(environment, cwd) {
  const args = { python: ['--version'], node: ['--version'], bash: ['--version'], binary: null }[environment.runtime_type];
  if (!args) return Promise.resolve('unverified');
  return new Promise((resolve, reject) => {
    const child = spawn(environment.executable, args, {
      shell: false,
      cwd,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let completed = false;
    const finish = (error, value) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const collect = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 4096) {
        child.kill('SIGKILL');
        finish(Object.assign(new Error('Runtime validation output exceeded its limit'), { statusCode: 422, code: 'AGENT_VALIDATION_OUTPUT_LIMIT' }));
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', () => finish(Object.assign(new Error('Runtime validation could not start'), { statusCode: 422, code: 'AGENT_RUNTIME_INVALID' })));
    child.once('close', (code) => code === 0
      ? finish(null, output.split(/\r?\n/, 1)[0].trim().slice(0, 120) || 'unknown')
      : finish(Object.assign(new Error('Runtime validation failed'), { statusCode: 422, code: 'AGENT_RUNTIME_INVALID' })));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(Object.assign(new Error('Runtime validation timed out'), { statusCode: 422, code: 'AGENT_RUNTIME_TIMEOUT' }));
    }, 5000);
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        reject(Object.assign(new Error('Request body exceeds its limit'), { statusCode: 413, code: 'AGENT_REQUEST_TOO_LARGE' }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', () => reject(Object.assign(new Error('Unable to read request body'), { statusCode: 400, code: 'AGENT_REQUEST_INVALID' })));
  });
}

function respond(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function readProcStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    return stat.slice(end + 2).split(/\s+/)[19] || null;
  } catch (_error) {
    return null;
  }
}

function createAgentServer(options) {
  const { cgroups, logDirectory, policy, secret, socketPath, store, wrapperPath } = options;
  const validateExecutionPath = options.fileStat || fileStat;
  const spawnProcess = options.spawnProcess || spawn;
  const createWriteStream = options.createWriteStream || fs.createWriteStream;
  const controllers = new Map();
  const validationRates = new Map();
  let requestWindowStarted = Date.now();
  let requestWindowCount = 0;
  let activeRequests = 0;
  let retentionTimer;
  const auditFile = path.join(logDirectory, 'agent-audit.jsonl');
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(logDirectory, 0o700);

  const audit = (event) => {
    try {
      if (fs.existsSync(auditFile) && fs.statSync(auditFile).size >= 10 * 1024 * 1024) {
        const oldest = `${auditFile}.5`;
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
        for (let index = 4; index >= 1; index -= 1) {
          const source = `${auditFile}.${index}`;
          if (fs.existsSync(source)) fs.renameSync(source, `${auditFile}.${index + 1}`);
        }
        fs.renameSync(auditFile, `${auditFile}.1`);
      }
      fs.appendFileSync(auditFile, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(auditFile, 0o600);
    } catch (error) {
      console.error(`Agent audit persistence failed (${error.code || 'I/O error'})`);
    }
  };

  const pruneLogs = () => {
    const cutoff = Date.now() - policy.log_retention_days * 24 * 60 * 60 * 1000;
    try {
      const unknownOperations = new Set(store.listOperations()
        .filter((execution) => execution.status === 'unknown')
        .map((execution) => execution.operationId));
      for (const entry of fs.readdirSync(logDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[0-9a-f-]{36}\.(stdout|stderr)$/.test(entry.name)) continue;
        if (unknownOperations.has(entry.name.slice(0, 36))) continue;
        const filename = path.join(logDirectory, entry.name);
        if (fs.statSync(filename).mtimeMs < cutoff) fs.unlinkSync(filename);
      }
      store.pruneCompleted(cutoff);
    } catch (error) {
      audit({ operation: 'retention_failed', errorCode: error.code || 'IO_ERROR' });
    }
  };

  function validateEnvironment(body) {
    if (!body || Object.keys(body).some((key) => !['environment_code', 'environment_revision', 'executable_path'].includes(key))
      || typeof body.executable_path !== 'string') {
      throw Object.assign(new Error('Invalid environment validation request'), { statusCode: 400, code: 'AGENT_REQUEST_INVALID' });
    }
    const environment = resolveEnvironment(policy, body.environment_code, body.environment_revision);
    let requestedExecutable;
    try { requestedExecutable = fs.realpathSync(body.executable_path); } catch (_error) {
      throw Object.assign(new Error('The configured runtime is unavailable'), { statusCode: 422, code: 'AGENT_RUNTIME_INVALID' });
    }
    if (requestedExecutable !== environment.executable_realpath) {
      throw Object.assign(new Error('The configured runtime does not match the host policy'), { statusCode: 409, code: 'AGENT_POLICY_REVISION_MISMATCH' });
    }
    const executable = validateExecutionPath(environment.executable, 'file', environment.executable_owner_uids, environment.executable_realpath);
    for (const task of Object.values(environment.tasks)) {
      validateExecutionPath(task.script_path, 'file', task.script_owner_uids);
      validateExecutionPath(task.working_directory, 'directory', task.working_directory_owner_uids);
    }
    const cwd = Object.values(environment.tasks)[0]?.working_directory || '/';
    return runtimeVersion(environment, cwd).then((version) => ({
      validation_status: 'valid', runtime_version: version, agent_version: packageJson.version,
      executable_fingerprint: executable.fingerprint,
    }));
  }

  function operationReply(record) {
    return {
      operation_id: record.operationId,
      status: record.status,
      submitted_at: record.submittedAt,
      accepted_at: record.acceptedAt,
      started_at: record.startedAt,
      completed_at: record.completedAt,
      exit_code: record.exitCode,
      signal: record.signal,
      termination_reason: record.terminationReason,
      duration_ms: record.durationMs,
      output_bytes: record.outputBytes,
      output_truncated: record.outputTruncated,
      error_code: record.errorCode,
    };
  }

  function cancelOperation(operationId) {
    const execution = store.getOperation(operationId);
    if (!execution) throw Object.assign(new Error('Execution not found'), { statusCode: 404, code: 'AGENT_EXECUTION_NOT_FOUND' });
    const controller = controllers.get(operationId);
    if (!controller || !['accepted', 'running'].includes(execution.status)) return { accepted: false, already_terminal: true };
    controller.terminate('cancelled');
    return { accepted: true, already_terminal: false };
  }

  function startExecution(body) {
    if (!body || typeof body.operation_id !== 'string' || !UUID.test(body.operation_id)) {
      throw Object.assign(new Error('Invalid operation ID'), { statusCode: 400, code: 'AGENT_REQUEST_INVALID' });
    }
    const fingerprint = fingerprintRequest(body);
    const previous = store.getOperation(body.operation_id);
    if (previous) {
      if (previous.requestFingerprint !== fingerprint) {
        throw Object.assign(new Error('Operation ID conflicts with a previous request'), { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
      }
      return { accepted: true, existing: true, execution: operationReply(previous) };
    }
    const { environment, task } = resolveTask(policy, body);
    const executable = validateExecutionPath(environment.executable, 'file', environment.executable_owner_uids, environment.executable_realpath);
    const script = validateExecutionPath(task.script_path, 'file', task.script_owner_uids);
    const working = validateExecutionPath(task.working_directory, 'directory', task.working_directory_owner_uids);
    const operation = store.acceptOperation({
      operationId: body.operation_id,
      fingerprint,
      taskId: body.task_id,
      environmentCode: body.environment_code,
      environmentRevision: body.environment_revision,
      maxConcurrent: policy.max_concurrent,
    });
    if (operation.existing) return { accepted: true, existing: true, execution: operationReply(operation.execution) };

    let cgroup;
    let stdout;
    let stderr;
    let child;
    let terminationReason = null;
    let outputBytes = 0;
    let outputTruncated = false;
    let outputError = null;
    let finalized = false;
    let killTimer;
    const startedAt = Date.now();
    const stdoutPath = path.join(logDirectory, `${body.operation_id}.stdout`);
    const stderrPath = path.join(logDirectory, `${body.operation_id}.stderr`);
    const closeOutputStream = (stream) => new Promise((resolve) => {
      if (!stream || stream.closed || stream.writableFinished) return resolve();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        stream.removeListener('finish', finish);
        stream.removeListener('error', finish);
        stream.removeListener('close', finish);
        resolve();
      };
      stream.once('finish', finish);
      stream.once('error', finish);
      stream.once('close', finish);
      if (!stream.destroyed) stream.end();
    });
    const finish = (error, exitCode, signal) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      const finalError = error || outputError;
      const status = terminationReason === 'timeout' ? 'timeout'
        : terminationReason === 'cancelled' ? 'cancelled'
          : terminationReason === 'output_limit' ? 'output_limit'
            : terminationReason === 'output_error' || finalError || exitCode !== 0 ? 'failed' : 'completed';
      Promise.all([closeOutputStream(stdout), closeOutputStream(stderr)]).then(() => {
        store.complete(body.operation_id, {
          status, exitCode, signal, terminationReason, durationMs: Date.now() - startedAt,
          outputBytes, outputTruncated,
          errorCode: outputError ? 'OUTPUT_PERSISTENCE_FAILED' : finalError ? 'EXECUTION_FAILED' : null,
        });
        if (cgroup) cgroups.remove(cgroup);
        controllers.delete(body.operation_id);
        audit({ operation: 'execution_finished', operationId: body.operation_id, taskId: body.task_id, status, exitCode, signal, durationMs: Date.now() - startedAt, outputBytes, outputTruncated });
      }).catch((storeError) => {
        audit({ operation: 'execution_state_persistence_failed', operationId: body.operation_id, errorCode: storeError.code || 'IO_ERROR' });
        if (cgroup) cgroups.kill(cgroup);
      });
    };
    const controller = {
      terminate(reason) {
        if (terminationReason || finalized) return;
        terminationReason = reason;
        try { process.kill(-child.pid, 'SIGTERM'); } catch (_error) { /* cgroup kill remains authoritative */ }
        killTimer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (_error) { /* process may already be gone */ }
          cgroups.kill(cgroup);
        }, options.killGraceMs || 5000);
      },
    };
    const handleOutputError = (error) => {
      if (!outputError) outputError = error;
      if (child?.pid) controller.terminate('output_error');
      else finish(error, null, null);
    };
    controllers.set(body.operation_id, controller);

    try {
      cgroup = cgroups.create(body.operation_id);
      stdout = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 });
      stdout.on('error', handleOutputError);
      stderr = createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 });
      stderr.on('error', handleOutputError);
      child = spawnProcess(wrapperPath, [cgroup.name, working.path, executable.path, script.path, ...body.arguments], {
        shell: false,
        cwd: '/',
        detached: true,
        env: {
          CRONTAB_UI_AGENT_CGROUP_ROOT: cgroups.root,
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!store.setRunning(body.operation_id, {
        pid: child.pid,
        pidStartedAt: readProcStartTime(child.pid),
        stdoutPath,
        stderrPath,
        startedAt,
      })) throw Object.assign(new Error('Execution state changed before start'), { code: 'AGENT_STATE_CONFLICT' });
    } catch (_error) {
      if (stdout) stdout.destroy();
      if (stderr) stderr.destroy();
      try { fs.rmSync(stdoutPath, { force: true }); fs.rmSync(stderrPath, { force: true }); } catch (_cleanupError) { /* best effort */ }
      if (cgroup) cgroups.remove(cgroup);
      controllers.delete(body.operation_id);
      store.complete(body.operation_id, { status: 'failed', errorCode: 'EXECUTOR_START_FAILED' });
      audit({ operation: 'execution_rejected', operationId: body.operation_id, taskId: body.task_id, reason: 'executor_start_failed' });
      throw Object.assign(new Error('Unable to start approved execution'), { statusCode: 503, code: 'EXECUTOR_START_FAILED' });
    }

    const collect = (stream) => (chunk) => {
      const allowed = Math.max(0, policy.max_output_bytes - outputBytes);
      if (allowed > 0) {
        const kept = chunk.subarray(0, allowed);
        stream.write(kept);
        outputBytes += kept.length;
      }
      if (chunk.length > allowed && !outputTruncated) {
        outputTruncated = true;
        controller.terminate('output_limit');
      }
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (error) => finish(error, null, null));
    child.once('close', (exitCode, signal) => finish(null, exitCode, signal));
    const timeout = body.timeout_ms === 0 ? null : setTimeout(() => controller.terminate('timeout'), body.timeout_ms);
    audit({ operation: 'execution_started', operationId: body.operation_id, taskId: body.task_id, environmentCode: body.environment_code, environmentRevision: body.environment_revision, executableFingerprint: executable.fingerprint, scriptFingerprint: script.fingerprint, pid: child.pid });
    return { accepted: true, existing: false, execution: operationReply(store.getOperation(body.operation_id)) };
  }

  async function handle(request, response) {
    let rawBody;
    try {
      rawBody = await readRequestBody(request);
      const headers = {
        timestamp: request.headers['x-agent-timestamp'],
        nonce: request.headers['x-agent-nonce'],
        signature: request.headers['x-agent-signature'],
      };
      if (!verifyAgentRequest(secret, rawBody, headers)) {
        audit({ operation: 'request_rejected', reason: 'authentication_failed', method: request.method, path: request.url });
        return respond(response, 401, { error: 'AGENT_AUTHENTICATION_FAILED', message: 'Agent authentication failed' });
      }
      if (!store.recordNonce(headers.nonce)) {
        audit({ operation: 'request_rejected', reason: 'replay', nonce: headers.nonce });
        return respond(response, 409, { error: 'AGENT_REPLAY_REJECTED', message: 'Request replay rejected' });
      }
      const now = Date.now();
      if (now - requestWindowStarted >= 60_000) {
        requestWindowStarted = now;
        requestWindowCount = 0;
      }
      requestWindowCount += 1;
      if (requestWindowCount > 1200) {
        return respond(response, 429, { error: 'AGENT_RATE_LIMITED', message: 'Agent request rate limit exceeded' });
      }
      let body = {};
      if (rawBody) {
        try { body = JSON.parse(rawBody); } catch (_error) {
          return respond(response, 400, { error: 'AGENT_REQUEST_INVALID', message: 'Invalid JSON request body' });
        }
      }

      if (request.method === 'POST' && request.url === '/v1/health') {
        return respond(response, 200, {
          agent_id: policy.agent_id,
          protocol_version: 1,
          version: packageJson.version,
          status: 'online',
          capabilities: ['validate_environment', 'submit_execution', 'get_execution', 'get_logs', 'cancel_execution', 'list_active'],
        });
      }
      if (request.method === 'POST' && request.url === '/v1/validate-environment') {
        const code = typeof body.environment_code === 'string' ? body.environment_code : '';
        const previous = validationRates.get(code);
        if (!previous || now - previous.startedAt >= 60_000) validationRates.set(code, { startedAt: now, count: 1 });
        else if (previous.count >= 10) {
          return respond(response, 429, { error: 'AGENT_VALIDATION_RATE_LIMITED', message: 'Environment validation rate limit exceeded' });
        } else previous.count += 1;
        if (validationRates.size > 100) {
          for (const [key, value] of validationRates) if (now - value.startedAt >= 60_000) validationRates.delete(key);
          if (validationRates.size > 100) return respond(response, 429, { error: 'AGENT_VALIDATION_RATE_LIMITED', message: 'Environment validation rate limit exceeded' });
        }
        const result = await validateEnvironment(body);
        audit({ operation: 'environment_validated', environmentCode: body.environment_code, revision: body.environment_revision, status: 'valid' });
        return respond(response, 200, result);
      }
      if (request.method === 'POST' && request.url === '/v1/submit-execution') {
        const result = startExecution(body);
        return respond(response, 202, result);
      }
      if (request.method === 'POST' && request.url === '/v1/cancel-execution') {
        if (!body || Object.keys(body).some((key) => key !== 'operation_id') || !UUID.test(body.operation_id || '')) {
          throw Object.assign(new Error('Invalid cancellation request'), { statusCode: 400, code: 'AGENT_REQUEST_INVALID' });
        }
        const result = cancelOperation(body.operation_id);
        audit({ operation: 'execution_cancel_requested', operationId: body.operation_id, accepted: result.accepted });
        return respond(response, 202, result);
      }
      if (request.method === 'POST' && request.url === '/v1/list-active') {
        if (Object.keys(body).length) throw Object.assign(new Error('Invalid active-execution request'), { statusCode: 400, code: 'AGENT_REQUEST_INVALID' });
        return respond(response, 200, { executions: store.listActive(100).map(operationReply) });
      }

      const executionMatch = /^\/v1\/executions\/([0-9a-f-]{36})(?:\/(logs))?$/.exec(request.url);
      if (request.method === 'POST' && executionMatch && !executionMatch[2]) {
        if (Object.keys(body).length) throw Object.assign(new Error('Invalid execution query'), { statusCode: 400, code: 'AGENT_REQUEST_INVALID' });
        const execution = store.getOperation(executionMatch[1]);
        if (!execution) throw Object.assign(new Error('Execution not found'), { statusCode: 404, code: 'AGENT_EXECUTION_NOT_FOUND' });
        return respond(response, 200, operationReply(execution));
      }
      if (request.method === 'POST' && executionMatch && executionMatch[2]) {
        if (Object.keys(body).some((key) => !['stream', 'cursor', 'limit'].includes(key))) {
          throw Object.assign(new Error('Invalid log query'), { statusCode: 400, code: 'AGENT_REQUEST_INVALID' });
        }
        const execution = store.getOperation(executionMatch[1]);
        if (!execution) throw Object.assign(new Error('Execution not found'), { statusCode: 404, code: 'AGENT_EXECUTION_NOT_FOUND' });
        const stream = body.stream === 'stderr' ? 'stderr' : body.stream === 'stdout' ? 'stdout' : null;
        const cursor = body.cursor === undefined ? 0 : body.cursor;
        const limit = body.limit === undefined ? MAX_LOG_PAGE_BYTES : body.limit;
        if (!stream || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LOG_PAGE_BYTES) {
          throw Object.assign(new Error('Invalid log cursor'), { statusCode: 400, code: 'AGENT_REQUEST_INVALID' });
        }
        const file = stream === 'stdout' ? execution.stdoutPath : execution.stderrPath;
        if (!file || !fs.existsSync(file)) return respond(response, 200, { stream, cursor, next_cursor: cursor, content_base64: '', truncated: execution.outputTruncated });
        const descriptor = fs.openSync(file, 'r');
        try {
          const buffer = Buffer.alloc(limit);
          const bytesRead = fs.readSync(descriptor, buffer, 0, limit, cursor);
          return respond(response, 200, {
            stream, cursor, next_cursor: cursor + bytesRead,
            content_base64: buffer.subarray(0, bytesRead).toString('base64'),
            truncated: execution.outputTruncated,
          });
        } finally {
          fs.closeSync(descriptor);
        }
      }
      return respond(response, 404, { error: 'AGENT_ROUTE_NOT_FOUND', message: 'Agent endpoint not found' });
    } catch (error) {
      const result = safeError(error);
      audit({ operation: 'request_rejected', reason: result.code, method: request.method, path: request.url });
      return respond(response, result.statusCode, { error: result.code, message: result.message });
    }
  }

  const server = http.createServer((request, response) => {
    if (activeRequests >= 64) return respond(response, 429, { error: 'AGENT_BUSY', message: 'Agent request concurrency limit exceeded' });
    activeRequests += 1;
    void handle(request, response).finally(() => { activeRequests -= 1; });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 32;

  return {
    listen() {
      store.markActiveUnknown();
      pruneLogs();
      retentionTimer = setInterval(pruneLogs, 60 * 60 * 1000);
      retentionTimer.unref();
      if (!isWindowsPipe(socketPath) && fs.existsSync(socketPath)) {
        const stat = fs.lstatSync(socketPath);
        if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error('Refusing to replace an unexpected agent socket path');
        fs.unlinkSync(socketPath);
      }
      if (!isWindowsPipe(socketPath)) fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o750 });
      server.listen(socketPath, () => {
        if (!isWindowsPipe(socketPath)) {
          if (Number.isSafeInteger(options.socketGid)) fs.chownSync(socketPath, process.getuid(), options.socketGid);
          fs.chmodSync(socketPath, 0o660);
        }
        audit({ operation: 'agent_started', version: packageJson.version });
      });
      return server;
    },
    close(callback = () => {}) {
      clearInterval(retentionTimer);
      for (const controller of controllers.values()) controller.terminate('cancelled');
      server.close((error) => {
        if (!isWindowsPipe(socketPath)) {
          try { fs.unlinkSync(socketPath); } catch (_error) { /* already stopped */ }
        }
        callback(error);
      });
    },
  };
}

module.exports = { createAgentServer, fingerprintRequest, fileStat };
