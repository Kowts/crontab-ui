'use strict';

const os = require('os');
const { spawn } = require('child_process');

function effectiveIdentity() {
  const info = os.userInfo();
  return Object.freeze({
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    gid: typeof process.getgid === 'function' ? process.getgid() : null,
    username: info.username || null,
    homedir: info.homedir || null,
    shell: info.shell || null,
  });
}

function terminate(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (_error) { /* fall through */ }
  }
  child.kill(signal);
}

function buildResourceLimitPrefix(limits) {
  if (process.platform === 'win32') return '';
  const parts = [];
  if (limits && Number.isFinite(limits.memoryLimitKb) && limits.memoryLimitKb > 0) {
    parts.push(`ulimit -v ${Math.floor(limits.memoryLimitKb)};`);
  }
  if (limits && Number.isFinite(limits.cpuSeconds) && limits.cpuSeconds > 0) {
    parts.push(`ulimit -t ${Math.floor(limits.cpuSeconds)};`);
  }
  if (limits && Number.isFinite(limits.maxProcesses) && limits.maxProcesses > 0) {
    parts.push(`ulimit -u ${Math.floor(limits.maxProcesses)};`);
  }
  return parts.join(' ');
}

function execute(command, { timeoutMs, maxOutputBytes, env = process.env, killGraceMs = 5_000, onStart = null, resourceLimits = null }, callback) {
  const startedAt = Date.now();
  const identity = effectiveIdentity();
  const appliedLimits = resourceLimits ? Object.freeze({ ...resourceLimits }) : null;
  const limitPrefix = buildResourceLimitPrefix(resourceLimits);
  const wrappedCommand = limitPrefix ? `${limitPrefix} ${command}` : command;

  const child = process.platform === 'win32'
    ? spawn(wrappedCommand, { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.env.SHELL || '/bin/sh', ['-c', wrappedCommand], {
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: [], stderr: [], bytes: 0, exceeded: false };
  let terminationReason = null;
  let killTimer;
  let settled = false;

  const terminateTree = (reason) => {
    if (terminationReason) return;
    terminationReason = reason;
    terminate(child, 'SIGTERM');
    killTimer = setTimeout(() => terminate(child, 'SIGKILL'), killGraceMs);
  };
  const controller = { cancel: () => terminateTree('cancelled') };
  const collect = (target) => (chunk) => {
    const available = Math.max(0, maxOutputBytes - output.bytes);
    if (available) {
      const kept = chunk.subarray(0, available);
      target.push(kept);
      output.bytes += kept.length;
    }
    if (chunk.length > available) {
      output.exceeded = true;
      terminateTree('output_limit');
    }
  };

  const timeout = timeoutMs === 0 ? null : setTimeout(() => terminateTree('timeout'), timeoutMs);
  child.stdout.on('data', collect(output.stdout));
  child.stderr.on('data', collect(output.stderr));
  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    callback(error, { durationMs: Date.now() - startedAt, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), identity, resourceLimits: appliedLimits });
  });
  child.on('close', (exitCode, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    const result = {
      durationMs: Date.now() - startedAt,
      exitCode,
      signal,
      terminationReason,
      stdout: Buffer.concat(output.stdout),
      stderr: Buffer.concat(output.stderr),
      outputExceeded: output.exceeded,
      identity,
      resourceLimits: appliedLimits,
    };
    const error = terminationReason
      ? Object.assign(new Error(`Command terminated: ${terminationReason}`), { code: terminationReason, signal })
      : exitCode === 0 ? null : Object.assign(new Error(`Command exited with code ${exitCode}`), { code: exitCode, signal });
    callback(error, result);
  });
  if (typeof onStart === 'function') onStart(controller);
  return controller;
}

module.exports = { execute };
