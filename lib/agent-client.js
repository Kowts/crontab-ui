'use strict';

const http = require('http');
const { signAgentRequest } = require('./agent-protocol');

function clientError(message, code, statusCode = 503) {
  return Object.assign(new Error(message), { code, statusCode });
}

class LocalAgentClient {
  constructor({ secret = process.env.CRONTAB_UI_AGENT_HMAC_SECRET, socketPath = process.env.CRONTAB_UI_AGENT_SOCKET, timeoutMs = 3000 } = {}) {
    this.secret = typeof secret === 'string' ? Buffer.from(secret, 'hex') : secret;
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  configured() {
    return Buffer.isBuffer(this.secret) && this.secret.length >= 32
      && typeof this.socketPath === 'string'
      && (this.socketPath.startsWith('/') || (process.platform === 'win32' && this.socketPath.startsWith('\\\\.\\pipe\\')));
  }

  request(route, payload = {}, { operationId = null } = {}) {
    if (!this.configured()) return Promise.reject(clientError('Local execution agent is not configured', 'EXECUTOR_UNAVAILABLE'));
    const body = JSON.stringify(payload);
    const signed = signAgentRequest(this.secret, body);
    return new Promise((resolve, reject) => {
      let completed = false;
      const finish = (error, value) => {
        if (completed) return;
        completed = true;
        if (error) reject(error);
        else resolve(value);
      };
      const request = http.request({
        socketPath: this.socketPath,
        path: route,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Agent-Timestamp': String(signed.timestamp),
          'X-Agent-Nonce': signed.nonce,
          'X-Agent-Signature': signed.signature,
        },
        timeout: this.timeoutMs,
      }, (response) => {
        const chunks = [];
        let length = 0;
        response.on('data', (chunk) => {
          length += chunk.length;
          if (length > 128 * 1024) {
            request.destroy();
            finish(clientError('Local execution agent response exceeded its limit', 'AGENT_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('end', () => {
          let result;
          try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_error) {
            return finish(clientError('Local execution agent returned invalid data', 'AGENT_RESPONSE_INVALID'));
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            return finish(clientError(result.message || 'Local execution agent rejected the request', result.error || 'AGENT_REQUEST_REJECTED', response.statusCode));
          }
          return finish(null, result);
        });
      });
      request.once('timeout', () => {
        const error = clientError('Local execution agent response timed out', 'AGENT_RPC_UNKNOWN');
        error.operationId = operationId;
        request.destroy(error);
      });
      request.once('error', (error) => {
        const code = error.code === 'AGENT_RPC_UNKNOWN' ? error.code : 'EXECUTOR_UNAVAILABLE';
        const wrapped = clientError('Local execution agent could not be reached', code);
        wrapped.operationId = operationId;
        finish(wrapped);
      });
      request.end(body);
    });
  }

  async submitExecution(payload) {
    if (!this.configured()) throw clientError('Local execution agent is not configured', 'EXECUTOR_UNAVAILABLE');
    try {
      return await this.request('/v1/submit-execution', payload, { operationId: payload.operation_id });
    } catch (error) {
      const transportFailure = ['AGENT_RPC_UNKNOWN', 'EXECUTOR_UNAVAILABLE'].includes(error.code);
      if (!transportFailure && !(Number.isInteger(error.statusCode) && error.statusCode >= 500)) throw error;
      try {
        const existing = await this.request(`/v1/executions/${encodeURIComponent(payload.operation_id)}`);
        return { accepted: true, existing: true, execution: existing };
      } catch (reconcileError) {
        if (!transportFailure && reconcileError.statusCode === 404) throw error;
        throw clientError('Execution dispatch state is unknown; automatic retry is disabled', 'AGENT_DISPATCH_UNKNOWN', 503);
      }
    }
  }

  health() { return this.request('/v1/health'); }
  validateEnvironment(environmentCode, revision, executablePath) {
    return this.request('/v1/validate-environment', {
      environment_code: environmentCode,
      environment_revision: revision,
      executable_path: executablePath,
    });
  }
  getExecution(operationId) { return this.request(`/v1/executions/${encodeURIComponent(operationId)}`); }
  getLogs(operationId, stream, cursor = 0, limit = 64 * 1024) {
    return this.request(`/v1/executions/${encodeURIComponent(operationId)}/logs`, { stream, cursor, limit });
  }
  cancelExecution(operationId) { return this.request('/v1/cancel-execution', { operation_id: operationId }); }
  listActive() { return this.request('/v1/list-active'); }
}

module.exports = { LocalAgentClient };
