'use strict';

/* global describe, it, expect, beforeEach, afterEach */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { LocalAgentStore } = require('../lib/agent-store');
const { LocalAgentClient } = require('../lib/agent-client');
const { signAgentRequest } = require('../lib/agent-protocol');
const {
  createNativeDispatcher, scheduledFingerprint, authorizeScheduledJob,
} = require('../lib/native-dispatch');

describe('Scheduled native dispatch', () => {
  let directory;
  let store;
  let dispatcher;
  let client;
  let job;
  let environment;
  let started;
  let completions;
  let socketPath;
  let secret;
  let options;
  let events;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crontab-ui-dispatch-'));
    socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\crontab-ui-dispatch-${crypto.randomUUID()}`
      : path.join(directory, 'dispatch.sock');
    secret = crypto.randomBytes(32);
    store = new LocalAgentStore({ filename: path.join(directory, 'dispatch.db') });
    job = {
      _id: 'native-task', execution_mode: 'structured', saved: true, stopped: false,
      owner: 'admin', schedule: '* * * * *', timestamp: '2026-11-15',
      structured_execution: { environment_id: 'environment', script_path: '/opt/etl/main.py', arguments: [], timeout_ms: 1000 },
    };
    environment = { code: 'python', revision: 1, targetId: 'native-local', enabled: true, validationStatus: 'valid' };
    started = [];
    completions = new Map();
    events = [];
    options = {
      socketPath, secret, store, getJob: async () => job, getEnvironment: () => environment,
      audit: (event) => events.push(event),
      runJob(id, context, callback, dispatchOptions) {
        started.push({ id, context, dispatchOptions });
        completions.set(dispatchOptions.operationId, callback);
        dispatchOptions.onController({ cancel() { callback(new Error('cancelled'), { terminationReason: 'cancelled' }); } });
      },
    };
    dispatcher = createNativeDispatcher(options);
    await dispatcher.listen();
    client = new LocalAgentClient({ secret, socketPath });
  });

  afterEach(async () => {
    await new Promise((resolve) => dispatcher.close(resolve));
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function payload(operationId = crypto.randomUUID()) {
    return { task_id: job._id, operation_id: operationId, fingerprint: scheduledFingerprint(job) };
  }

  it('authenticates, dispatches once and durably returns the outcome using the same operation ID', async () => {
    const body = payload();
    await client.request('/v1/submit-execution', body);
    await client.request('/v1/submit-execution', body);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      context: { actor: 'system-cron', trigger: 'scheduled' },
      dispatchOptions: { operationId: body.operation_id, expectedEnvironmentRevision: 1, expectedFingerprint: body.fingerprint },
    });
    completions.get(body.operation_id)(null, { exitCode: 0, durationMs: 42 });
    const result = await client.request(`/v1/executions/${body.operation_id}`);
    expect(result).toMatchObject({ status: 'completed', operationId: body.operation_id, exitCode: 0, durationMs: 42 });
    await client.request('/v1/submit-execution', body);
    expect(started).toHaveLength(1);
  });

  it('accepts at most one execution when duplicate submissions race across the job lookup', async () => {
    const body = payload();
    await Promise.all([client.request('/v1/submit-execution', body), client.request('/v1/submit-execution', body)]);
    expect(started).toHaveLength(1);
  });

  it('rejects conflicting IDs and arbitrary commands, paths or arguments in requests', async () => {
    const body = payload();
    await client.request('/v1/submit-execution', body);
    await expect(client.request('/v1/submit-execution', { ...body, fingerprint: 'f'.repeat(64) }))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(client.request('/v1/submit-execution', { ...payload(), command: 'sh' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(started).toHaveLength(1);
  });

  it.each([
    { stopped: true }, { saved: false }, { needsPublishReview: true }, { execution_mode: 'command' },
  ])('refuses non-executable scheduled tasks %j', async (changes) => {
    Object.assign(job, changes);
    await expect(client.request('/v1/submit-execution', payload())).rejects.toMatchObject({ statusCode: 409 });
    expect(started).toHaveLength(0);
  });

  it('rechecks validation and rejects an old task snapshot', async () => {
    const old = payload();
    job.structured_execution.arguments.push('--changed');
    await expect(client.request('/v1/submit-execution', old)).rejects.toMatchObject({ statusCode: 409 });
    environment.validationStatus = 'pending';
    await expect(client.request('/v1/submit-execution', payload())).rejects.toMatchObject({ statusCode: 409 });
    expect(started).toHaveLength(0);
    expect(() => authorizeScheduledJob(job, { ...environment, targetId: 'container-local' }, scheduledFingerprint(job))).toThrow();
  });

  it('rejects invalid authentication before executing', async () => {
    const wrongClient = new LocalAgentClient({ socketPath, secret: crypto.randomBytes(32) });
    await expect(wrongClient.request('/v1/submit-execution', payload())).rejects.toMatchObject({ statusCode: 401 });
    expect(started).toHaveLength(0);
    expect(events.some((event) => event.errorCode === 'NATIVE_DISPATCH_AUTH')).toBe(true);
  });

  it('rejects replay of a signed request independently of operation idempotency', async () => {
    const body = JSON.stringify(payload());
    const signed = signAgentRequest(secret, body);
    function send() {
      return new Promise((resolve, reject) => {
        const request = http.request({
          socketPath, path: '/v1/submit-execution', method: 'POST',
          headers: { 'Content-Length': Buffer.byteLength(body), 'X-Agent-Timestamp': signed.timestamp,
            'X-Agent-Nonce': signed.nonce, 'X-Agent-Signature': signed.signature },
        }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
        request.on('error', reject);
        request.end(body);
      });
    }
    expect(await send()).toBe(202);
    expect(await send()).toBe(409);
    expect(started).toHaveLength(1);
  });

  it('does not replay accepted work whose outcome became unknown after restart', async () => {
    const body = payload();
    store.acceptOperation({ operationId: body.operation_id, fingerprint: body.fingerprint,
      taskId: job._id, environmentCode: environment.code, environmentRevision: 1, maxConcurrent: 100 });
    store.markActiveUnknown();
    await expect(client.request('/v1/submit-execution', body)).resolves.toMatchObject({ status: 'unknown' });
    expect(started).toHaveLength(0);
  });

  it('cancels delegated executions and waits for completion before shutdown', async () => {
    const body = payload();
    await client.request('/v1/submit-execution', body);
    await new Promise((resolve) => dispatcher.close(resolve));
    expect(store.getOperation(body.operation_id)).toMatchObject({ status: 'cancelled' });
    // afterEach can close an already closed server.
  });

  it('accepts signed cancellation without executing another task', async () => {
    const body = payload();
    await client.request('/v1/submit-execution', body);
    await expect(client.cancelExecution(body.operation_id)).resolves.toMatchObject({ accepted: true });
    expect(store.getOperation(body.operation_id).status).toBe('cancelled');
    expect(started).toHaveLength(1);
    await expect(client.cancelExecution(body.operation_id)).resolves.toMatchObject({ accepted: false });
  });

  it('records a synchronous execution setup failure instead of leaving an active operation', async () => {
    options.runJob = () => { throw new Error('setup failure'); };
    await new Promise((resolve) => dispatcher.close(resolve));
    dispatcher = createNativeDispatcher(options);
    await dispatcher.listen();
    const body = payload();
    await expect(client.request('/v1/submit-execution', body)).rejects.toMatchObject({ statusCode: 500 });
    expect(store.getOperation(body.operation_id).status).toBe('failed');
  });
});

describe('Cron runner routing', () => {
  it.each(['native-local', 'container-local', 'ubuntu-local', null])('routes %s without direct native execution', async (targetId) => {
    const calls = [];
    const job = { _id: 'task', execution_mode: targetId ? 'structured' : 'command', structured_execution: { environment_id: 'env' } };
    let finished;
    const done = new Promise((resolve) => { finished = resolve; });
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../bin/crontab-ui-runner.js'), 'utf8'), {
      process: { argv: ['node', 'runner', 'task'], exit: finished }, console,
      require(name) {
        if (name === '../crontab') return {
          db_folder: '/private/db', getJobForNativeDispatch: async () => job,
          getExecutionEnvironment: () => ({ targetId }),
          runjob(_id, callback) { calls.push('direct'); callback(null); },
        };
        if (name === '../lib/native-dispatch') return {
          async dispatchScheduledNative(received) { expect(received._id).toBe('task'); calls.push('delegated'); },
        };
        throw new Error(`Unexpected module ${name}`);
      },
    });
    expect(await done).toBe(0);
    expect(calls).toEqual([targetId === 'native-local' ? 'delegated' : 'direct']);
  });
});
