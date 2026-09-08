import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createDiscoveryProcessTree, type ProcessIdentity } from './discoveryProcessTree.js';

describe('discovery process tree termination', () => {
  it('keeps a Linux subreaper alive while it kills and reaps its worker descendants', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 10, kill: () => true, exitCode: null });
    const signals: Array<[number, string]> = [];
    const tree = createDiscoveryProcessTree(child as never, {
      platform: 'linux', supervised: true, listProcesses: () => [root], readIdentity: () => root,
      killProcess: (pid, value) => { signals.push([pid, value]); }
    });
    let completed = false;
    const stopped = tree.terminate().then(() => { completed = true; });
    expect(signals).toEqual([[10, 'SIGUSR1']]);
    await Promise.resolve();
    expect(completed).toBe(false);
    child.emit('exit', 137, null);
    await stopped;
    expect(signals).toEqual([[10, 'SIGUSR1']]);
  });

  it('uses external subtree cleanup if a Linux supervisor does not respond', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), { pid: 10, kill: () => true, exitCode: null });
      const signals: Array<[number, string]> = [];
      const tree = createDiscoveryProcessTree(child as never, {
        platform: 'linux', supervised: true, listProcesses: () => [root, driver], readIdentity: (pid) => pid === 10 ? root : driver,
        killProcess: (pid, value) => { signals.push([pid, value]); }
      });
      const stopped = tree.terminate();
      await vi.advanceTimersByTimeAsync(5000);
      await stopped;
      expect(signals).toContainEqual([10, 'SIGUSR1']);
      expect(signals.filter(([, value]) => value === 'SIGKILL').map(([pid]) => pid)).toEqual([11, 10]);
      expect(child.listenerCount('exit')).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  const root = { pid: 10, ppid: 2, identity: 'root' };
  const driver = { pid: 11, ppid: 10, identity: 'driver' };
  // Parentage is the ownership boundary. A session/group leader is still a descendant.
  const browser = { pid: 12, ppid: 11, identity: 'browser-setsid' };
  const renderer = { pid: 13, ppid: 12, identity: 'renderer' };
  function fixture(platform: NodeJS.Platform = 'linux') {
    let rows: ProcessIdentity[] = [root, driver, browser, renderer, { pid: 20, ppid: 2, identity: 'unrelated' }];
    const signals: Array<[number, string]> = [];
    const taskkills: number[] = [];
    const tree = createDiscoveryProcessTree({ pid: 10, kill: () => true }, {
      platform, listProcesses: () => rows,
      readIdentity: (pid) => rows.find((row) => row.pid === pid),
      killProcess: (pid, signal) => { signals.push([pid, signal]); },
      executeTaskkill: async (pid) => { taskkills.push(pid); }
    });
    return { tree, signals, taskkills, setRows: (next: ProcessIdentity[]) => { rows = next; } };
  }

  it('kills descendant session leaders and leaves service and unrelated processes alone', async () => {
    const { tree, signals } = fixture();
    await tree.terminate();
    expect(signals.filter(([, signal]) => signal === 'SIGKILL').map(([pid]) => pid)).toEqual([13, 12, 11, 10]);
    expect(signals.every(([pid]) => [10, 11, 12, 13].includes(pid))).toBe(true);
    expect(signals[0]).toEqual([10, 'SIGSTOP']);
  });

  it('retains descendants captured before cooperative cancellation reparents them', async () => {
    const { tree, signals, setRows } = fixture();
    tree.capture();
    setRows([{ ...browser, ppid: 1 }, renderer]);
    await tree.terminate();
    expect(signals.filter(([, signal]) => signal === 'SIGKILL').map(([pid]) => pid)).toEqual([13, 12]);
  });

  it('does not signal reused PIDs or their unrelated descendants', async () => {
    const { tree, signals, setRows } = fixture();
    tree.capture();
    setRows([{ ...root, identity: 'new-root' }, { ...browser, identity: 'new-browser' }, { pid: 99, ppid: 12, identity: 'new-child' }]);
    await tree.terminate();
    expect(signals).toEqual([]);
  });

  it('uses Windows taskkill for the owned tree and reports errors', async () => {
    const { tree, taskkills } = fixture('win32');
    await tree.terminate();
    expect(taskkills).toContain(10);
    expect(taskkills.every((pid) => [10, 11, 12, 13].includes(pid))).toBe(true);
  });

  it('surfaces permission errors while continuing cleanup of other descendants', async () => {
    const killed: number[] = [];
    const rows = [root, driver, browser, renderer];
    const tree = createDiscoveryProcessTree({ pid: 10, kill: () => true }, {
      platform: 'linux', listProcesses: () => rows, readIdentity: (pid) => rows.find((row) => row.pid === pid),
      killProcess: (pid, signal) => {
        if (pid === 12 && signal === 'SIGKILL') throw new Error('permission denied');
        if (signal === 'SIGKILL') killed.push(pid);
      }
    });
    await expect(tree.terminate()).rejects.toThrow('permission denied');
    expect(killed).toContain(10);
  });

  it('retains the subreaper ownership boundary if external fallback cannot kill a descendant', async () => {
    const signals: Array<[number, string]> = [];
    const rows = [root, driver];
    const tree = createDiscoveryProcessTree({ pid: 10, kill: () => true }, {
      platform: 'linux', supervised: true, listProcesses: () => rows,
      readIdentity: (pid) => rows.find((row) => row.pid === pid),
      killProcess: (pid, value) => {
        signals.push([pid, value]);
        if (pid === 11 && value === 'SIGKILL') throw new Error('permission denied');
      }
    });
    await expect(tree.terminate()).rejects.toThrow('permission denied');
    expect(signals).not.toContainEqual([10, 'SIGKILL']);
    expect(signals).toContainEqual([10, 'SIGCONT']);
  });

  it('waits for delivered stop signals before taking the final subtree snapshot', async () => {
    const rows = [{ ...root, state: 'R' }, { ...driver, state: 'R' }];
    const signals: Array<[number, string]> = [];
    const tree = createDiscoveryProcessTree({ pid: 10, kill: () => true }, {
      platform: 'linux', listProcesses: () => rows, readIdentity: (pid) => rows.find((row) => row.pid === pid),
      killProcess: (pid, value) => {
        signals.push([pid, value]);
        if (value === 'SIGSTOP') queueMicrotask(() => { rows.find((row) => row.pid === pid)!.state = 'T'; });
      }
    });
    const stopped = tree.terminate();
    expect(signals.filter(([, value]) => value === 'SIGKILL')).toEqual([]);
    await stopped;
    expect(signals.filter(([, value]) => value === 'SIGKILL').map(([pid]) => pid)).toEqual([11, 10]);
  });
});
