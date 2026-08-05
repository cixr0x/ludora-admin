import type {
  StoreItemUpdateScheduleRun,
  StoreItemUpdateScheduleService
} from './storeItemUpdateScheduleService.js';

const SCHEDULE_TIME_ZONE = 'America/Mexico_City';
const SCHEDULE_START_HOUR = 3;
const DEFAULT_TICK_MS = 60_000;

const mexicoCityTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHEDULE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23'
});

export type StoreItemUpdateScheduleManager = {
  runManual(): Promise<StoreItemUpdateScheduleRun>;
  shutdown(): Promise<void>;
  start(): void;
};

export function mexicoCityScheduleDate(now: Date): string | null {
  const parts = Object.fromEntries(
    mexicoCityTimeFormatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  const hour = Number(parts.hour);

  if (hour < SCHEDULE_START_HOUR) {
    return null;
  }

  return `${parts.year}-${parts.month}-${parts.day}`;
}

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
      .then(() => options.scheduleService.runAutomatic(tickNow, localDate))
      .then((result) => {
        if (result.status === 'COMPLETED') {
          completedAutomaticDate = localDate;
        }
      })
      .catch((error: unknown) => {
        console.error('[store-item-update-schedule] automatic run failed', error);
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
    runManual: () => options.scheduleService.runManual(now()),
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
