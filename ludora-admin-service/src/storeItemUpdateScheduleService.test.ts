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

type QueuedResponse = unknown[] | Error;

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
        const response = this.responses.shift();
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
  it('spreads shuffled items evenly per store inside one 20-hour window', async () => {
    const database = new FakeSessionDatabase([
      [{ acquired: true }],
      [runningRun({ id: '41' })],
      [],
      [{ scheduled_item_count: '12', scheduled_store_count: '3' }],
      [completedRun({ id: '41', scheduled_item_count: '12', scheduled_store_count: '3' })],
      [],
      [{ pg_advisory_unlock: true }]
    ]);
    const service = createStoreItemUpdateScheduleService(database, { advisoryLockKey: 7842 });

    const result = await service.runManual(new Date('2026-08-05T15:00:00.000Z'));

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
    expect(distributionSql).toContain('row_number() over ( partition by store_items.store_id order by random() )');
    expect(distributionSql).toContain('count(*) over (partition by store_items.store_id)');
    expect(distributionSql).toContain('(eligible.random_rank + store_phases.phase)');
    expect(distributionSql).toContain('stores.active = true');
    expect(distributionSql).toContain('store_items.store_active = true');
    expect(distributionSql).toContain('store_items.is_boardgame = true');
    expect(distributionSql).toContain('store_items.is_boardgame_confirmed = true');
    expect(distributionSql).toContain('store_items.item_id is not null');
    expect(distributionSql).toContain("store_items.source_url <> ''");
    expect(distributionSql).toContain("store_items.listing_status = 'listed'");
    expect(distributionSql).toContain('store_items.update_lease_token is null');
    expect(distributionSql).toContain('store_items.update_lease_expires_at <= now()');
    expect(distributionSql).not.toContain('platform_cooldown');
    expect(distributionSql).not.toContain('failure_count');
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
    const service = createStoreItemUpdateScheduleService(database);

    const run = await service.runAutomatic(new Date('2026-08-05T09:01:00.000Z'), '2026-08-05');

    expect(run.status).toBe('COMPLETED');
    expect(run.id).toBe(52);
    expect(run.scheduled_item_count).toBe(27);
    expect(run.automatic_schedule_date).toBe('2026-08-05');
    const distributionQueries = database.queries.filter((query) =>
      normalizeSql(query.sql).startsWith('with eligible as materialized')
    );
    expect(distributionQueries).toHaveLength(0);
    expect(normalizeSql(database.queries.at(-1)?.sql ?? '')).toBe('select pg_advisory_unlock($1)');
  });

  it('throws a conflict when the schedule advisory lock is busy', async () => {
    const database = new FakeSessionDatabase([[{ acquired: false }], [{ pg_advisory_unlock: false }]]);
    const service = createStoreItemUpdateScheduleService(database, { advisoryLockKey: 9988 });

    await expect(service.runManual(new Date('2026-08-05T15:00:00.000Z'))).rejects.toBeInstanceOf(
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
    const service = createStoreItemUpdateScheduleService(database);

    await expect(service.runManual(new Date('2026-08-05T15:00:00.000Z'))).rejects.toThrow('distribution failed');

    const commands = database.queries.map((query) => normalizeSql(query.sql));
    expect(commands).toContain('rollback');
    const failureQuery = database.queries.find((query) => {
      const sql = normalizeSql(query.sql);
      return sql.startsWith('update store_item_update_schedule_runs') && sql.includes("status = 'failed'");
    });
    expect(String(failureQuery?.params?.[0])).toHaveLength(2000);
    expect(failureQuery?.params?.[1]).toBe(63);
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
    const service = createStoreItemUpdateScheduleService(database);

    await expect(service.runManual(new Date('2026-08-05T15:00:00.000Z'))).rejects.toThrow(error);

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
    const service = createStoreItemUpdateScheduleService(database);

    await expect(service.runManual(new Date('2026-08-05T15:00:00.000Z'))).rejects.toThrow('distribution failed');

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
    const service = createStoreItemUpdateScheduleService(database);

    await expect(service.runManual(new Date('2026-08-05T15:00:00.000Z'))).rejects.toThrow('distribution failed');

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
    const service = createStoreItemUpdateScheduleService(database);

    await expect(service.runManual(new Date('2026-08-05T15:00:00.000Z'))).resolves.toMatchObject({
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
      const service = createStoreItemUpdateScheduleService(database);

      const run = await service.runAutomatic(new Date('2026-08-05T09:01:00.000Z'), '2026-08-05');

      expect(run.id).toBe(74);
      expect(run.status).toBe('COMPLETED');
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
});

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
