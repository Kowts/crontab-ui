'use strict';

/* global describe, it, expect, vi, beforeEach, afterEach */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

describe('Bounded cgroup cleanup', () => {
  const cgroup = { name: 'execution-test', directory: '/delegated/execution-test' };
  let fakeFs;
  let manager;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeFs = {
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => 'populated 0\nfrozen 0\n'),
      rmdirSync: vi.fn(),
    };
    const context = {
      module: { exports: {} }, Date, setTimeout,
      process: { platform: 'linux' },
      require: (name) => name === 'fs' ? fakeFs : name === 'path' ? path.posix : require(name),
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/agent-cgroups.js'), 'utf8'), context);
    manager = Object.create(context.module.exports.CgroupManager.prototype);
  });

  afterEach(() => vi.useRealTimers());

  it('kills descendants, waits for depopulation and retries a busy removal', async () => {
    fakeFs.readFileSync.mockReturnValueOnce('populated 1\nfrozen 0\n');
    fakeFs.rmdirSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    const removed = manager.remove(cgroup);
    expect(fakeFs.writeFileSync).toHaveBeenCalledWith(`${cgroup.directory}/cgroup.kill`, '1');
    expect(fakeFs.rmdirSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    expect(fakeFs.rmdirSync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);
    await expect(removed).resolves.toBe(true);
    expect(fakeFs.rmdirSync).toHaveBeenCalledTimes(2);
  });

  it('bounds a permanently populated cgroup and surfaces the failure', async () => {
    fakeFs.readFileSync.mockReturnValue('populated 1\nfrozen 0\n');
    const removed = expect(manager.remove(cgroup)).rejects.toMatchObject({
      code: 'CGROUP_CLEANUP_FAILED', cause: { code: 'ETIMEDOUT' },
    });
    await vi.advanceTimersByTimeAsync(2000);
    await removed;
    expect(fakeFs.rmdirSync).not.toHaveBeenCalled();
  });

  it('surfaces permission failures without retrying indefinitely', async () => {
    fakeFs.rmdirSync.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    await expect(manager.remove(cgroup)).rejects.toMatchObject({
      code: 'CGROUP_CLEANUP_FAILED', cause: { code: 'EACCES' },
    });
    expect(fakeFs.rmdirSync).toHaveBeenCalledTimes(1);
  });

  it('accepts a cgroup already removed by the service manager', async () => {
    fakeFs.writeFileSync.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    });
    await expect(manager.remove(cgroup)).resolves.toBe(true);
  });
});

describe('Structured execution cleanup completion', () => {
  it.each([false, true])('waits for cleanup and reports failure=%s exactly once', async (failCleanup) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let finishCleanup;
    const manager = {
      root: '/delegated',
      create: () => ({ name: 'execution-test', directory: '/delegated/execution-test' }),
      remove: vi.fn(() => new Promise((resolve, reject) => {
        finishCleanup = () => failCleanup
          ? reject(Object.assign(new Error('cleanup denied'), { code: 'CGROUP_CLEANUP_FAILED' }))
          : resolve(true);
      })),
    };
    const context = {
      module: { exports: {} }, Buffer, setTimeout, clearTimeout,
      process,
      console: { error: vi.fn() },
      require: (name) => name === 'child_process' ? { spawn: () => child } : require(name),
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../execution.js'), 'utf8'), context);
    const completed = vi.fn();
    context.module.exports.executeStructured('/usr/bin/python3', [], {
      timeoutMs: 10000, maxOutputBytes: 4096, env: {}, cwd: '/fixtures',
      cgroupManager: manager, wrapperPath: '/wrapper', operationId: 'test',
    }, completed);
    child.emit('close', 0, null);
    child.emit('close', 0, null);
    expect(completed).not.toHaveBeenCalled();
    finishCleanup();
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.remove).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][1].exitCode).toBe(0);
    if (failCleanup) {
      expect(completed.mock.calls[0][0]).toMatchObject({ code: 'CGROUP_CLEANUP_FAILED' });
      expect(context.console.error).toHaveBeenCalledWith(expect.stringContaining('test'));
    } else {
      expect(completed.mock.calls[0][0]).toBeNull();
    }
  });
});
