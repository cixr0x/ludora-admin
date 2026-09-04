import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createContinuousItemUpdateWorkerProcessTreeTerminator,
  createContinuousItemUpdateWorkerManager,
  type SpawnContinuousItemUpdateWorker
} from './continuousItemUpdateWorkerManager.js';

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killSignals: NodeJS.Signals[] = [];
  closeOnSigterm = true;

  kill(signal?: NodeJS.Signals): boolean {
    if (signal) {
      this.killSignals.push(signal);
      if (signal === 'SIGTERM' && this.closeOnSigterm) {
        queueMicrotask(() => this.emit('close', 0, signal));
      }
    }
    return true;
  }
}

function createManager(
  overrides: Partial<Parameters<typeof createContinuousItemUpdateWorkerManager>[0]> = {}
) {
  const spawned: FakeChildProcess[] = [];
  const terminateProcessTree = vi.fn();
  const manager = createContinuousItemUpdateWorkerManager({
    adminApiUrl: 'http://127.0.0.1:4001',
    envFile: 'C:/ludora-discovery/.env',
    internalApiToken: 'internal-token',
    itemTimeoutSeconds: 120,
    leaseSeconds: 300,
    packageDir: 'C:/ludora-discovery',
    pollSeconds: 5,
    pythonExecutable: 'python',
    restartDelayMs: 15_000,
    spawnProcess: () => {
      const child = new FakeChildProcess();
      spawned.push(child);
      return child as never;
    },
    terminateProcessTree,
    ...overrides
  });
  return { manager, spawned, terminateProcessTree };
}

describe('continuous item update worker manager', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts the persistent Python worker with cadence, lease, and internal auth configuration', async () => {
    const spawned: Array<{ command: string; args: string[]; options: unknown; child: FakeChildProcess }> = [];
    const spawnProcess: SpawnContinuousItemUpdateWorker = (command, args, options) => {
      const child = new FakeChildProcess();
      spawned.push({ command, args, options, child });
      return child as never;
    };
    const manager = createContinuousItemUpdateWorkerManager({
      adminApiUrl: 'http://127.0.0.1:4001',
      envFile: 'C:/PROJECTS/ludora/ludora-admin/ludora-discovery/.env',
      internalApiToken: 'internal-token',
      itemTimeoutSeconds: 120,
      leaseSeconds: 300,
      packageDir: 'C:/PROJECTS/ludora/ludora-admin/ludora-discovery',
      pollSeconds: 5,
      pythonExecutable: 'python',
      spawnProcess
    });

    manager.start();

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      args: [
        '-m',
        'ludora.continuous_update_worker',
        '--env-file',
        'C:/PROJECTS/ludora/ludora-admin/ludora-discovery/.env',
        '--poll-seconds',
        '5',
        '--lease-seconds',
        '300'
      ],
      command: 'python',
      options: {
        cwd: 'C:/PROJECTS/ludora/ludora-admin/ludora-discovery',
        env: expect.objectContaining({
          LUDORA_ADMIN_API_URL: 'http://127.0.0.1:4001',
          LUDORA_INTERNAL_API_TOKEN: 'internal-token',
          PYTHONPATH: 'C:\\PROJECTS\\ludora\\ludora-admin\\ludora-discovery\\src'
        })
      }
    });

    await manager.shutdown();
    expect(spawned[0].child.killSignals).toEqual(['SIGTERM']);
  });

  it('terminates the dedicated POSIX worker process group', () => {
    const killProcess = vi.fn();
    const terminateProcessTree = createContinuousItemUpdateWorkerProcessTreeTerminator({
      killProcess,
      platform: 'linux'
    });

    terminateProcessTree({ kill: vi.fn(), pid: 123 } as never, 'SIGKILL');

    expect(killProcess).toHaveBeenCalledWith(-123, 'SIGKILL');
  });

  it('uses taskkill to terminate a Windows worker process tree', () => {
    const executeTaskkill = vi.fn();
    const terminateProcessTree = createContinuousItemUpdateWorkerProcessTreeTerminator({
      executeTaskkill,
      platform: 'win32'
    });

    terminateProcessTree({ kill: vi.fn(), pid: 123 } as never, 'SIGKILL');

    expect(executeTaskkill).toHaveBeenCalledWith(123);
  });

  it('pauses the automatic worker and resumes it after the child exits', () => {
    const spawned: FakeChildProcess[] = [];
    const manager = createContinuousItemUpdateWorkerManager({
      adminApiUrl: 'http://127.0.0.1:4001',
      envFile: 'C:/ludora-discovery/.env',
      internalApiToken: 'internal-token',
      itemTimeoutSeconds: 120,
      leaseSeconds: 300,
      packageDir: 'C:/ludora-discovery',
      pollSeconds: 5,
      pythonExecutable: 'python',
      spawnProcess: () => {
        const child = new FakeChildProcess();
        child.closeOnSigterm = false;
        spawned.push(child);
        return child as never;
      }
    });

    manager.start();

    expect(manager.getStatus()).toBe('running');
    expect(manager.pause()).toBe('stopping');
    expect(spawned[0].killSignals).toEqual(['SIGTERM']);
    expect(manager.pause()).toBe('stopping');
    expect(spawned[0].killSignals).toEqual(['SIGTERM']);

    spawned[0].emit('close', 0, 'SIGTERM');

    expect(manager.getStatus()).toBe('paused');
    expect(manager.resume()).toBe('running');
    expect(spawned).toHaveLength(2);
    expect(manager.resume()).toBe('running');
    expect(spawned).toHaveLength(2);
  });

  it('relaunches once after resume is requested while the worker is stopping', () => {
    const spawned: FakeChildProcess[] = [];
    const manager = createContinuousItemUpdateWorkerManager({
      adminApiUrl: 'http://127.0.0.1:4001',
      envFile: 'C:/ludora-discovery/.env',
      internalApiToken: 'internal-token',
      itemTimeoutSeconds: 120,
      leaseSeconds: 300,
      packageDir: 'C:/ludora-discovery',
      pollSeconds: 5,
      pythonExecutable: 'python',
      spawnProcess: () => {
        const child = new FakeChildProcess();
        child.closeOnSigterm = false;
        spawned.push(child);
        return child as never;
      }
    });

    manager.start();
    manager.pause();

    expect(manager.resume()).toBe('stopping');
    expect(spawned).toHaveLength(1);

    spawned[0].emit('close', 0, 'SIGTERM');

    expect(manager.getStatus()).toBe('running');
    expect(spawned).toHaveLength(2);
  });

  it('arms and clears the watchdog from split and coalesced lifecycle output without changing forwarded output', () => {
    vi.useFakeTimers();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { manager, spawned, terminateProcessTree } = createManager({ itemTimeoutSeconds: 2 });

    manager.start();
    spawned[0].stdout.emit('data', '{"event":"worker.item.st');
    spawned[0].stdout.emit(
      'data',
      'arted","attempt_id":17,"store_item_id":42,"platform":"shopify"}\n{"event":"worker.item.succeeded","attempt_id":17,"store_item_id":42}\n'
    );
    vi.advanceTimersByTime(2_000);

    expect(terminateProcessTree).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('[continuous-item-update] {"event":"worker.item.st');
    expect(write).toHaveBeenCalledWith(
      '[continuous-item-update] arted","attempt_id":17,"store_item_id":42,"platform":"shopify"}\n{"event":"worker.item.succeeded","attempt_id":17,"store_item_id":42}\n'
    );
  });

  it('hard-kills a timed out item process tree, logs its identifiers, and restarts once', () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { manager, spawned, terminateProcessTree } = createManager({ itemTimeoutSeconds: 2 });

    manager.start();
    spawned[0].stdout.emit(
      'data',
      '{"event":"worker.item.started","attempt_id":17,"store_item_id":42,"platform":"shopify"}\n'
    );
    vi.advanceTimersByTime(2_000);

    expect(terminateProcessTree).toHaveBeenCalledWith(spawned[0], 'SIGKILL');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('attempt_id=17 store_item_id=42 platform=shopify timeout_seconds=2 elapsed_ms=2000')
    );

    spawned[0].emit('close', null, 'SIGKILL');
    vi.advanceTimersByTime(15_000);
    expect(spawned).toHaveLength(2);
  });

  it('clears an active watchdog during shutdown', async () => {
    vi.useFakeTimers();
    const { manager, spawned, terminateProcessTree } = createManager({ itemTimeoutSeconds: 2 });

    manager.start();
    spawned[0].closeOnSigterm = false;
    spawned[0].stdout.emit(
      'data',
      '{"event":"worker.item.started","attempt_id":17,"store_item_id":42,"platform":"shopify"}\n'
    );
    const shutdown = manager.shutdown();
    vi.advanceTimersByTime(2_000);

    expect(terminateProcessTree).not.toHaveBeenCalled();
    spawned[0].emit('close', 0, 'SIGTERM');
    await shutdown;
  });
});
