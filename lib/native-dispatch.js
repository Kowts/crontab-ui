'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { LocalAgentClient } = require('./agent-client');
const { LocalAgentStore } = require('./agent-store');
const { verifyAgentRequest } = require('./agent-protocol');
const { prepareNativeCgroupRoot } = require('./agent-cgroups');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dispatchError(message, statusCode = 503, code = 'NATIVE_DISPATCH_UNAVAILABLE') {
  return Object.assign(new Error(message), { statusCode, code });
}

function paths(databaseDirectory) {
  return {
    key: path.join(databaseDirectory, 'native-dispatch.key'),
    socket: path.join(databaseDirectory, 'native-dispatch.sock'),
    state: path.join(databaseDirectory, 'native-dispatch.db'),
  };
}

function readKey(databaseDirectory) {
  const directory = fs.lstatSync(databaseDirectory);
  const filename = paths(databaseDirectory).key;
  const stat = fs.lstatSync(filename);
  if (process.platform !== 'linux' || directory.isSymbolicLink() || !directory.isDirectory()
    || directory.uid !== process.getuid() || (directory.mode & 0o077)
    || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw dispatchError('Native dispatch requires a private service-owned database directory and key');
  }
  const key = fs.readFileSync(filename);
  if (key.length !== 32) throw dispatchError('Native dispatch key must contain exactly 32 random bytes');
  return key;
}

function initializeKey(databaseDirectory) {
  const filename = paths(databaseDirectory).key;
  const fd = fs.openSync(filename, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, crypto.randomBytes(32));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return filename;
}

function scheduledFingerprint(job) {
  return crypto.createHash('sha256').update(JSON.stringify({
    id: job._id, owner: job.owner || null, execution: job.structured_execution,
    schedule: job.schedule, timestamp: job.timestamp, mailing: job.mailing, logging: job.logging,
    stopped: Boolean(job.stopped), saved: Boolean(job.saved), review: Boolean(job.needsPublishReview),
  })).digest('hex');
}

function authorizeScheduledJob(job, environment, fingerprint) {
  if (!job || job.execution_mode !== 'structured' || job.stopped || !job.saved || job.needsPublishReview
    || !environment || environment.targetId !== 'native-local' || !environment.enabled
    || environment.validationStatus !== 'valid' || scheduledFingerprint(job) !== fingerprint) {
    throw dispatchError('Scheduled native task is missing, disabled, unpublished, changed or unvalidated', 409, 'NATIVE_DISPATCH_REJECTED');
  }
}

function createNativeDispatcher({ socketPath, secret, store, getJob, getEnvironment, runJob, audit }) {
  const active = new Map();
  const cancellations = new Set();
  let stopping = false;
  let closeCallback;
  let serverClosed = false;
  const finishClose = () => {
    if (serverClosed && !active.size && closeCallback) {
      const callback = closeCallback;
      closeCallback = null;
      callback();
    }
  };
  function reply(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  }
  function executionStatus(operation) {
    return {
      operationId: operation.operationId, taskId: operation.taskId, status: operation.status,
      exitCode: operation.exitCode, signal: operation.signal, durationMs: operation.durationMs,
      terminationReason: operation.terminationReason,
    };
  }
  const server = http.createServer(async (request, response) => {
    try {
      if (stopping) throw dispatchError('Native dispatcher is shutting down');
      let text = '';
      for await (const chunk of request) {
        text += chunk.toString('utf8');
        if (text.length > 4096) throw dispatchError('Native dispatch request exceeded its limit', 413, 'NATIVE_DISPATCH_INVALID');
      }
      const headers = {
        timestamp: request.headers['x-agent-timestamp'], nonce: request.headers['x-agent-nonce'],
        signature: request.headers['x-agent-signature'],
      };
      if (!verifyAgentRequest(secret, text, headers)) throw dispatchError('Native dispatch authentication failed', 401, 'NATIVE_DISPATCH_AUTH');
      if (!store.recordNonce(headers.nonce)) throw dispatchError('Native dispatch replay rejected', 409, 'NATIVE_DISPATCH_REPLAY');
      let body;
      try { body = JSON.parse(text); } catch (_error) {
        throw dispatchError('Invalid native dispatch JSON', 400, 'NATIVE_DISPATCH_INVALID');
      }
      if (request.method !== 'POST' || !body || Array.isArray(body) || typeof body !== 'object') {
        throw dispatchError('Invalid native dispatch request', 400, 'NATIVE_DISPATCH_INVALID');
      }
      if (request.url === '/v1/cancel-execution' && Object.keys(body).join(',') === 'operation_id'
        && UUID.test(body.operation_id || '')) {
        const operation = store.getOperation(body.operation_id);
        if (!operation) throw dispatchError('Native execution not found', 404, 'NATIVE_DISPATCH_NOT_FOUND');
        const accepted = active.has(body.operation_id);
        if (accepted) {
          cancellations.add(body.operation_id);
          active.get(body.operation_id)?.cancel();
          audit({ type: 'native_dispatch', operationId: body.operation_id, status: 'cancel_requested' });
        }
        return reply(response, 202, { accepted });
      }
      const match = /^\/v1\/executions\/([0-9a-f-]{36})$/i.exec(request.url);
      if (match && UUID.test(match[1]) && !Object.keys(body).length) {
        const operation = store.getOperation(match[1]);
        if (!operation) throw dispatchError('Native execution not found', 404, 'NATIVE_DISPATCH_NOT_FOUND');
        return reply(response, 200, executionStatus(operation));
      }
      if (request.url !== '/v1/submit-execution' || !UUID.test(body.operation_id || '')
        || !/^[A-Za-z0-9_-]{1,64}$/.test(body.task_id || '')
        || !/^[0-9a-f]{64}$/.test(body.fingerprint || '')
        || Object.keys(body).sort().join(',') !== 'fingerprint,operation_id,task_id') {
        throw dispatchError('Invalid native dispatch payload', 400, 'NATIVE_DISPATCH_INVALID');
      }
      const existing = store.getOperation(body.operation_id);
      if (existing) {
        if (existing.requestFingerprint !== body.fingerprint || existing.taskId !== body.task_id) {
          throw dispatchError('Native operation ID conflict', 409, 'IDEMPOTENCY_CONFLICT');
        }
        return reply(response, 200, executionStatus(existing));
      }
      const job = await getJob(body.task_id);
      const environment = job ? getEnvironment(job.structured_execution?.environment_id) : null;
      authorizeScheduledJob(job, environment, body.fingerprint);
      const accepted = store.acceptOperation({
        operationId: body.operation_id, fingerprint: body.fingerprint, taskId: job._id,
        environmentCode: environment.code, environmentRevision: environment.revision, maxConcurrent: 100,
      });
      if (accepted.existing) return reply(response, 200, executionStatus(accepted.execution));
      active.set(body.operation_id, null);
      const complete = (error, result = {}) => {
        try {
          store.complete(body.operation_id, {
            status: error ? (['timeout', 'cancelled', 'output_limit'].includes(result.terminationReason)
              ? result.terminationReason : 'failed') : 'completed',
            exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs,
            terminationReason: result.terminationReason, errorCode: error ? String(error.code || 'EXECUTION_FAILED') : null,
          });
        } catch (recordError) {
          audit({ type: 'native_dispatch', operationId: body.operation_id, status: 'failed', error: recordError.message });
        } finally {
          active.delete(body.operation_id);
          cancellations.delete(body.operation_id);
          finishClose();
        }
      };
      try {
        runJob(job._id, { actor: 'system-cron', trigger: 'scheduled' }, complete, {
          operationId: body.operation_id, expectedFingerprint: body.fingerprint,
          expectedEnvironmentRevision: environment.revision,
          onController(controller) {
            if (active.has(body.operation_id)) active.set(body.operation_id, controller);
            if ((stopping || cancellations.has(body.operation_id)) && controller) controller.cancel();
          },
        });
      } catch (error) {
        complete(error);
        throw error;
      }
      return reply(response, 202, executionStatus(store.getOperation(body.operation_id)));
    } catch (error) {
      audit({ type: 'native_dispatch', status: 'rejected', error: error.message, errorCode: error.code });
      if (!response.headersSent) reply(response, error.statusCode || 500, {
        message: error.statusCode ? error.message : 'Unable to process native dispatch', error: error.code || 'NATIVE_DISPATCH_FAILED',
      });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          try {
            if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
            resolve();
          } catch (error) {
            server.close(() => reject(error));
          }
        });
      });
    },
    close(callback) {
      stopping = true;
      closeCallback = callback;
      for (const controller of active.values()) if (controller) controller.cancel();
      server.close(() => { serverClosed = true; finishClose(); });
      server.closeIdleConnections();
    },
  };
}

async function clearStaleSocket(socketPath) {
  if (!fs.existsSync(socketPath)) return;
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket() || stat.uid !== process.getuid()) throw dispatchError('Unsafe native dispatch socket');
  await new Promise((resolve, reject) => {
    const client = net.connect(socketPath);
    client.once('connect', () => { client.destroy(); reject(dispatchError('Native dispatcher is already running')); });
    client.once('error', (error) => {
      if (error.code !== 'ECONNREFUSED') return reject(error);
      fs.unlinkSync(socketPath);
      resolve();
    });
  });
}

async function startNativeDispatcher(crontab) {
  prepareNativeCgroupRoot();
  const secret = readKey(crontab.db_folder);
  const files = paths(crontab.db_folder);
  if (Buffer.byteLength(files.socket) > 100) throw dispatchError('Native dispatch socket path is too long');
  await clearStaleSocket(files.socket);
  const store = new LocalAgentStore({ filename: files.state });
  const recovered = store.markActiveUnknown();
  if (recovered) crontab.audit({ type: 'native_dispatch', status: 'unknown', reason: 'service_restart', count: recovered });
  const dispatcher = createNativeDispatcher({
    socketPath: files.socket, secret, store, getJob: crontab.getJobForNativeDispatch,
    getEnvironment: crontab.getExecutionEnvironment, runJob: crontab.runjob, audit: crontab.audit,
  });
  try {
    await dispatcher.listen();
  } catch (error) {
    store.close();
    throw error;
  }
  return { close(callback) { dispatcher.close(() => { store.close(); callback(); }); } };
}

async function dispatchScheduledNative(job, databaseDirectory) {
  const client = new LocalAgentClient({ secret: readKey(databaseDirectory), socketPath: paths(databaseDirectory).socket });
  const operationId = crypto.randomUUID();
  let operation;
  try {
    operation = await client.request('/v1/submit-execution', {
      operation_id: operationId, task_id: job._id, fingerprint: scheduledFingerprint(job),
    }, { operationId });
  } catch (error) {
    if (!['AGENT_RPC_UNKNOWN', 'EXECUTOR_UNAVAILABLE'].includes(error.code)) throw error;
    // Reconcile the same ID without ever resubmitting an uncertain dispatch.
    try { operation = await client.request(`/v1/executions/${operationId}`); } catch (_queryError) {
      throw dispatchError(`Native dispatch outcome unknown; operation ${operationId}; no automatic retry`, 503, 'NATIVE_DISPATCH_UNKNOWN');
    }
  }
  while (['accepted', 'running'].includes(operation.status)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { operation = await client.request(`/v1/executions/${operationId}`); } catch (_error) {
      throw dispatchError(`Native dispatch outcome unknown; operation ${operationId}; no automatic retry`, 503, 'NATIVE_DISPATCH_UNKNOWN');
    }
  }
  if (operation.status !== 'completed') throw dispatchError(
    `Native scheduled execution ${operation.status}; operation ${operationId}`, 503, 'NATIVE_EXECUTION_FAILED',
  );
  return operation;
}

module.exports = {
  initializeKey, scheduledFingerprint, authorizeScheduledJob, createNativeDispatcher,
  startNativeDispatcher, dispatchScheduledNative,
};
