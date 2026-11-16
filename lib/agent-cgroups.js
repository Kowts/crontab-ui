'use strict';

const fs = require('fs');
const path = require('path');

function cgroupError(message) {
  return Object.assign(new Error(message), { statusCode: 503, code: 'CGROUP_UNAVAILABLE' });
}

function delegatedCgroupRoot(procFile = '/proc/self/cgroup', mountRoot = '/sys/fs/cgroup') {
  const membership = fs.readFileSync(procFile, 'utf8').split(/\r?\n/).find((line) => line.startsWith('0::'));
  if (!membership) throw cgroupError('A unified cgroup v2 hierarchy is required');
  const relative = membership.slice(3);
  if (relative.split('/').includes('..')) throw cgroupError('The delegated cgroup path is invalid');
  return path.join(mountRoot, relative);
}

function prepareNativeCgroupRoot({ procFile = '/proc/self/cgroup', mountRoot = '/sys/fs/cgroup' } = {}) {
  const membership = delegatedCgroupRoot(procFile, mountRoot);
  const root = path.dirname(membership);
  if (path.basename(membership) !== 'crontab-ui-supervisor' || !path.basename(root).endsWith('.service')) {
    throw cgroupError('Native execution requires systemd DelegateSubgroup=crontab-ui-supervisor (systemd 254 or newer)');
  }
  const required = ['cpu', 'memory', 'pids'];
  let available;
  let enabled;
  try {
    available = fs.readFileSync(path.join(root, 'cgroup.controllers'), 'utf8').trim().split(/\s+/);
    enabled = fs.readFileSync(path.join(root, 'cgroup.subtree_control'), 'utf8').trim().split(/\s+/);
    fs.accessSync(path.join(root, 'cgroup.subtree_control'), fs.constants.W_OK);
    if (fs.readFileSync(path.join(root, 'cgroup.procs'), 'utf8').trim()) {
      throw cgroupError('The delegated service cgroup must contain no processes; use the supervisor subgroup');
    }
  } catch (error) {
    if (error.code === 'CGROUP_UNAVAILABLE') throw error;
    throw cgroupError(`Unable to inspect the delegated native cgroup: ${error.code || error.message}`);
  }
  for (const controller of required) {
    if (!available.includes(controller)) throw cgroupError(`The cgroup v2 ${controller} controller is not available`);
  }
  const missing = required.filter((controller) => !enabled.includes(controller));
  if (missing.length) {
    try {
      fs.writeFileSync(path.join(root, 'cgroup.subtree_control'), missing.map((controller) => `+${controller}`).join(' '));
    } catch (error) {
      throw cgroupError(`Unable to enable delegated native cgroup controllers: ${error.code || error.message}`);
    }
  }
  return root;
}

class CgroupManager {
  constructor({ root = delegatedCgroupRoot(), memoryMaxBytes, cpuQuotaPercent, pidsMax }) {
    if (process.platform !== 'linux') throw cgroupError('The local executor requires Linux cgroup v2');
    this.root = root;
    this.memoryMaxBytes = memoryMaxBytes;
    this.cpuQuotaPercent = cpuQuotaPercent;
    this.pidsMax = pidsMax;
    this.validateDelegation();
  }

  validateDelegation() {
    let controllers;
    let enabled;
    try {
      controllers = fs.readFileSync(path.join(this.root, 'cgroup.controllers'), 'utf8').trim().split(/\s+/);
      enabled = fs.readFileSync(path.join(this.root, 'cgroup.subtree_control'), 'utf8').trim().split(/\s+/);
    } catch (_error) {
      throw cgroupError('The systemd service has no writable cgroup v2 delegation');
    }
    for (const controller of ['cpu', 'memory', 'pids']) {
      if (!controllers.includes(controller) || !enabled.includes(controller)) {
        throw cgroupError(`The cgroup v2 ${controller} controller is not delegated`);
      }
    }
  }

  create(operationId) {
    const name = `execution-${operationId.replace(/[^a-f0-9-]/gi, '')}`;
    const directory = path.join(this.root, name);
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      if (!fs.existsSync(path.join(directory, 'cgroup.kill'))) {
        throw cgroupError('The cgroup v2 hierarchy does not support reliable descendant termination');
      }
      fs.writeFileSync(path.join(directory, 'memory.max'), String(this.memoryMaxBytes));
      fs.writeFileSync(path.join(directory, 'cpu.max'), `${Math.floor(this.cpuQuotaPercent * 1000)} 100000`);
      fs.writeFileSync(path.join(directory, 'pids.max'), String(this.pidsMax));
    } catch (error) {
      try { fs.rmdirSync(directory); } catch (_cleanupError) { /* best effort */ }
      throw cgroupError(`Unable to create the execution cgroup: ${error.code || 'I/O error'}`);
    }
    return { name, directory };
  }

  kill(cgroup) {
    try {
      fs.writeFileSync(path.join(cgroup.directory, 'cgroup.kill'), '1');
      return true;
    } catch (_error) {
      return false;
    }
  }

  async remove(cgroup) {
    const deadline = Date.now() + 2000;
    try {
      fs.writeFileSync(path.join(cgroup.directory, 'cgroup.kill'), '1');
      while (true) {
        try {
          const events = fs.readFileSync(path.join(cgroup.directory, 'cgroup.events'), 'utf8');
          if (/^populated 0$/m.test(events)) {
            fs.rmdirSync(cgroup.directory);
            return true;
          }
        } catch (error) {
          if (error.code === 'ENOENT') return true;
          if (!['EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
        }
        if (Date.now() >= deadline) {
          throw Object.assign(new Error('Execution cgroup did not become removable within 2000 ms'), { code: 'ETIMEDOUT' });
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw Object.assign(new Error(`Unable to clean execution cgroup ${cgroup.name}: ${error.code || error.message}`), {
        code: 'CGROUP_CLEANUP_FAILED', cause: error,
      });
    }
  }
}

module.exports = { CgroupManager, delegatedCgroupRoot, prepareNativeCgroupRoot };
