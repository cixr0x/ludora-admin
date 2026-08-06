import { DiscoveryOperationError, type DiscoveryOperationsClient } from './discoveryOperationsClient.js';

const DISCOVERY_START_HOUR = 5;
const DISCOVERY_TIME_ZONE = 'America/Mexico_City';

const mexicoCityDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
  minute: '2-digit',
  month: '2-digit',
  second: '2-digit',
  timeZone: DISCOVERY_TIME_ZONE,
  year: 'numeric'
});

type LocalDate = {
  day: number;
  month: number;
  year: number;
};

export type DailyItemDiscoveryScheduleManager = {
  disarm(): void;
  start(): void;
  shutdown(): Promise<void>;
};

export function nextMexicoCityDiscoveryAt(now: Date): Date {
  const localDate = mexicoCityLocalDate(now);
  const todayAtStartHour = mexicoCityDateAtHour(localDate, DISCOVERY_START_HOUR);
  if (todayAtStartHour.getTime() >= now.getTime()) {
    return todayAtStartHour;
  }

  return mexicoCityDateAtHour(addLocalDays(localDate, 1), DISCOVERY_START_HOUR);
}

export function createDailyItemDiscoveryScheduleManager(options: {
  now?: () => Date;
  operationsClient: Pick<DiscoveryOperationsClient, 'startItemDiscoveryRun'>;
}): DailyItemDiscoveryScheduleManager {
  const now = options.now ?? (() => new Date());
  let timer: ReturnType<typeof setTimeout> | null = null;
  const activeLaunches = new Set<Promise<void>>();
  let stopped = false;
  let shutdownPromise: Promise<void> | null = null;

  const disarm = (): void => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleFrom = (from: Date): void => {
    if (stopped) {
      return;
    }

    const current = now();
    let scheduledAt = nextMexicoCityDiscoveryAt(from);
    if (scheduledAt.getTime() < current.getTime()) {
      scheduledAt = nextMexicoCityDiscoveryAt(current);
    }
    const delay = Math.max(0, scheduledAt.getTime() - current.getTime());

    timer = setTimeout(() => {
      timer = null;
      scheduleFrom(new Date(scheduledAt.getTime() + 1));

      const launchPromise = Promise.resolve()
        .then(() => options.operationsClient.startItemDiscoveryRun({ all_stores: true }))
        .then((run) => {
          console.info('[item-discovery-schedule] automatic run started', run.id);
        })
        .catch((error: unknown) => {
          if (error instanceof DiscoveryOperationError && error.status === 409) {
            console.warn('[item-discovery-schedule] automatic run skipped', error);
            return;
          }
          console.error('[item-discovery-schedule] automatic launch failed', error);
        })
        .finally(() => {
          activeLaunches.delete(launchPromise);
        });
      activeLaunches.add(launchPromise);
    }, delay);
    console.info('[item-discovery-schedule] next run scheduled', scheduledAt.toISOString());
  };

  return {
    disarm,
    start(): void {
      if (stopped || timer) {
        return;
      }
      scheduleFrom(now());
    },
    shutdown(): Promise<void> {
      disarm();
      if (!shutdownPromise) {
        shutdownPromise = (async () => {
          await Promise.all(activeLaunches);
          console.info('[item-discovery-schedule] stopped');
        })();
      }
      return shutdownPromise;
    }
  };
}

function mexicoCityLocalDate(instant: Date): LocalDate {
  const parts = dateTimeParts(instant);
  return { day: parts.day, month: parts.month, year: parts.year };
}

function mexicoCityDateAtHour(localDate: LocalDate, hour: number): Date {
  const utcGuess = Date.UTC(localDate.year, localDate.month - 1, localDate.day, hour);
  let offset = mexicoCityOffsetMilliseconds(new Date(utcGuess));
  let candidate = utcGuess - offset;
  const candidateOffset = mexicoCityOffsetMilliseconds(new Date(candidate));
  if (candidateOffset !== offset) {
    offset = candidateOffset;
    candidate = utcGuess - offset;
  }
  return new Date(candidate);
}

function mexicoCityOffsetMilliseconds(instant: Date): number {
  const parts = dateTimeParts(instant);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return localAsUtc - instant.getTime();
}

function dateTimeParts(instant: Date): LocalDate & { hour: number; minute: number; second: number } {
  const values = Object.fromEntries(
    mexicoCityDateTimeFormatter
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    month: values.month,
    second: values.second,
    year: values.year
  };
}

function addLocalDays(localDate: LocalDate, days: number): LocalDate {
  const date = new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day + days));
  return {
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    year: date.getUTCFullYear()
  };
}
