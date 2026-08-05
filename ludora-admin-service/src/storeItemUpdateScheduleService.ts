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
  runAutomatic(now: Date, localDate: string): Promise<StoreItemUpdateScheduleRun>;
  runManual(now: Date): Promise<StoreItemUpdateScheduleRun>;
};

const DEFAULT_ADVISORY_LOCK_KEY = 20_260_805;
const DEFAULT_WINDOW_HOURS = 20;

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
    store_items.store_id,
    row_number() over (
      partition by store_items.store_id order by random()
    ) - 1 as random_rank,
    count(*) over (partition by store_items.store_id) as store_item_count
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
), store_phases as materialized (
  select store_id, random() as phase
  from eligible
  group by store_id
), scheduled as (
  update store_items
  set next_update_at = $1::timestamptz
    + (($2::timestamptz - $1::timestamptz)
      * ((eligible.random_rank + store_phases.phase) / eligible.store_item_count))
  from eligible
  join store_phases on store_phases.store_id = eligible.store_id
  where store_items.id = eligible.id
  returning store_items.id, store_items.store_id
)
select count(*)::int as scheduled_item_count,
       count(distinct store_id)::int as scheduled_store_count
from scheduled
`;

export function createStoreItemUpdateScheduleService(
  database: SessionDatabase,
  options: { advisoryLockKey?: number; windowHours?: number } = {}
): StoreItemUpdateScheduleService {
  const advisoryLockKey = options.advisoryLockKey ?? DEFAULT_ADVISORY_LOCK_KEY;
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;

  const run = async (
    trigger: StoreItemUpdateScheduleTrigger,
    now: Date,
    automaticScheduleDate: string | null
  ): Promise<StoreItemUpdateScheduleRun> =>
    database.withSession(async (session) => {
      try {
        const lockResult = await session.query('select pg_try_advisory_lock($1) as acquired', [advisoryLockKey]);
        if (!Boolean(asRecord(lockResult.rows[0]).acquired)) {
          throw new StoreItemUpdateScheduleConflictError();
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

        const windowStart = new Date(now);
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
                 completed_at = now(),
                 error_detail = ''
             where id = $3
             returning ${RUN_COLUMNS}`,
            [Number(counts.scheduled_item_count), Number(counts.scheduled_store_count), runningRun.id]
          );
          await session.query('commit');
          return normalizeRun(firstRow(completed));
        } catch (error) {
          await session.query('rollback');
          await session.query(
            `update store_item_update_schedule_runs
             set status = 'FAILED',
                 completed_at = now(),
                 error_detail = $1
             where id = $2
             returning ${RUN_COLUMNS}`,
            [String(error).slice(0, 2000), runningRun.id]
          );
          throw error;
        }
      } finally {
        await session.query('select pg_advisory_unlock($1)', [advisoryLockKey]);
      }
    });

  return {
    runAutomatic: (now, localDate) => run('AUTOMATIC', now, localDate),
    runManual: (now) => run('MANUAL', now, null)
  };
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
    automatic_schedule_date: row.automatic_schedule_date === null ? null : String(row.automatic_schedule_date),
    status: row.status as StoreItemUpdateScheduleStatus,
    window_start: new Date(String(row.window_start)).toISOString(),
    window_end: new Date(String(row.window_end)).toISOString(),
    scheduled_item_count: Number(row.scheduled_item_count),
    scheduled_store_count: Number(row.scheduled_store_count),
    started_at: new Date(String(row.started_at)).toISOString(),
    completed_at: row.completed_at === null ? null : new Date(String(row.completed_at)).toISOString(),
    error_detail: String(row.error_detail)
  };
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
