import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DailyItemDiscoveryScheduleManager } from './dailyItemDiscoveryScheduleManager.js';
import type { DiscoveryOperationsClient } from './discoveryOperationsClient.js';
import { createRuntimeManagerLifecycle, type RuntimeManager } from './runtimeManagerLifecycle.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createRuntimeManagerLifecycle', () => {
  it('starts and shuts down all configured managers sequentially in runtime order', async () => {
    const events: string[] = [];
    const first = createRecordingManager('first', events);
    const second = createRecordingManager('second', events);
    const daily = createRecordingDailyManager('daily', events);
    const operationsClient = createOperationsClient();
    let receivedOperationsClient: Pick<DiscoveryOperationsClient, 'startItemDiscoveryRun'> | undefined;
    const dailyFactory = (options: {
      operationsClient: Pick<DiscoveryOperationsClient, 'startItemDiscoveryRun'>;
    }) => {
      receivedOperationsClient = options.operationsClient;
      return daily;
    };

    const lifecycle = createRuntimeManagerLifecycle({
      continuousItemUpdateWorkerManager: first,
      createDailyItemDiscoveryScheduleManager: dailyFactory,
      dailyItemDiscoveryEnabled: true,
      operationsClient,
      storeItemUpdateScheduleManager: second
    });

    lifecycle.start();
    await lifecycle.shutdown();

    expect(receivedOperationsClient).toBe(operationsClient);
    expect(events).toEqual([
      'first.start',
      'second.start',
      'daily.start',
      'daily.disarm',
      'first.shutdown',
      'second.shutdown',
      'daily.shutdown'
    ]);
  });

  it('does not construct the daily manager when scheduling is disabled or no operations client exists', async () => {
    const dailyFactory = vi.fn(() => createRecordingDailyManager('daily', []));

    const disabledLifecycle = createRuntimeManagerLifecycle({
      createDailyItemDiscoveryScheduleManager: dailyFactory,
      dailyItemDiscoveryEnabled: false,
      operationsClient: createOperationsClient()
    });
    const clientlessLifecycle = createRuntimeManagerLifecycle({
      createDailyItemDiscoveryScheduleManager: dailyFactory,
      dailyItemDiscoveryEnabled: true
    });

    disabledLifecycle.start();
    clientlessLifecycle.start();
    await disabledLifecycle.shutdown();
    await clientlessLifecycle.shutdown();

    expect(dailyFactory).not.toHaveBeenCalled();
  });

  it('skips undefined continuous and update schedule managers', async () => {
    const events: string[] = [];
    const daily = createRecordingDailyManager('daily', events);

    const lifecycle = createRuntimeManagerLifecycle({
      createDailyItemDiscoveryScheduleManager: () => daily,
      dailyItemDiscoveryEnabled: true,
      operationsClient: createOperationsClient()
    });

    lifecycle.start();
    await lifecycle.shutdown();

    expect(events).toEqual(['daily.start', 'daily.disarm', 'daily.shutdown']);
  });

  it('disarms daily discovery before waiting for an earlier manager to drain across 05:00', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T10:59:59.000Z'));
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const earlierShutdown = createDeferred<void>();
    const continuous: RuntimeManager = {
      start: vi.fn(),
      shutdown: vi.fn(() => earlierShutdown.promise)
    };
    const updateSchedule: RuntimeManager = {
      start: vi.fn(),
      shutdown: vi.fn(async () => undefined)
    };
    const operationsClient = createOperationsClient();
    vi.mocked(operationsClient.startItemDiscoveryRun).mockResolvedValue(discoveryRun('run-1'));
    const lifecycle = createRuntimeManagerLifecycle({
      continuousItemUpdateWorkerManager: continuous,
      dailyItemDiscoveryEnabled: true,
      operationsClient,
      storeItemUpdateScheduleManager: updateSchedule
    });

    lifecycle.start();
    const shutdown = lifecycle.shutdown();
    await Promise.resolve();
    expect(continuous.shutdown).toHaveBeenCalledTimes(1);
    expect(updateSchedule.shutdown).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(operationsClient.startItemDiscoveryRun).not.toHaveBeenCalled();

    earlierShutdown.resolve();
    await shutdown;
    expect(updateSchedule.shutdown).toHaveBeenCalledTimes(1);
  });

  it('drains every runtime manager only once across repeated shutdown calls', async () => {
    const events: string[] = [];
    const first = createRecordingManager('first', events);
    const second = createRecordingManager('second', events);
    const daily = createRecordingDailyManager('daily', events);
    const lifecycle = createRuntimeManagerLifecycle({
      continuousItemUpdateWorkerManager: first,
      createDailyItemDiscoveryScheduleManager: () => daily,
      dailyItemDiscoveryEnabled: true,
      operationsClient: createOperationsClient(),
      storeItemUpdateScheduleManager: second
    });

    await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()]);
    await lifecycle.shutdown();

    expect(events).toEqual([
      'daily.disarm',
      'first.shutdown',
      'second.shutdown',
      'daily.shutdown'
    ]);
  });
});

function createRecordingManager(name: string, events: string[]): RuntimeManager {
  return {
    start(): void {
      events.push(`${name}.start`);
    },
    async shutdown(): Promise<void> {
      events.push(`${name}.shutdown`);
    }
  };
}

function createRecordingDailyManager(
  name: string,
  events: string[]
): DailyItemDiscoveryScheduleManager {
  return {
    disarm(): void {
      events.push(`${name}.disarm`);
    },
    start(): void {
      events.push(`${name}.start`);
    },
    async shutdown(): Promise<void> {
      events.push(`${name}.shutdown`);
    }
  };
}

function createOperationsClient(): Pick<DiscoveryOperationsClient, 'startItemDiscoveryRun'> {
  return {
    startItemDiscoveryRun: vi.fn()
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

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
