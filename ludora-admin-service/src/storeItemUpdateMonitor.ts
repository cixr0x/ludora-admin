import type { ContinuousItemUpdateWorkerControlStatus } from './continuousItemUpdateWorkerManager.js';
import type { Database } from './db.js';
import { storeItemUpdateAvailabilitySql } from './storeItemUpdateEligibility.js';
import {
  PER_STORE_RUN_PREDICATE,
  STORE_ITEM_UPDATE_SCHEDULE_WINDOW_HOURS
} from './storeItemUpdateScheduleService.js';

const REPORT_FRESH_MS = 3 * 60_000;
const REPORT_RETRY_MS = 60_000;
const MAX_HISTOGRAM_HOURS = 168;

type Row = Record<string, unknown>;
type QueueTotals = {
  due_items: number;
  next_due_at: Date | string | null;
  oldest_due_hours: number;
  scheduled_items: number;
  scheduled_later_items: number;
};
type ListingTotals = {
  eligible_items: number;
  fresh_items: number;
  leased_items: number;
  oldest_staleness_hours: number;
  stale_items: number;
};
type AttemptTotals = {
  attempts: number;
  successes: number;
  failures: number;
  rate_limited: number;
};

type LiveStatus = Awaited<ReturnType<typeof loadLiveStatus>>;
type ReportSnapshot = Awaited<ReturnType<typeof loadReport>>;
type ReportStatus = 'fresh' | 'stale' | 'loading' | 'unavailable';

export function createStoreItemUpdateMonitor(
  database: Database,
  verifiedSitemapStoreIds: readonly string[] = [],
  perStoreSchedule = false
) {
  let pendingStatus: Promise<LiveStatus> | null = null;
  let pendingReport: Promise<void> | null = null;
  let cachedReport: ReportSnapshot | null = null;
  let retryReportAt = 0;

  function refreshReportIfNeeded(now: number, fresh: boolean) {
    if (fresh || pendingReport || now < retryReportAt) {
      return;
    }
    pendingReport = loadReport(database, verifiedSitemapStoreIds, perStoreSchedule, now)
      .then(
        (report) => { cachedReport = report; },
        () => { retryReportAt = Date.now() + REPORT_RETRY_MS; }
      )
      .finally(() => { pendingReport = null; });
  }

  return async function readMonitor(
    rangeHours: number,
    histogramStoreId: number | null,
    controlStatus: ContinuousItemUpdateWorkerControlStatus | 'unavailable'
  ) {
    pendingStatus ??= loadLiveStatus(database, perStoreSchedule)
      .finally(() => { pendingStatus = null; });
    const { cursorStoreIds, pollSeconds, ...live } = await pendingStatus;

    const now = Date.now();
    const snapshot = cachedReport;
    const fresh = snapshot !== null && now - snapshot.observedAt < REPORT_FRESH_MS;
    refreshReportIfNeeded(now, fresh);
    const refreshing = pendingReport !== null;
    const status: ReportStatus = snapshot ? (fresh ? 'fresh' : 'stale') : (refreshing ? 'loading' : 'unavailable');
    const histogram = histogramStoreId === null
      ? snapshot?.histogram
      : snapshot?.histogramsByStore.get(String(histogramStoreId));

    return {
      ...live,
      control_status: controlStatus,
      ...(perStoreSchedule ? { schedule_mode: 'per_store' as const } : {}),
      histogram: snapshot ? projectHistogram(histogram, rangeHours) : [],
      histogram_store_id: histogramStoreId,
      range_hours: rangeHours,
      report: { as_of: snapshot?.asOf ?? null, refreshing, status },
      store_statistics: snapshot?.storeStatistics ?? [],
      summary: snapshot ? summarizeReport(snapshot, live.live_queue, cursorStoreIds, pollSeconds) : null
    };
  };
}

async function loadLiveStatus(database: Database, perStoreSchedule: boolean) {
  const workerResult = await database.query(
    `select
       worker.worker_name, worker.worker_id, worker.status, worker.poll_seconds,
       worker.heartbeat_at, worker.started_at, worker.current_store_item_id,
       current_item.update_lease_expires_at as current_lease_expires_at,
       worker.last_attempt_at, worker.last_success_at, worker.last_failure_at,
       worker.last_error, worker.updated_at
     from store_item_update_worker_state worker
     left join store_items current_item on current_item.id = worker.current_store_item_id
     where worker.worker_name = 'continuous'`
  );
  const workerRow = workerResult.rows[0] as Row | undefined;
  const pollSeconds = workerRow ? numberField(workerRow, 'poll_seconds') || 1 : 1;
  const storeCooldownsResult = await database.query(
    `select
       cooldown.store_id,
       stores.name as store_name,
       coalesce(nullif(lower(trim(stores.platform)), ''), 'unknown') as platform,
       cooldown.blocked_until,
       cooldown.consecutive_429s,
       (cooldown.blocked_until > now()) as active
     from store_item_update_store_cooldown cooldown
     join stores on stores.id = cooldown.store_id
     where cooldown.worker_name = 'continuous'
     order by stores.name, cooldown.store_id`
  );

  const scheduleRunPredicate = perStoreSchedule ? PER_STORE_RUN_PREDICATE : "trigger in ('AUTOMATIC', 'MANUAL')";
  const automaticTrigger = perStoreSchedule ? 'STORE_AUTOMATIC' : 'AUTOMATIC';
  const scheduleRunsResult = await database.query(
    `select
       (select row_to_json(latest_run) from (
         select * from store_item_update_schedule_runs
         where status = 'COMPLETED' and ${scheduleRunPredicate}
         order by completed_at desc, id desc limit 1
       ) latest_run) as latest_schedule_run,
       (select row_to_json(latest_attempt) from (
         select * from store_item_update_schedule_runs
         where ${scheduleRunPredicate}
         order by started_at desc, id desc limit 1
       ) latest_attempt) as latest_schedule_attempt,
       (select row_to_json(latest_automatic) from (
         select * from store_item_update_schedule_runs
         where trigger = '${automaticTrigger}' and status = 'COMPLETED'
         order by automatic_schedule_date desc, id desc limit 1
       ) latest_automatic) as latest_automatic_schedule_run`
  );
  const scheduleRunsRow = (scheduleRunsResult.rows[0] ?? {}) as Row;

  const recentAttemptsResult = await database.query(
    `select
       attempts.id, attempts.store_item_id, attempts.store_id,
       coalesce(stores.name, 'Unknown store') as store_name,
       store_items.title as store_item_title, attempts.platform, attempts.status,
       attempts.changed, attempts.http_status, attempts.error, attempts.started_at,
       attempts.completed_at, attempts.duration_ms
     from store_item_update_attempt_log attempts
     join store_items on store_items.id = attempts.store_item_id
     left join stores on stores.id = attempts.store_id
     order by attempts.started_at desc
     limit 25`
  );

  const queueRow = perStoreSchedule ? (await database.query(
    `select
       coalesce(array_agg(schedule.store_id::text), '{}'::text[]) as active_store_ids,
       coalesce(sum(schedule.eligible_item_count - schedule.next_slot_index), 0)::int as scheduled_items,
       count(*) filter (where schedule.next_due_at <= now())::int as due_items,
       coalesce(max(extract(epoch from (now() - schedule.next_due_at)) / 3600)
         filter (where schedule.next_due_at <= now()), 0)::float8 as oldest_due_hours,
       min(schedule.next_due_at) as next_due_at
     from store_item_update_store_schedules schedule
     join stores on stores.id = schedule.store_id
     where stores.update_active = true and schedule.window_start <= now() and schedule.window_end > now()`
  )).rows[0] as Row | undefined : undefined;
  const activeStoreIds = (queueRow?.active_store_ids ?? []) as string[];

  return {
    cursorStoreIds: new Set(activeStoreIds),
    pollSeconds,
    generated_at: new Date(Date.now()).toISOString(),
    latest_automatic_schedule_run: publicScheduleRun(scheduleRunsRow.latest_automatic_schedule_run),
    latest_schedule_attempt: publicScheduleRun(scheduleRunsRow.latest_schedule_attempt),
    latest_schedule_run: publicScheduleRun(scheduleRunsRow.latest_schedule_run),
    live_queue: perStoreSchedule ? {
      ...readQueueTotals(queueRow ?? {}),
      scheduled_later_items: numberField(queueRow ?? {}, 'scheduled_items') - numberField(queueRow ?? {}, 'due_items')
    } : null,
    recent_attempts: recentAttemptsResult.rows,
    store_cooldowns: (storeCooldownsResult.rows as Row[]).map((record) => ({
      ...record,
      active: record.active === true,
      store_id: numberField(record, 'store_id')
    })),
    worker: workerRow ? { ...workerRow, health: workerHealth(workerRow, pollSeconds) } : null
  };
}

// The same observation time defines freshness, staleness buckets, and the 24-hour attempt period.
async function loadReport(
  database: Database,
  verifiedSitemapStoreIds: readonly string[],
  perStoreSchedule: boolean,
  observedAt: number
) {
  const asOf = new Date(observedAt).toISOString();
  const includeRecovery = verifiedSitemapStoreIds.length > 0;
  const listings = await database.query(
    `select
       stores.id as store_id,
       stores.name as store_name,
       coalesce(nullif(lower(trim(stores.platform)), ''), 'unknown') as platform,
       least(${MAX_HISTOGRAM_HOURS}, greatest(0,
         floor(extract(epoch from ($1::timestamptz - store_items.refreshed_date)) / 3600)))::int as staleness_hour,
       count(store_items.id)::int as eligible_items,
       count(*) filter (where store_items.refreshed_date >= $1::timestamptz - interval '24 hours')::int as fresh_items,
       count(*) filter (where store_items.refreshed_date < $1::timestamptz - interval '24 hours')::int as stale_items,
       count(*) filter (
         where store_items.update_lease_token is not null and store_items.update_lease_expires_at > $1::timestamptz
       )::int as leased_items,
       coalesce(max(extract(epoch from ($1::timestamptz - store_items.refreshed_date)) / 3600), 0)::float8
         as oldest_staleness_hours
       ${perStoreSchedule ? '' : LEGACY_QUEUE_COLUMNS}
     from stores
     left join store_items on store_items.store_id = stores.id
       and store_items.is_boardgame = true
       and store_items.is_boardgame_confirmed = true
       and store_items.item_id is not null
       and store_items.source_url <> ''
       and store_items.listing_status = 'LISTED'
       and store_items.store_active = true
       and ${storeItemUpdateAvailabilitySql(includeRecovery ? 2 : undefined)}
     where stores.update_active = true
     group by stores.id, stores.name, stores.platform, staleness_hour
     order by stores.name asc`,
    includeRecovery ? [asOf, verifiedSitemapStoreIds] : [asOf]
  );
  const attempts = await database.query(
    `select
       attempts.store_id,
       count(*)::int as attempts,
       count(*) filter (where attempts.status in ('succeeded', 'deactivated'))::int as successes,
       count(*) filter (where attempts.status in ('failed', 'lease_lost'))::int as failures,
       count(*) filter (where attempts.http_status = 429)::int as rate_limited,
       max(attempts.started_at) as last_attempt_at,
       max(attempts.completed_at) filter (where attempts.status in ('failed', 'lease_lost')) as last_failure_at,
       (array_agg(attempts.error order by attempts.completed_at desc) filter (
         where attempts.status in ('failed', 'lease_lost')
       ))[1] as last_error
     from store_item_update_attempt_log attempts
     where attempts.started_at >= $1::timestamptz - interval '24 hours'
       and attempts.started_at <= $1::timestamptz
     group by attempts.store_id`,
    [asOf]
  );

  const listingTotals: ListingTotals = {
    eligible_items: 0, fresh_items: 0, leased_items: 0, oldest_staleness_hours: 0, stale_items: 0
  };
  let oldestStalenessHours: number | null = null;
  const attemptTotals: AttemptTotals = { attempts: 0, successes: 0, failures: 0, rate_limited: 0 };
  const legacyQueue = { ...readQueueTotals({}), unscheduled_items: 0 };
  const histogram = emptyHistogram();
  const histogramsByStore = new Map<string, number[]>();
  const stores = new Map<string, {
    store_id: unknown;
    store_name: unknown;
    platform: unknown;
    eligible_items: number;
    stale_items: number;
  }>();

  for (const row of listings.rows as Row[]) {
    const key = String(row.store_id);
    let store = stores.get(key);
    let storeHistogram = histogramsByStore.get(key);
    if (!store || !storeHistogram) {
      store = {
        store_id: row.store_id, store_name: row.store_name, platform: row.platform, eligible_items: 0, stale_items: 0
      };
      storeHistogram = emptyHistogram();
      stores.set(key, store);
      histogramsByStore.set(key, storeHistogram);
    }
    const eligibleItems = numberField(row, 'eligible_items');
    const staleItems = numberField(row, 'stale_items');
    const hour = numberField(row, 'staleness_hour');
    store.eligible_items += eligibleItems;
    store.stale_items += staleItems;
    storeHistogram[hour] += eligibleItems;
    histogram[hour] += eligibleItems;
    listingTotals.eligible_items += eligibleItems;
    listingTotals.stale_items += staleItems;
    listingTotals.fresh_items += numberField(row, 'fresh_items');
    listingTotals.leased_items += numberField(row, 'leased_items');
    if (eligibleItems > 0) {
      const age = numberField(row, 'oldest_staleness_hours');
      oldestStalenessHours = Math.max(oldestStalenessHours ?? age, age);
    }

    if (!perStoreSchedule) {
      const queue = readQueueTotals(row);
      legacyQueue.scheduled_items += queue.scheduled_items;
      legacyQueue.scheduled_later_items += queue.scheduled_later_items;
      legacyQueue.due_items += queue.due_items;
      legacyQueue.unscheduled_items += numberField(row, 'unscheduled_items');
      legacyQueue.oldest_due_hours = Math.max(legacyQueue.oldest_due_hours, queue.oldest_due_hours);
      if (queue.next_due_at && (!legacyQueue.next_due_at || new Date(queue.next_due_at) < new Date(legacyQueue.next_due_at))) {
        legacyQueue.next_due_at = queue.next_due_at;
      }
    }
  }
  listingTotals.oldest_staleness_hours = oldestStalenessHours ?? 0;

  const attemptsByStore = new Map<string, Row>();
  for (const row of attempts.rows as Row[]) {
    attemptTotals.attempts += numberField(row, 'attempts');
    attemptTotals.successes += numberField(row, 'successes');
    attemptTotals.failures += numberField(row, 'failures');
    attemptTotals.rate_limited += numberField(row, 'rate_limited');
    if (row.store_id !== null) {
      attemptsByStore.set(String(row.store_id), row);
    }
  }

  const storeStatistics = [...stores].map(([id, store]) => {
    const row = attemptsByStore.get(id) ?? {};
    const successes = numberField(row, 'successes');
    const failures = numberField(row, 'failures');
    const completed = successes + failures;
    return {
      ...store,
      attempts: numberField(row, 'attempts'),
      successes,
      failures,
      rate_limited: numberField(row, 'rate_limited'),
      success_rate_percent: completed > 0 ? Math.round(1000 * successes / completed) / 10 : 0,
      last_attempt_at: row.last_attempt_at ?? null,
      last_failure_at: row.last_failure_at ?? null,
      last_error: row.last_error ?? null
    };
  }).sort((left, right) => right.failures - left.failures || right.attempts - left.attempts);

  return { asOf, observedAt, listingTotals, attemptTotals, legacyQueue, histogram, histogramsByStore, storeStatistics };
}

const LEGACY_QUEUE_COLUMNS = `,
       count(store_items.id) filter (where store_items.next_update_at is null)::int as unscheduled_items,
       count(*) filter (where store_items.next_update_at is not null)::int as scheduled_items,
       count(*) filter (where store_items.next_update_at > $1::timestamptz)::int as scheduled_later_items,
       count(*) filter (where store_items.next_update_at <= $1::timestamptz)::int as due_items,
       coalesce(max(extract(epoch from ($1::timestamptz - store_items.next_update_at)) / 3600)
         filter (where store_items.next_update_at <= $1::timestamptz), 0)::float8 as oldest_due_hours,
       min(store_items.next_update_at) as next_due_at`;

function emptyHistogram(): number[] {
  return Array<number>(MAX_HISTOGRAM_HOURS + 1).fill(0);
}

function projectHistogram(counts: number[] | undefined, rangeHours: number) {
  return Array.from({ length: rangeHours + 1 }, (_, hour) => ({
    item_count: hour === rangeHours ? counts?.slice(hour).reduce((sum, count) => sum + count, 0) ?? 0 : counts?.[hour] ?? 0,
    label: hour === rangeHours ? `${hour}h+` : `${hour}h`,
    overflow: hour === rangeHours,
    staleness_hour: hour
  }));
}

function summarizeReport(snapshot: ReportSnapshot, liveQueue: QueueTotals | null, cursorStoreIds: Set<string>, pollSeconds: number) {
  const { listingTotals, attemptTotals, legacyQueue } = snapshot;
  const eligibleItems = listingTotals.eligible_items;
  const completed = attemptTotals.successes + attemptTotals.failures;
  const dailyCapacity = 86_400 / pollSeconds;
  const windowHours = STORE_ITEM_UPDATE_SCHEDULE_WINDOW_HOURS;
  const windowCapacity = Math.floor((windowHours * 3600) / pollSeconds);
  const unscheduledItems = liveQueue
    ? snapshot.storeStatistics.reduce(
      (sum, store) => cursorStoreIds.has(String(store.store_id)) ? sum : sum + store.eligible_items,
      0
    )
    : legacyQueue.unscheduled_items;

  return {
    ...listingTotals,
    ...(liveQueue ?? legacyQueue),
    attempts_24h: attemptTotals.attempts,
    daily_capacity: Math.floor(dailyCapacity),
    failures_24h: attemptTotals.failures,
    fresh_percent: eligibleItems > 0 ? listingTotals.fresh_items / eligibleItems * 100 : 100,
    projected_daily_demand: eligibleItems,
    projected_utilization_percent: (eligibleItems / dailyCapacity) * 100,
    rate_limited_24h: attemptTotals.rate_limited,
    schedule_utilization_percent: windowCapacity > 0 ? (eligibleItems / windowCapacity) * 100 : 0,
    schedule_window_capacity: windowCapacity,
    schedule_window_hours: windowHours,
    success_rate_percent: completed > 0 ? attemptTotals.successes / completed * 100 : 100,
    successes_24h: attemptTotals.successes,
    unscheduled_items: unscheduledItems
  };
}

function readQueueTotals(row: Row): QueueTotals {
  return {
    due_items: numberField(row, 'due_items'),
    next_due_at: (row.next_due_at as Date | string | undefined) ?? null,
    oldest_due_hours: numberField(row, 'oldest_due_hours'),
    scheduled_items: numberField(row, 'scheduled_items'),
    scheduled_later_items: numberField(row, 'scheduled_later_items')
  };
}

function publicScheduleRun(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value ?? null;
  }
  const row = value as Record<string, unknown>;
  if (row.trigger === 'STORE_MANUAL') {
    return { ...row, trigger: 'MANUAL', automatic_schedule_date: null };
  }
  return row.trigger === 'STORE_AUTOMATIC' ? { ...row, trigger: 'AUTOMATIC' } : row;
}

function workerHealth(worker: Row, pollSeconds: number): 'healthy' | 'stale' | 'stopped' {
  if (worker.status === 'stopped') {
    return 'stopped';
  }
  if (worker.status === 'error') {
    return 'stale';
  }
  const heartbeatAt = new Date(String(worker.heartbeat_at ?? '')).getTime();
  const maximumAgeMs = Math.max(30, pollSeconds * 3) * 1_000;
  return Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= maximumAgeMs ? 'healthy' : 'stale';
}

function numberField(value: Row, key: string): number {
  const field = value[key];
  if (field === '' || field === null || field === undefined) {
    return 0;
  }

  const parsed = typeof field === 'number' ? field : Number(field);
  return Number.isFinite(parsed) ? parsed : 0;
}
