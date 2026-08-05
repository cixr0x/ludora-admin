import type {
  StoreItemUpdateScheduleRun,
  StoreItemUpdateScheduleService
} from './storeItemUpdateScheduleService.js';
import {
  mexicoCityScheduleDate,
  StoreItemUpdateScheduleConflictError
} from './storeItemUpdateScheduleService.js';

export { mexicoCityScheduleDate } from './storeItemUpdateScheduleService.js';

const DEFAULT_TICK_MS = 60_000;

export type StoreItemUpdateScheduleManager = {
  runManual(): Promise<StoreItemUpdateScheduleRun>;
  shutdown(): Promise<void>;
  start(): void;
};

export function createStoreItemUpdateScheduleManager(options: {
  now?: () => Date;
  scheduleService: StoreItemUpdateScheduleService;
  tickMs?: number;
}): StoreItemUpdateScheduleManager {
  const now = options.now ?? (() => new Date());
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  let interval: ReturnType<typeof setInterval> | null = null;
  let activeTick: Promise<void> | null = null;
  let completedAutomaticDate: string | null = null;
  let isShuttingDown = false;

  const tick = (): Promise<void> => {
    if (isShuttingDown || activeTick) {
      return activeTick ?? Promise.resolve();
    }

    const tickNow = now();
    const localDate = mexicoCityScheduleDate(tickNow);
    if (!localDate || completedAutomaticDate === localDate) {
      return Promise.resolve();
    }

    const tickPromise = Promise.resolve()
      .then(() => options.scheduleService.runAutomatic())
      .then((result) => {
        if (result?.status === 'COMPLETED' && result.automatic_schedule_date) {
          completedAutomaticDate = result.automatic_schedule_date;
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof StoreItemUpdateScheduleConflictError)) {
          console.error('[store-item-update-schedule] automatic run failed', error);
        }
      })
      .finally(() => {
        if (activeTick === tickPromise) {
          activeTick = null;
        }
      });
    activeTick = tickPromise;
    return tickPromise;
  };

  return {
    runManual: () => options.scheduleService.runManual(),
    start: () => {
      if (isShuttingDown || interval) {
        return;
      }
      void tick();
      interval = setInterval(() => {
        void tick();
      }, tickMs);
    },
    async shutdown(): Promise<void> {
      isShuttingDown = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      await activeTick;
    }
  };
}
