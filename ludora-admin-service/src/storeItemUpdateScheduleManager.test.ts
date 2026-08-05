import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  StoreItemUpdateScheduleRun,
  StoreItemUpdateScheduleService
} from './storeItemUpdateScheduleService.js';
import {
  createStoreItemUpdateScheduleManager,
  mexicoCityScheduleDate
} from './storeItemUpdateScheduleManager.js';

const AUTOMATIC_DATE = '2026-08-05';
const AFTER_SCHEDULE = new Date('2026-08-05T09:01:00.000Z');

class FakeScheduleService implements StoreItemUpdateScheduleService {
  automaticCalls: Array<{ now: Date; localDate: string }> = [];
  manualCalls: Date[] = [];
  maximumConcurrentAutomaticCalls = 0;
  private activeAutomaticCalls = 0;
  private automaticResponses: Array<Promise<StoreItemUpdateScheduleRun>> = [];

  queueAutomaticResponse(response: Promise<StoreItemUpdateScheduleRun>): void {
    this.automaticResponses.push(response);
  }

  async runAutomatic(now: Date, localDate: string): Promise<StoreItemUpdateScheduleRun> {
    this.automaticCalls.push({ now, localDate });
    this.activeAutomaticCalls += 1;
    this.maximumConcurrentAutomaticCalls = Math.max(this.maximumConcurrentAutomaticCalls, this.activeAutomaticCalls);
    try {
      return await (this.automaticResponses.shift() ?? Promise.resolve(completedAutomaticRun()));
    } finally {
      this.activeAutomaticCalls -= 1;
    }
  }

  async runManual(now: Date): Promise<StoreItemUpdateScheduleRun> {
    this.manualCalls.push(now);
    return completedManualRun();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('mexicoCityScheduleDate', () => {
  it.each([
    ['2026-08-05T08:59:59.000Z', null],
    ['2026-08-05T09:00:00.000Z', '2026-08-05'],
    ['2026-08-05T15:30:00.000Z', '2026-08-05']
  ])('maps %s to the due automatic date', (instant, expected) => {
    expect(mexicoCityScheduleDate(new Date(instant))).toBe(expected);
  });
});

describe('store item update schedule manager', () => {
  it('does not run automatically when it starts before 3am in Mexico City', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T08:59:59.000Z'));
    const scheduleService = new FakeScheduleService();
    const manager = createStoreItemUpdateScheduleManager({ scheduleService });

    manager.start();
    await vi.runAllTicks();

    expect(scheduleService.automaticCalls).toEqual([]);
    await manager.shutdown();
  });

  it('catches up once when the service starts after 3am', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_SCHEDULE);
    const scheduleService = new FakeScheduleService();
    const manager = createStoreItemUpdateScheduleManager({ scheduleService });

    manager.start();
    await vi.runAllTicks();

    expect(scheduleService.automaticCalls).toEqual([{ now: AFTER_SCHEDULE, localDate: AUTOMATIC_DATE }]);
    await manager.shutdown();
  });

  it('does not call the schedule service again after a completed automatic response for that date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_SCHEDULE);
    const scheduleService = new FakeScheduleService();
    const manager = createStoreItemUpdateScheduleManager({ scheduleService, tickMs: 60_000 });

    manager.start();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(scheduleService.automaticCalls).toHaveLength(1);
    await manager.shutdown();
  });

  it('retries a fulfilled non-completed automatic response on a later tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_SCHEDULE);
    const scheduleService = new FakeScheduleService();
    scheduleService.queueAutomaticResponse(Promise.resolve(runningAutomaticRun()));
    const manager = createStoreItemUpdateScheduleManager({ scheduleService, tickMs: 60_000 });

    manager.start();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(scheduleService.automaticCalls).toHaveLength(2);
    await manager.shutdown();
  });

  it('logs a failed automatic call and retries it on a later tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_SCHEDULE);
    const scheduleService = new FakeScheduleService();
    const failure = new Error('database unavailable');
    scheduleService.queueAutomaticResponse(Promise.reject(failure));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const manager = createStoreItemUpdateScheduleManager({ scheduleService, tickMs: 60_000 });

    manager.start();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(error).toHaveBeenCalledWith('[store-item-update-schedule] automatic run failed', failure);
    expect(scheduleService.automaticCalls).toHaveLength(2);
    await manager.shutdown();
  });

  it('does not overlap periodic automatic ticks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_SCHEDULE);
    const scheduleService = new FakeScheduleService();
    const deferred = createDeferred<StoreItemUpdateScheduleRun>();
    scheduleService.queueAutomaticResponse(deferred.promise);
    const manager = createStoreItemUpdateScheduleManager({ scheduleService, tickMs: 60_000 });

    manager.start();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(scheduleService.maximumConcurrentAutomaticCalls).toBe(1);
    expect(scheduleService.automaticCalls).toHaveLength(1);
    deferred.resolve(completedAutomaticRun());
    await vi.runAllTicks();
    await manager.shutdown();
  });

  it('delegates a manual run with the actual clock time', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-05T17:42:00.000Z');
    vi.setSystemTime(now);
    const scheduleService = new FakeScheduleService();
    const manager = createStoreItemUpdateScheduleManager({ scheduleService });

    const result = await manager.runManual();

    expect(result).toMatchObject({ trigger: 'MANUAL', status: 'COMPLETED' });
    expect(scheduleService.manualCalls).toEqual([now]);
    await manager.shutdown();
  });

  it('stops future ticks and waits for the active automatic tick during shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_SCHEDULE);
    const scheduleService = new FakeScheduleService();
    const deferred = createDeferred<StoreItemUpdateScheduleRun>();
    scheduleService.queueAutomaticResponse(deferred.promise);
    const manager = createStoreItemUpdateScheduleManager({ scheduleService, tickMs: 60_000 });

    manager.start();
    await vi.runAllTicks();
    let stopped = false;
    const shutdown = manager.shutdown().then(() => {
      stopped = true;
    });
    await vi.runAllTicks();

    expect(stopped).toBe(false);
    deferred.resolve(completedAutomaticRun());
    await shutdown;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(scheduleService.automaticCalls).toHaveLength(1);
  });
});

function completedAutomaticRun(): StoreItemUpdateScheduleRun {
  return {
    id: 1,
    trigger: 'AUTOMATIC',
    automatic_schedule_date: AUTOMATIC_DATE,
    status: 'COMPLETED',
    window_start: '2026-08-05T09:01:00.000Z',
    window_end: '2026-08-06T05:01:00.000Z',
    scheduled_item_count: 1,
    scheduled_store_count: 1,
    started_at: '2026-08-05T09:01:00.000Z',
    completed_at: '2026-08-05T09:01:01.000Z',
    error_detail: ''
  };
}

function completedManualRun(): StoreItemUpdateScheduleRun {
  return {
    ...completedAutomaticRun(),
    trigger: 'MANUAL',
    automatic_schedule_date: null
  };
}

function runningAutomaticRun(): StoreItemUpdateScheduleRun {
  return {
    ...completedAutomaticRun(),
    status: 'RUNNING',
    completed_at: null
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
