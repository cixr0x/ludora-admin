import { describe, expect, it, vi } from 'vitest';
import { createDiscoveryBrowserFailureRecorder } from './discoveryBrowserFailure.js';
import type { Database } from './db.js';

describe('discovery browser failure persistence', () => {
  const failure = { runId: 'batch:17', storeId: 17, url: 'https://example.com/game/', phase: 'fetch',
    timeoutSeconds: 120, reason: 'timeout' as const, error: 'browser timeout' };
  it('updates only the exact running job and inserts a timeout trace atomically without changing statistics', async () => {
    const statements: Array<{ sql: string; params?: unknown[] }> = [];
    const database = {
      query: vi.fn(),
      withSession: async (callback: (session: Database) => Promise<void>) => callback({ query: async (sql, params) => {
        statements.push({ sql, params }); return { rows: [] };
      } })
    };
    await createDiscoveryBrowserFailureRecorder(database)(failure);
    const mutation = statements.find(({ sql }) => sql.includes('update job_store_item_discovery_log'))!;
    expect(mutation.sql).toMatch(/where run_id = \$1 and store_id = \$2 and status = 'running'/);
    expect(mutation.sql).toMatch(/insert into store_item_discovery_trace_log/);
    expect(mutation.sql).toMatch(/from failed_job/);
    expect(mutation.sql).not.toMatch(/(?:new_items|items_discovered|confirmed_boardgames)\s*=/);
    expect(mutation.params?.slice(0, 5)).toEqual(['batch:17', 17, 'failed', 'browser timeout', 'item_discovery.browser.timeout']);
    expect(JSON.parse(String(mutation.params?.[5]))).toMatchObject({ timeout_seconds: 120, url: failure.url, store_id: 17 });
    expect(statements[0].sql).toBe('begin');
    expect(statements.at(-1)?.sql).toBe('commit');
    expect(statements.some(({ sql }) => sql.includes('statement_timeout'))).toBe(true);
  });

  it('rolls back and reports a failed terminal-state write', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('update job_store_item_discovery_log')) throw new Error('write failed');
      return { rows: [] };
    });
    const record = createDiscoveryBrowserFailureRecorder({ query, withSession: async (fn) => fn({ query }) });
    await expect(record(failure)).rejects.toThrow('write failed');
    expect(query.mock.calls.at(-1)?.[0]).toBe('rollback');
  });

  it('records forced cancellation with cancelled status', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const record = createDiscoveryBrowserFailureRecorder({ query, withSession: async (fn) => fn({ query }) });
    await record({ ...failure, reason: 'cancelled' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('update job_store_item_discovery_log'), expect.arrayContaining(['cancelled', 'item_discovery.browser.cancelled']));
  });
});
