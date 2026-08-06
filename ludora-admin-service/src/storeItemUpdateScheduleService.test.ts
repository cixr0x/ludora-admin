import { describe, expect, it } from 'vitest';

import type { Database, QueryResult, SessionDatabase } from './db.js';
import {
  createStoreItemUpdateScheduleService,
  StoreItemUpdateScheduleConflictError
} from './storeItemUpdateScheduleService.js';

type RecordedQuery = {
  sql: string;
  params?: unknown[];
};

type QueuedResponse = unknown[] | Error | (() => unknown[] | Error);

class FakeSessionDatabase implements SessionDatabase {
  readonly queries: RecordedQuery[] = [];
  closeCalls = 0;
  sessionCount = 0;

  constructor(private readonly responses: QueuedResponse[]) {}

  async query(): Promise<QueryResult> {
    throw new Error('schedule queries must use a dedicated session');
  }

  async withSession<T>(operation: (session: Database) => Promise<T>): Promise<T> {
    this.sessionCount += 1;
    return operation({
      close: async () => {
        this.closeCalls += 1;
      },
      query: async (sql, params) => {
        this.queries.push({ sql, params });
        const queuedResponse = this.responses.shift();
        const response = typeof queuedResponse === 'function' ? queuedResponse() : queuedResponse;
        if (response === undefined) {
          throw new Error(`Unexpected query: ${normalizeSql(sql)}`);
        }
        if (response instanceof Error) {
          throw response;
        }
        return { rows: response };
      }
    });
  }
}

describe('store item update schedule service', () => {
  it('spreads deterministically ranked items evenly per store inside one 20-hour window', async () => {
    const database = new FakeSessionDatabase([
      [{ acquired: true }],
      [runningRun({ id: '41' })],
      [],
      [{ scheduled_item_count: '12', scheduled_store_count: '3' }],
      [completedRun({ id: '41', scheduled_item_count: '12', scheduled_store_count: '3' })],
      [],
      [{ pg_advisory_unlock: true }]
    ]);
    const service = createScheduleService(database, { advisoryLockKey: 7842 });

    const result = await service.runManual();

    expect(result.window_start).toBe('2026-08-05T15:00:00.000Z');
    expect(result.window_end).toBe('2026-08-06T11:00:00.000Z');
    expect(result.id).toBe(41);
    expect(result.scheduled_item_count).toBe(12);
    expect(result.scheduled_store_count).toBe(3);
    expect(result.started_at).toBe('2026-08-05T15:00:00.000Z');
    expect(result.completed_at).toBe('2026-08-05T15:00:01.000Z');
    expect(database.sessionCount).toBe(1);

    const distribution = database.queries.find((query) =>
      normalizeSql(query.sql).startsWith('with eligible as materialized')
    );
    const distributionSql = normalizeSql(distribution?.sql ?? '');
    expect(distribution?.params).toEqual([
      new Date('2026-08-05T15:00:00.000Z'),
      new Date('2026-08-06T11:00:00.000Z')
    ]);
    expect(distributionSql).toContain(
      'row_number() over ( partition by store_items.store_id order by store_items.id )'
    );
    expect(distributionSql).not.toContain(
      'partition by store_items.store_id order by random()'
    );
    expect(distributionSql).toContain('count(*) over (partition by store_items.store_id)');
    expect(distributionSql).toContain('select store_id, random() as phase');
    expect(distributionSql).toContain('(ranked.schedule_rank + store_phases.phase)');
    expect(distributionSql).toContain('stores.active = true');
    expect(distributionSql).toContain('store_items.store_active = true');
    expect(distributionSql).toContain('store_items.is_boardgame = true');
    expect(distributionSql).toContain('store_items.is_boardgame_confirmed = true');
    expect(distributionSql).toContain('store_items.item_id is not null');
    expect(distributionSql).toContain("store_items.source_url <> ''");
    expect(distributionSql).toContain("store_items.listing_status = 'listed'");
    expect(distributionSql).toContain('store_items.update_lease_token is null');
    expect(distributionSql).toContain('store_items.update_lease_expires_at <= now()');
    expect(distributionSql).toContain('order by store_items.id');
    expect(distributionSql).toContain('for update of store_items skip locked');
    expect(distributionSql).toContain('store_items.last_update_attempt_at < $1::timestamptz');
    expect(distributionSql).not.toContain('platform_cooldown');
    expect(distributionSql).not.toContain('failure_count');
    const completionSql = normalizeSql(database.queries.find((query) =>
      normalizeSql(query.sql).includes("set status = 'completed'")
    )?.sql ?? '');
    expect(completionSql).toContain('completed_at = clock_timestamp()');
    expect(database.queries.map((query) => normalizeSql(query.sql))).toEqual([
      'select pg_try_advisory_lock($1) as acquired',
      expect.stringMatching(/^insert into store_item_update_schedule_runs/),
      'begin',
      expect.stringMatching(/^with eligible as materialized/),
      expect.stringMatching(/^update store_item_update_schedule_runs/),
      'commit',
      'select pg_advisory_unlock($1)'
    ]);
  });

  it('returns the completed automatic run without redistributing twice', async () => {
    const database = new FakeSessionDatabase([
      [{ acquired: true }],
      [
        completedRun({
          id: '52',
          trigger: 'AUTOMATIC',
          automatic_schedule_date: '2026-08-05',
          scheduled_item_count: '27',
          scheduled_store_count: '4'
        })
      ],
      [{ pg_advisory_unlock: true }]
    ]);
    const service = createScheduleService(database, { now: () => new Date('2026-08-05T09:01:00.000Z') });

    const run = await service.runAutomatic();

    expect(run?.status).toBe('COMPLETED');
    expect(run?.id).toBe(52);
    expect(run?.scheduled_item_count).toBe(27);
    expect(run?.automatic_schedule_date).toBe('2026-08-05');
    const distributionQueries = database.queries.filter((query) =>
      normalizeSql(query.sql).startsWith('with eligible as materialized')
    );
    expect(distributionQueries).toHaveLength(0);
    expect(normalizeSql(database.queries.at(-1)?.sql ?? '')).toBe('select pg_advisory_unlock($1)');
  });

  it('throws a conflict when the schedule advisory lock is busy', async () => {
    const database = new FakeSessionDatabase([[{ acquired: false }], [{ pg_advisory_unlock: false }]]);
    const service = createScheduleService(database, { advisoryLockKey: 9988 });

    await expect(service.runManual()).rejects.toBeInstanceOf(
      StoreItemUpdateScheduleConflictError
    );

    expect(database.queries.map((query) => normalizeSql(query.sql))).toEqual([
      'select pg_try_advisory_lock($1) as acquired',
      'select pg_advisory_unlock($1)'
    ]);
    expect(database.queries.every((query) => query.params?.[0] === 9988)).toBe(true);
  });

  it('rolls back schedule changes and records a bounded failure', async () => {
    const distributionError = new Error(`distribution failed ${'x'.repeat(2100)}`);
    const database = new FakeSessionDatabase([
      [{ acquired: true }],
      [runningRun({ id: '63' })],
      [],
      distributionError,
      [],
      [failedRun({ id: '63' })],
      [{ pg_advisory_unlock: true }]
    ]);
    const service = createScheduleService(database);

    await expect(service.runManual()).rejects.toThrow('distribution failed');

    const commands = database.queries.map((query) => normalizeSql(query.sql));
    expect(commands).toContain('rollback');
    const failureQuery = database.queries.find((query) => {
      const sql = normalizeSql(query.sql);
      return sql.startsWith('update store_item_update_schedule_runs') && sql.includes("status = 'failed'");
    });
    expect(String(failureQuery?.params?.[0])).toHaveLength(2000);
    expect(failureQuery?.params?.[1]).toBe(63);
    expect(normalizeSql(failureQuery?.sql ?? '')).toContain('completed_at = clock_timestamp()');
    expect(commands.at(-1)).toBe('select pg_advisory_unlock($1)');
  });

  it.each([
    ['missing', [], 'Schedule query returned no row', 'Error: Schedule query returned no row'],
    [
      'malformed',
      [completedRun({ window_end: 'not-a-timestamp' })],
      'Invalid time value',
      'RangeError: Invalid time value'
    ]
  ])('validates a %s completed row before committing the distribution', async (_case, completedRows, error, detail) => {
    const database = new FakeSessionDatabase([
      [{ acquired: true }],
      [runningRun({ id: '64' })],
      [],
      [{ scheduled_item_count: '12', scheduled_store_count: '3' }],
      completedRows,
      [],
      [failedRun({ id: '64' })],
      [{ pg_advisory_unlock: true }]
    ]);
    const service = createScheduleService(database);

    await expect(service.runManual()).rejects.toThrow(error);

    const commands = database.queries.map((query) => normalizeSql(query.sql));
    expect(commands).not.toContain('commit');
    expect(commands).toContain('rollback');
    const failureQuery = database.queries.find((query) => {
      const sql = normalizeSql(query.sql);
      return sql.startsWith('update store_item_update_schedule_runs') && sql.includes("status = 'failed'");
    });
    expect(failureQuery?.params?.[0]).toBe(detail);
  });

  it('preserves the distribution error when rollback cleanup fails', async () => {
    const database = new FakeSessionDatabase([
      [{ acquired: true }],
      [runningRun({ id: '65' })],
      [],
      new Error('distribution failed'),
      new Error('rollback cleanup failed'),
      [{ pg_advisory_unlock: true }]
    ]);
    const service = createScheduleService(database);

    await expect(service.runManual()).rejects.toThrow('distribution failed');

    expect(database.closeCalls).toBe(1);
    expect(normalizeSql(database.queries.at(-1)?.sql ?? '')).toBe('select pg_advisory_unlock($1)');
  });

  it('preserves the distribution error when durable failure recording fails', async () => {
    const database = new FakeSessionDatabase([
      [{ acquired: true }],
      [runningRun({ id: '66' })],
      [],
      new Error('distribution failed'),
      [],
      new Error('failure recording failed'),
      [{ pg_advisory_unlock: true }]
    ]);
    const service = createScheduleService(database);

    await expect(service.runManual()).rejects.toThrow('distribution failed');

    expect(database.closeCalls).toBe(1);
    expect(normalizeSql(database.queries.at(-1)?.sql ?? '')).toBe('select pg_advisory_unlock($1)');
  });

  it('returns the completed run and discards the session when advisory unlock fails', async () => {
    const database = new FakeSessionDatabase([
      [{ acquired: true }],
      [runningRun({ id: '67' })],
      [],
      [{ scheduled_item_count: '12', scheduled_store_count: '3' }],
      [completedRun({ id: '67', scheduled_item_count: '12', scheduled_store_count: '3' })],
      [],
      new Error('unlock failed')
    ]);
    const service = createScheduleService(database);

    await expect(service.runManual()).resolves.toMatchObject({
      id: 67,
      status: 'COMPLETED'
    });

    expect(database.closeCalls).toBe(1);
  });

  it.each(['FAILED', 'RUNNING'] as const)(
    'resets and reuses an existing automatic %s run',
    async (existingStatus) => {
      const database = new FakeSessionDatabase([
        [{ acquired: true }],
        [],
        [
          runningRun({
            id: '74',
            trigger: 'AUTOMATIC',
            automatic_schedule_date: '2026-08-05',
            status: existingStatus
          })
        ],
        [],
        [{ scheduled_item_count: '8', scheduled_store_count: '2' }],
        [
          completedRun({
            id: '74',
            trigger: 'AUTOMATIC',
            automatic_schedule_date: '2026-08-05',
            scheduled_item_count: '8',
            scheduled_store_count: '2'
          })
        ],
        [],
        [{ pg_advisory_unlock: true }]
      ]);
      const service = createScheduleService(database, { now: () => new Date('2026-08-05T09:01:00.000Z') });

      const run = await service.runAutomatic();

      expect(run?.id).toBe(74);
      expect(run?.status).toBe('COMPLETED');
      const resetQuery = database.queries.find((query) =>
        normalizeSql(query.sql).startsWith('insert into store_item_update_schedule_runs')
      );
      expect(normalizeSql(resetQuery?.sql ?? '')).toContain(
        "on conflict (automatic_schedule_date) where trigger = 'automatic' do update"
      );
      expect(normalizeSql(resetQuery?.sql ?? '')).toContain("status = 'running'");
      expect(resetQuery?.params?.[0]).toBe('2026-08-05');
    }
  );

  it('samples the execution clock only after the advisory lock is acquired', async () => {
    let currentTime = new Date('2026-08-05T15:00:00.000Z');
    const delayedTime = new Date('2026-08-05T16:30:00.250Z');
    const database = new FakeSessionDatabase([
      () => {
        currentTime = delayedTime;
        return [{ acquired: true }];
      },
      [runningRun({
        id: '81',
        started_at: delayedTime,
        window_start: delayedTime,
        window_end: '2026-08-06T12:30:00.250Z'
      })],
      [],
      [{ scheduled_item_count: '2', scheduled_store_count: '1' }],
      [completedRun({
        id: '81',
        started_at: delayedTime,
        window_start: delayedTime,
        window_end: '2026-08-06T12:30:00.250Z'
      })],
      [],
      [{ pg_advisory_unlock: true }]
    ]);
    const service = createScheduleService(database, { now: () => currentTime });

    const result = await service.runManual();

    expect(result.window_start).toBe('2026-08-05T16:30:00.250Z');
    expect(database.queries.find((query) =>
      normalizeSql(query.sql).startsWith('insert into store_item_update_schedule_runs')
    )?.params).toEqual([
      delayedTime,
      new Date('2026-08-06T12:30:00.250Z')
    ]);
  });

  it('uses the Mexico City execution date after a delayed automatic lock crosses into the next schedule day', async () => {
    let currentTime = new Date('2026-08-06T05:59:00.000Z');
    const executionTime = new Date('2026-08-06T09:01:00.125Z');
    const database = new FakeSessionDatabase([
      () => {
        currentTime = executionTime;
        return [{ acquired: true }];
      },
      [],
      [runningRun({
        id: '82',
        trigger: 'AUTOMATIC',
        automatic_schedule_date: '2026-08-06',
        started_at: executionTime,
        window_start: executionTime,
        window_end: '2026-08-07T05:01:00.125Z'
      })],
      [],
      [{ scheduled_item_count: '2', scheduled_store_count: '1' }],
      [completedRun({
        id: '82',
        trigger: 'AUTOMATIC',
        automatic_schedule_date: '2026-08-06',
        started_at: executionTime,
        window_start: executionTime,
        window_end: '2026-08-07T05:01:00.125Z'
      })],
      [],
      [{ pg_advisory_unlock: true }]
    ]);
    const service = createScheduleService(database, { now: () => currentTime });

    const result = await service.runAutomatic();

    expect(result?.automatic_schedule_date).toBe('2026-08-06');
    expect(result?.window_start).toBe('2026-08-06T09:01:00.125Z');
    const automaticRunQuery = database.queries.find((query) =>
      normalizeSql(query.sql).startsWith('insert into store_item_update_schedule_runs')
    );
    expect(automaticRunQuery?.params?.[0]).toBe('2026-08-06');
  });

  it('does not start the next automatic schedule before 3am after a midnight rollover', async () => {
    const database = new FakeSessionDatabase([
      [{ acquired: true }],
      [{ pg_advisory_unlock: true }]
    ]);
    const service = createScheduleService(database, { now: () => new Date('2026-08-06T06:01:00.000Z') });

    await expect(service.runAutomatic()).resolves.toBeNull();

    expect(database.queries.some((query) =>
      normalizeSql(query.sql).includes('insert into store_item_update_schedule_runs')
    )).toBe(false);
  });

  it('normalizes native pg Date values without losing date-only or timestamp precision', async () => {
    const automaticDate = new Date(2026, 7, 5);
    const database = new FakeSessionDatabase([
      [{ acquired: true }],
      [completedRun({
        automatic_schedule_date: automaticDate,
        completed_at: new Date('2026-08-05T15:00:01.789Z'),
        started_at: new Date('2026-08-05T15:00:00.123Z'),
        trigger: 'AUTOMATIC',
        window_end: new Date('2026-08-06T11:00:00.456Z'),
        window_start: new Date('2026-08-05T15:00:00.123Z')
      })],
      [{ pg_advisory_unlock: true }]
    ]);
    const service = createScheduleService(database, { now: () => new Date('2026-08-05T15:00:00.000Z') });

    const result = await service.runAutomatic();

    expect(result).toMatchObject({
      automatic_schedule_date: '2026-08-05',
      completed_at: '2026-08-05T15:00:01.789Z',
      started_at: '2026-08-05T15:00:00.123Z',
      window_end: '2026-08-06T11:00:00.456Z',
      window_start: '2026-08-05T15:00:00.123Z'
    });
  });
});

function createScheduleService(
  database: SessionDatabase,
  options: { advisoryLockKey?: number; now?: () => Date; windowHours?: number } = {}
) {
  return createStoreItemUpdateScheduleService(database, {
    now: options.now ?? (() => new Date('2026-08-05T15:00:00.000Z')),
    ...options
  });
}

function runningRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    trigger: 'MANUAL',
    automatic_schedule_date: null,
    status: 'RUNNING',
    window_start: new Date('2026-08-05T15:00:00.000Z'),
    window_end: '2026-08-06T11:00:00.000Z',
    scheduled_item_count: 0,
    scheduled_store_count: 0,
    started_at: '2026-08-05T15:00:00.000Z',
    completed_at: null,
    error_detail: '',
    ...overrides
  };
}

function completedRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...runningRun(),
    status: 'COMPLETED',
    completed_at: new Date('2026-08-05T15:00:01.000Z'),
    ...overrides
  };
}

function failedRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...runningRun(),
    status: 'FAILED',
    error_detail: 'distribution failed',
    ...overrides
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
