import { describe, expect, it, vi } from 'vitest';

import type { DiscoveryOperationsClient } from './discoveryOperationsClient.js';
import { createRuntimeManagerLifecycle, type RuntimeManager } from './runtimeManagerLifecycle.js';

describe('createRuntimeManagerLifecycle', () => {
  it('starts and shuts down all configured managers sequentially in runtime order', async () => {
    const events: string[] = [];
    const first = createRecordingManager('first', events);
    const second = createRecordingManager('second', events);
    const daily = createRecordingManager('daily', events);
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
      'first.shutdown',
      'second.shutdown',
      'daily.shutdown'
    ]);
  });

  it('does not construct the daily manager when scheduling is disabled or no operations client exists', async () => {
    const dailyFactory = vi.fn(() => createRecordingManager('daily', []));

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
    const daily = createRecordingManager('daily', events);

    const lifecycle = createRuntimeManagerLifecycle({
      createDailyItemDiscoveryScheduleManager: () => daily,
      dailyItemDiscoveryEnabled: true,
      operationsClient: createOperationsClient()
    });

    lifecycle.start();
    await lifecycle.shutdown();

    expect(events).toEqual(['daily.start', 'daily.shutdown']);
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

function createOperationsClient(): Pick<DiscoveryOperationsClient, 'startItemDiscoveryRun'> {
  return {
    startItemDiscoveryRun: vi.fn()
  };
}
