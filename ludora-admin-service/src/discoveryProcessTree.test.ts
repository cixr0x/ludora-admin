import { describe, expect, it } from 'vitest';
import { createDiscoveryProcessTree, type ProcessIdentity } from './discoveryProcessTree.js';

describe('discovery process tree termination', () => {
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
});
