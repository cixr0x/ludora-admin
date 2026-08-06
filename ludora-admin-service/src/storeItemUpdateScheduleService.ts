import type { Database, QueryResult, SessionDatabase } from './db.js';

export type StoreItemUpdateScheduleTrigger = 'AUTOMATIC' | 'MANUAL';
export type StoreItemUpdateScheduleStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export type StoreItemUpdateScheduleRun = {
  id: number;
  trigger: StoreItemUpdateScheduleTrigger;
  automatic_schedule_date: string | null;
  status: StoreItemUpdateScheduleStatus;
  window_start: string;
  window_end: string;
  scheduled_item_count: number;
  scheduled_store_count: number;
  started_at: string;
  completed_at: string | null;
  error_detail: string;
};

export class StoreItemUpdateScheduleConflictError extends Error {
  constructor() {
    super('A store item update schedule run is already in progress');
    this.name = 'StoreItemUpdateScheduleConflictError';
  }
}

export type StoreItemUpdateScheduleService = {
  runAutomatic(): Promise<StoreItemUpdateScheduleRun | null>;
  runManual(): Promise<StoreItemUpdateScheduleRun>;
};

const DEFAULT_ADVISORY_LOCK_KEY = 20_260_805;
const DEFAULT_WINDOW_HOURS = 20;
const SCHEDULE_START_HOUR = 3;
const SCHEDULE_TIME_ZONE = 'America/Mexico_City';

const mexicoCityTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHEDULE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23'
});

const RUN_COLUMNS = `
  id,
  trigger,
  automatic_schedule_date,
  status,
  window_start,
  window_end,
  scheduled_item_count,
  scheduled_store_count,
  started_at,
  completed_at,
  error_detail
`;

const DISTRIBUTE_STORE_ITEMS_SQL = `
with eligible as materialized (
  select
    store_items.id,
    store_items.store_id
  from store_items
  join stores on stores.id = store_items.store_id
  where stores.active = true
    and store_items.store_active = true
    and store_items.is_boardgame = true
    and store_items.is_boardgame_confirmed = true
    and store_items.item_id is not null
    and store_items.source_url <> ''
    and store_items.listing_status = 'LISTED'
    and (
      store_items.update_lease_token is null
      or store_items.update_lease_expires_at <= now()
    )
    and (
      store_items.last_update_attempt_at is null
      or store_items.last_update_attempt_at < $1::timestamptz
    )
  order by store_items.id
  for update of store_items skip locked
), ranked as materialized (
  select
    store_items.id,
    store_items.store_id,
    row_number() over (
      partition by store_items.store_id order by store_items.id
    ) - 1 as schedule_rank,
    count(*) over (partition by store_items.store_id) as store_item_count
  from store_items
  join eligible on eligible.id = store_items.id
), store_phases as materialized (
  select store_id, random() as phase
  from ranked
  group by store_id
), scheduled as (
  update store_items
  set next_update_at = $1::timestamptz
    + (($2::timestamptz - $1::timestamptz)
      * ((ranked.schedule_rank + store_phases.phase) / ranked.store_item_count))
  from ranked
  join store_phases on store_phases.store_id = ranked.store_id
  where store_items.id = ranked.id
  returning store_items.id, store_items.store_id
)
select count(*)::int as scheduled_item_count,
       count(distinct store_id)::int as scheduled_store_count
from scheduled
`;

export function createStoreItemUpdateScheduleService(
  database: SessionDatabase,
  options: { advisoryLockKey?: number; now?: () => Date; windowHours?: number } = {}
): StoreItemUpdateScheduleService {
  const advisoryLockKey = options.advisoryLockKey ?? DEFAULT_ADVISORY_LOCK_KEY;
  const now = options.now ?? (() => new Date());
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;

  const run = async (
    trigger: StoreItemUpdateScheduleTrigger
  ): Promise<StoreItemUpdateScheduleRun | null> =>
    database.withSession(async (session) => {
      try {
        const lockResult = await session.query('select pg_try_advisory_lock($1) as acquired', [advisoryLockKey]);
        if (!Boolean(asRecord(lockResult.rows[0]).acquired)) {
          throw new StoreItemUpdateScheduleConflictError();
        }

        const executionTime = now();
        const automaticScheduleDate = trigger === 'AUTOMATIC'
          ? mexicoCityScheduleDate(executionTime)
          : null;
        if (trigger === 'AUTOMATIC' && automaticScheduleDate === null) {
          return null;
        }

        if (trigger === 'AUTOMATIC') {
          const existingCompleted = await session.query(
            `select ${RUN_COLUMNS}
             from store_item_update_schedule_runs
             where trigger = 'AUTOMATIC'
               and automatic_schedule_date = $1::date
               and status = 'COMPLETED'`,
            [automaticScheduleDate]
          );
          if (existingCompleted.rows.length > 0) {
            return normalizeRun(existingCompleted.rows[0]);
          }
        }

        const windowStart = new Date(executionTime);
        const windowEnd = new Date(windowStart.getTime() + windowHours * 60 * 60 * 1000);
        const runningRun = await createRunningRun(
          session,
          trigger,
          automaticScheduleDate,
          windowStart,
          windowEnd
        );

        try {
          await session.query('begin');
          const distribution = await session.query(DISTRIBUTE_STORE_ITEMS_SQL, [windowStart, windowEnd]);
          const counts = asRecord(distribution.rows[0]);
          const completed = await session.query(
            `update store_item_update_schedule_runs
             set status = 'COMPLETED',
                 scheduled_item_count = $1,
                 scheduled_store_count = $2,
                 completed_at = clock_timestamp(),
                 error_detail = ''
             where id = $3
             returning ${RUN_COLUMNS}`,
            [Number(counts.scheduled_item_count), Number(counts.scheduled_store_count), runningRun.id]
          );
          const completedRun = normalizeRun(firstRow(completed));
          await session.query('commit');
          return completedRun;
        } catch (error) {
          await recordFailureWithoutMasking(session, runningRun.id, error);
          throw error;
        }
      } finally {
        await unlockWithoutMasking(session, advisoryLockKey);
      }
    });

  return {
    runAutomatic: () => run('AUTOMATIC'),
    runManual: async () => {
      const result = await run('MANUAL');
      if (result === null) {
        throw new Error('Manual schedule unexpectedly returned no run');
      }
      return result;
    }
  };
}

async function recordFailureWithoutMasking(session: Database, runId: number, error: unknown): Promise<void> {
  try {
    await session.query('rollback');
  } catch {
    await discardWithoutMasking(session);
    return;
  }

  try {
    await session.query(
      `update store_item_update_schedule_runs
       set status = 'FAILED',
           completed_at = clock_timestamp(),
           error_detail = $1
       where id = $2
       returning ${RUN_COLUMNS}`,
      [String(error).slice(0, 2000), runId]
    );
  } catch {
    await discardWithoutMasking(session);
  }
}

async function unlockWithoutMasking(session: Database, advisoryLockKey: number): Promise<void> {
  try {
    await session.query('select pg_advisory_unlock($1)', [advisoryLockKey]);
  } catch {
    await discardWithoutMasking(session);
  }
}

async function discardWithoutMasking(session: Database): Promise<void> {
  try {
    await session.close?.();
  } catch {
    // Preserve the schedule operation's primary result or error.
  }
}

async function createRunningRun(
  session: Database,
  trigger: StoreItemUpdateScheduleTrigger,
  automaticScheduleDate: string | null,
  windowStart: Date,
  windowEnd: Date
): Promise<StoreItemUpdateScheduleRun> {
  let result: QueryResult;
  if (trigger === 'AUTOMATIC') {
    result = await session.query(
      `insert into store_item_update_schedule_runs (
         trigger,
         automatic_schedule_date,
         status,
         window_start,
         window_end,
         started_at
       ) values ('AUTOMATIC', $1::date, 'RUNNING', $2, $3, $2)
       on conflict (automatic_schedule_date) where trigger = 'AUTOMATIC' do update
       set status = 'RUNNING',
           window_start = excluded.window_start,
           window_end = excluded.window_end,
           scheduled_item_count = 0,
           scheduled_store_count = 0,
           started_at = excluded.started_at,
           completed_at = null,
           error_detail = ''
       returning ${RUN_COLUMNS}`,
      [automaticScheduleDate, windowStart, windowEnd]
    );
  } else {
    result = await session.query(
      `insert into store_item_update_schedule_runs (
         trigger,
         status,
         window_start,
         window_end,
         started_at
       ) values ('MANUAL', 'RUNNING', $1, $2, $1)
       returning ${RUN_COLUMNS}`,
      [windowStart, windowEnd]
    );
  }
  return normalizeRun(firstRow(result));
}

function normalizeRun(value: unknown): StoreItemUpdateScheduleRun {
  const row = asRecord(value);
  return {
    id: Number(row.id),
    trigger: row.trigger as StoreItemUpdateScheduleTrigger,
    automatic_schedule_date: row.automatic_schedule_date === null
      ? null
      : normalizeDateOnly(row.automatic_schedule_date),
    status: row.status as StoreItemUpdateScheduleStatus,
    window_start: normalizeTimestamp(row.window_start),
    window_end: normalizeTimestamp(row.window_end),
    scheduled_item_count: Number(row.scheduled_item_count),
    scheduled_store_count: Number(row.scheduled_store_count),
    started_at: normalizeTimestamp(row.started_at),
    completed_at: row.completed_at === null ? null : normalizeTimestamp(row.completed_at),
    error_detail: String(row.error_detail)
  };
}

export function mexicoCityScheduleDate(now: Date): string | null {
  const parts = Object.fromEntries(
    mexicoCityTimeFormatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  if (Number(parts.hour) < SCHEDULE_START_HOUR) {
    return null;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeDateOnly(value: unknown): string {
  if (value instanceof Date) {
    return [
      value.getFullYear().toString().padStart(4, '0'),
      (value.getMonth() + 1).toString().padStart(2, '0'),
      value.getDate().toString().padStart(2, '0')
    ].join('-');
  }
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.exec(text)?.[0] ?? text;
}

function normalizeTimestamp(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function firstRow(result: QueryResult): unknown {
  if (result.rows.length === 0) {
    throw new Error('Schedule query returned no row');
  }
  return result.rows[0];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Schedule query returned an invalid row');
  }
  return value as Record<string, unknown>;
}
