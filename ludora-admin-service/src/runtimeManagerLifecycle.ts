import {
  createDailyItemDiscoveryScheduleManager,
  type DailyItemDiscoveryScheduleManager
} from './dailyItemDiscoveryScheduleManager.js';
import type { DiscoveryOperationsClient } from './discoveryOperationsClient.js';

export type RuntimeManager = {
  start(): void;
  shutdown(): Promise<void>;
};

export type RuntimeManagerLifecycle = RuntimeManager;

export function createRuntimeManagerLifecycle(options: {
  continuousItemUpdateWorkerManager?: RuntimeManager;
  createDailyItemDiscoveryScheduleManager?: typeof createDailyItemDiscoveryScheduleManager;
  dailyItemDiscoveryEnabled: boolean;
  operationsClient?: Pick<DiscoveryOperationsClient, 'startItemDiscoveryRun'>;
  storeItemUpdateScheduleManager?: RuntimeManager;
}): RuntimeManagerLifecycle {
  const dailyItemDiscoveryScheduleManager: DailyItemDiscoveryScheduleManager | undefined =
    options.dailyItemDiscoveryEnabled && options.operationsClient
      ? (options.createDailyItemDiscoveryScheduleManager ?? createDailyItemDiscoveryScheduleManager)({
          operationsClient: options.operationsClient
        })
      : undefined;
  const managers = [
    options.continuousItemUpdateWorkerManager,
    options.storeItemUpdateScheduleManager,
    dailyItemDiscoveryScheduleManager
  ].filter((manager): manager is RuntimeManager => manager !== undefined);
  let shutdownPromise: Promise<void> | null = null;

  const drainManagers = async (): Promise<void> => {
    for (const manager of managers) {
      await manager.shutdown();
    }
  };

  return {
    start(): void {
      for (const manager of managers) {
        manager.start();
      }
    },
    shutdown(): Promise<void> {
      if (!shutdownPromise) {
        dailyItemDiscoveryScheduleManager?.disarm();
        shutdownPromise = drainManagers();
      }
      return shutdownPromise;
    }
  };
}
