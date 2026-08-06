import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscoveryOperationError, type DiscoveryOperationsClient } from './discoveryOperationsClient.js';
import {
  createDailyItemDiscoveryScheduleManager,
  nextMexicoCityDiscoveryAt
} from './dailyItemDiscoveryScheduleManager.js';
import {
  createLocalDiscoveryOperationsClient,
  type SpawnDiscoveryProcess
} from './localDiscoveryOperationsClient.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('nextMexicoCityDiscoveryAt', () => {
  it.each([
    ['2026-08-05T10:59:59.000Z', '2026-08-05T11:00:00.000Z'],
    ['2026-08-05T11:00:00.000Z', '2026-08-05T11:00:00.000Z'],
    ['2026-08-05T11:00:00.001Z', '2026-08-06T11:00:00.000Z']
  ])('maps %s to the next Mexico City 05:00 occurrence', (now, expected) => {
    expect(nextMexicoCityDiscoveryAt(new Date(now)).toISOString()).toBe(expected);
  });
});

describe('daily item discovery schedule manager', () => {
  it('launches all-store discovery at 05:00 and only once per local day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T10:59:59.000Z'));
    const startItemDiscoveryRun = vi
      .fn<DiscoveryOperationsClient['startItemDiscoveryRun']>()
      .mockResolvedValue(discoveryRun('run-1'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const manager = createDailyItemDiscoveryScheduleManager({ operationsClient: { startItemDiscoveryRun } });

    manager.start();
    expect(startItemDiscoveryRun).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(startItemDiscoveryRun).toHaveBeenCalledTimes(1);
    expect(startItemDiscoveryRun).toHaveBeenCalledWith({ all_stores: true });
    expect(info).toHaveBeenCalledWith('[item-discovery-schedule] automatic run started', 'run-1');

    await vi.advanceTimersByTimeAsync(86_399_999);
    expect(startItemDiscoveryRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(startItemDiscoveryRun).toHaveBeenCalledTimes(2);
    await manager.shutdown();
  });

  it('does not catch up when it starts after the scheduled instant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T11:00:00.001Z'));
    const startItemDiscoveryRun = vi
      .fn<DiscoveryOperationsClient['startItemDiscoveryRun']>()
      .mockResolvedValue(discoveryRun('run-1'));
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const manager = createDailyItemDiscoveryScheduleManager({ operationsClient: { startItemDiscoveryRun } });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(startItemDiscoveryRun).not.toHaveBeenCalled();
    await manager.shutdown();
  });

  it('logs a conflict once and waits until the following local day to try again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T10:59:59.000Z'));
    const conflict = new DiscoveryOperationError('Discovery operation is already running', 409);
    const startItemDiscoveryRun = vi
      .fn<DiscoveryOperationsClient['startItemDiscoveryRun']>()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValue(discoveryRun('run-2'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const manager = createDailyItemDiscoveryScheduleManager({ operationsClient: { startItemDiscoveryRun } });

    manager.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith('[item-discovery-schedule] automatic run skipped', conflict);
    expect(startItemDiscoveryRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(86_399_999);
    expect(startItemDiscoveryRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(startItemDiscoveryRun).toHaveBeenCalledTimes(2);
    await manager.shutdown();
  });

  it('logs a local child coordinator conflict as skipped without first logging a started run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T10:59:59.000Z'));
    const child = new ScheduleFakeChildProcess();
    const spawnProcess: SpawnDiscoveryProcess = () => child as never;
    const localClient = createLocalDiscoveryOperationsClient({
      envFile: 'C:/PROJECTS/ludora/ludora-admin/ludora-admin-service/.env',
      packageDir: 'C:/PROJECTS/ludora/ludora-admin/ludora-discovery',
      pythonExecutable: 'python',
      spawnProcess
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = createDailyItemDiscoveryScheduleManager({ operationsClient: localClient });

    manager.start();
    await vi.advanceTimersByTimeAsync(1_000);
    child.stderr.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          error: {
            code: 'OPERATION_ALREADY_RUNNING',
            message: 'Item discovery is already running'
          }
        })
      )
    );
    child.emit('close', 1, null);
    await flushPromises();

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toBe('[item-discovery-schedule] automatic run skipped');
    expect(warning.mock.calls[0][1]).toMatchObject({ status: 409 });
    expect(info).not.toHaveBeenCalledWith(
      '[item-discovery-schedule] automatic run started',
      expect.anything()
    );
    await manager.shutdown();
    await localClient.shutdown();
  });

  it('logs a non-conflict failure once and waits until the following local day to try again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T10:59:59.000Z'));
    const failure = new Error('operations API unavailable');
    const startItemDiscoveryRun = vi
      .fn<DiscoveryOperationsClient['startItemDiscoveryRun']>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(discoveryRun('run-2'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const manager = createDailyItemDiscoveryScheduleManager({ operationsClient: { startItemDiscoveryRun } });

    manager.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('[item-discovery-schedule] automatic launch failed', failure);
    expect(startItemDiscoveryRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(86_399_999);
    expect(startItemDiscoveryRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(startItemDiscoveryRun).toHaveBeenCalledTimes(2);
    await manager.shutdown();
  });

  it('clears the next timer and waits for an in-flight launch during shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T11:00:00.000Z'));
    const deferred = createDeferred<ReturnType<typeof discoveryRun>>();
    const startItemDiscoveryRun = vi
      .fn<DiscoveryOperationsClient['startItemDiscoveryRun']>()
      .mockReturnValue(deferred.promise);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const manager = createDailyItemDiscoveryScheduleManager({ operationsClient: { startItemDiscoveryRun } });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(startItemDiscoveryRun).toHaveBeenCalledTimes(1);

    let shutdownComplete = false;
    const shutdown = manager.shutdown().then(() => {
      shutdownComplete = true;
    });
    await Promise.resolve();

    expect(shutdownComplete).toBe(false);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(startItemDiscoveryRun).toHaveBeenCalledTimes(1);

    deferred.resolve(discoveryRun('run-1'));
    await shutdown;

    expect(shutdownComplete).toBe(true);
    expect(info).toHaveBeenCalledWith('[item-discovery-schedule] stopped');
  });

  it('disarms its timer synchronously and logs stopped only once across repeated shutdown calls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T10:59:59.000Z'));
    const startItemDiscoveryRun = vi
      .fn<DiscoveryOperationsClient['startItemDiscoveryRun']>()
      .mockResolvedValue(discoveryRun('run-1'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const manager = createDailyItemDiscoveryScheduleManager({ operationsClient: { startItemDiscoveryRun } });

    manager.start();
    manager.disarm();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(startItemDiscoveryRun).not.toHaveBeenCalled();

    await Promise.all([manager.shutdown(), manager.shutdown()]);
    await manager.shutdown();

    expect(
      info.mock.calls.filter(([message]) => message === '[item-discovery-schedule] stopped')
    ).toHaveLength(1);
  });

  it('waits for every overlapping launch request during shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T11:00:00.000Z'));
    const firstLaunch = createDeferred<ReturnType<typeof discoveryRun>>();
    const secondLaunch = createDeferred<ReturnType<typeof discoveryRun>>();
    const startItemDiscoveryRun = vi
      .fn<DiscoveryOperationsClient['startItemDiscoveryRun']>()
      .mockReturnValueOnce(firstLaunch.promise)
      .mockReturnValueOnce(secondLaunch.promise);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const manager = createDailyItemDiscoveryScheduleManager({ operationsClient: { startItemDiscoveryRun } });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(startItemDiscoveryRun).toHaveBeenCalledTimes(2);

    let shutdownComplete = false;
    const shutdown = manager.shutdown().then(() => {
      shutdownComplete = true;
    });

    secondLaunch.resolve(discoveryRun('run-2'));
    await flushPromises();

    expect(shutdownComplete).toBe(false);

    firstLaunch.resolve(discoveryRun('run-1'));
    await shutdown;
    expect(shutdownComplete).toBe(true);
  });
});

function discoveryRun(id: string) {
  return {
    completed_at: null,
    error: null,
    id,
    result: null,
    started_at: '2026-08-05T11:00:00.000Z',
    status: 'running' as const,
    type: 'item_discovery' as const
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

class ScheduleFakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  kill(): boolean {
    return true;
  }
}
