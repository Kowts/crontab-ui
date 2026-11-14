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

  remove(cgroup) {
    this.kill(cgroup);
    try {
      fs.rmdirSync(cgroup.directory);
      return true;
    } catch (_error) {
      return false;
    }
  }
}

module.exports = { CgroupManager, delegatedCgroupRoot };
