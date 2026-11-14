'use strict';

const path = require('path');

const runtimeTypes = new Set(['python', 'node', 'bash', 'binary']);
const allowedTopLevel = new Set([
  'version', 'agent_id', 'max_concurrent', 'max_timeout_ms', 'max_output_bytes', 'log_retention_days',
  'memory_max_bytes', 'cpu_quota_percent', 'pids_max', 'environments',
]);
const allowedTaskRequest = new Set([
  'operation_id', 'task_id', 'environment_code', 'environment_revision', 'script_path',
  'working_directory', 'arguments', 'timeout_ms',
]);

function policyError(message, statusCode = 403, code = 'AGENT_POLICY_DENIED') {
  return Object.assign(new Error(message), { statusCode, code });
}

function absolutePolicyPath(value) {
  return typeof value === 'string' && value.length <= 4096
    && path.posix.isAbsolute(value) && path.posix.normalize(value) === value
    && !/[\0\r\n\\]/.test(value) && value !== '/';
}

function validateAgentPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || Object.keys(policy).some((key) => !allowedTopLevel.has(key))
    || policy.version !== 1 || policy.agent_id !== 'ubuntu-local'
    || !Number.isSafeInteger(policy.max_concurrent) || policy.max_concurrent < 1 || policy.max_concurrent > 32
    || !Number.isSafeInteger(policy.max_timeout_ms) || policy.max_timeout_ms < 1000 || policy.max_timeout_ms > 86400000
    || !Number.isSafeInteger(policy.max_output_bytes) || policy.max_output_bytes < 1024 || policy.max_output_bytes > 1073741824
    || !Number.isSafeInteger(policy.log_retention_days) || policy.log_retention_days < 1 || policy.log_retention_days > 3650
    || !Number.isSafeInteger(policy.memory_max_bytes) || policy.memory_max_bytes < 16777216 || policy.memory_max_bytes > 1099511627776
    || !Number.isSafeInteger(policy.cpu_quota_percent) || policy.cpu_quota_percent < 1 || policy.cpu_quota_percent > 1000
    || !Number.isSafeInteger(policy.pids_max) || policy.pids_max < 1 || policy.pids_max > 65536
    || !policy.environments || typeof policy.environments !== 'object' || Array.isArray(policy.environments)) {
    throw new Error('Local execution agent policy is invalid');
  }

  for (const [code, environment] of Object.entries(policy.environments)) {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(code) || !environment || typeof environment !== 'object'
      || !Number.isSafeInteger(environment.revision) || environment.revision < 1
      || !runtimeTypes.has(environment.runtime_type) || !absolutePolicyPath(environment.executable)
      || !absolutePolicyPath(environment.executable_realpath)
      || !Array.isArray(environment.executable_owner_uids) || !environment.executable_owner_uids.length
      || environment.executable_owner_uids.some((uid) => !Number.isSafeInteger(uid) || uid < 0)
      || !environment.tasks || typeof environment.tasks !== 'object' || Array.isArray(environment.tasks)) {
      throw new Error(`Local execution agent environment policy is invalid: ${code}`);
    }
    for (const [taskId, task] of Object.entries(environment.tasks)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId) || !task || typeof task !== 'object'
        || !absolutePolicyPath(task.script_path) || !absolutePolicyPath(task.working_directory)
        || !Array.isArray(task.script_owner_uids) || !task.script_owner_uids.length
        || task.script_owner_uids.some((uid) => !Number.isSafeInteger(uid) || uid < 0)
        || !Array.isArray(task.working_directory_owner_uids) || !task.working_directory_owner_uids.length
        || task.working_directory_owner_uids.some((uid) => !Number.isSafeInteger(uid) || uid < 0)
        || !Array.isArray(task.argument_patterns) || task.argument_patterns.length > 100
        || task.argument_patterns.some((pattern) => typeof pattern !== 'string' || pattern.length > 256)
        || !Number.isSafeInteger(task.max_timeout_ms) || task.max_timeout_ms < 1000
        || task.max_timeout_ms > policy.max_timeout_ms) {
        throw new Error(`Local execution agent task policy is invalid: ${taskId}`);
      }
      try {
        task.argument_patterns.forEach((pattern) => new RegExp(pattern));
      } catch (_error) {
        throw new Error(`Local execution agent argument policy is invalid: ${taskId}`);
      }
    }
  }
  return policy;
}

function resolveEnvironment(policy, code, revision) {
  const environment = policy.environments[code];
  if (!environment || environment.revision !== revision) {
    throw policyError('Execution environment is not approved by the host policy', 409, 'AGENT_POLICY_REVISION_MISMATCH');
  }
  return { code, ...environment };
}

function resolveTask(policy, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => !allowedTaskRequest.has(key))) {
    throw policyError('Task request contains unsupported fields');
  }
  const environment = resolveEnvironment(policy, request.environment_code, request.environment_revision);
  const task = environment.tasks[request.task_id];
  if (!task || task.script_path !== request.script_path || task.working_directory !== request.working_directory) {
    throw policyError('Task is not approved by the host policy');
  }
  if (!Array.isArray(request.arguments) || request.arguments.length !== task.argument_patterns.length
    || request.arguments.some((argument, index) => typeof argument !== 'string' || argument.length > 4096
      || argument.includes('\0') || !new RegExp(`^(?:${task.argument_patterns[index]})$`).test(argument))) {
    throw policyError('Task arguments do not match the host policy');
  }
  if (!Number.isSafeInteger(request.timeout_ms) || request.timeout_ms < 0
    || request.timeout_ms > task.max_timeout_ms || request.timeout_ms > policy.max_timeout_ms
    || (request.timeout_ms === 0 && task.max_timeout_ms !== 0)) {
    throw policyError('Task timeout exceeds the host policy');
  }
  return { environment, task };
}

module.exports = { policyError, resolveEnvironment, resolveTask, validateAgentPolicy };
