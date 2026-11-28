import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryResult } from './db.js';
import { createStoreItemUpdateMonitor } from './storeItemUpdateMonitor.js';

describe('store item update monitor cache', () => {
  it('shares live reads and one cold refresh across filters, then projects a common snapshot', async () => {
    let finishListings!: (result: QueryResult) => void;
    const listings = new Promise<QueryResult>((resolve) => { finishListings = resolve; });
    let activeCursorStoreId = '12';
    const query = vi.fn<Database['query']>(async (sql) => {
      if (sql.includes('as staleness_hour')) return listings;
      if (sql.includes('group by attempts.store_id')) return { rows: [
        { store_id: 12, attempts: 3, successes: 1, failures: 1, rate_limited: 1, last_error: 'rate limited' },
        { store_id: 25, attempts: 1, successes: 1, failures: 0, rate_limited: 0 },
        { store_id: null, attempts: 1, successes: 0, failures: 1, rate_limited: 0 }
      ] };
      if (sql.includes('from store_item_update_store_schedules')) return { rows: [{
        active_store_ids: [activeCursorStoreId], scheduled_items: 6, due_items: 1, next_due_at: '2026-08-05T11:01:00Z'
      }] };
      return { rows: [] };
    });
    const read = createStoreItemUpdateMonitor({ query }, ['12'], true);
    const [cold, filteredCold] = await Promise.all([read(24, null, 'running'), read(48, 12, 'running')]);
    expect(cold).toMatchObject({
      control_status: 'running', summary: null, histogram: [], store_statistics: [],
      report: { status: 'loading', as_of: null, refreshing: true },
      live_queue: { scheduled_items: 6, due_items: 1, scheduled_later_items: 5, next_due_at: '2026-08-05T11:01:00Z' }
    });
    expect(filteredCold).toMatchObject({ range_hours: 48, histogram_store_id: 12 });
    expect(query.mock.calls.filter(([sql]) => sql.includes('from store_item_update_worker_state'))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql.includes('as staleness_hour'))).toHaveLength(1);

    finishListings({ rows: [
      { store_id: 12, store_name: 'One', staleness_hour: 0, eligible_items: 2, fresh_items: 2 },
      { store_id: 12, store_name: 'One', staleness_hour: 24, eligible_items: 1, fresh_items: 1 },
      { store_id: 16, store_name: 'Two', staleness_hour: 168, eligible_items: 2, stale_items: 2 },
      { store_id: 19, store_name: 'Three', staleness_hour: 0, eligible_items: 0 }
    ] });
    await new Promise((resolve) => setImmediate(resolve));
    const [allStores, filtered] = await Promise.all([read(24, null, 'running'), read(48, 12, 'paused')]);
    expect(allStores).toMatchObject({
      report: { status: 'fresh', as_of: expect.any(String), refreshing: false },
      summary: {
        eligible_items: 5, fresh_items: 3, stale_items: 2, attempts_24h: 5, successes_24h: 2,
        failures_24h: 2, rate_limited_24h: 1, success_rate_percent: 50, unscheduled_items: 2
      },
      store_statistics: [
        { store_id: 12, eligible_items: 3, attempts: 3, success_rate_percent: 50, last_error: 'rate limited' },
        { store_id: 16, eligible_items: 2, attempts: 0 },
        { store_id: 19, eligible_items: 0, attempts: 0 }
      ]
    });
    expect(allStores.histogram[24]).toEqual({ label: '24h+', item_count: 3, overflow: true, staleness_hour: 24 });
    expect(filtered).toMatchObject({ control_status: 'paused', report: allStores.report });
    expect(filtered.histogram[24]).toMatchObject({ item_count: 1, overflow: false });
    expect(filtered.histogram[48]).toMatchObject({ item_count: 0, overflow: true });
    const listingQueries = query.mock.calls.filter(([sql]) => sql.includes('as staleness_hour'));
    const attemptQueries = query.mock.calls.filter(([sql]) => sql.includes('group by attempts.store_id'));
    expect(listingQueries).toHaveLength(1);
    expect(attemptQueries).toHaveLength(1);
    expect(listingQueries[0][0]).toContain('store_items.store_id = any($2::bigint[])');
    expect(listingQueries[0][0]).toMatch(/group by stores\.id, stores\.name, stores\.platform, staleness_hour/i);
    expect(listingQueries[0][1]).toEqual([allStores.report.as_of, ['12']]);
    expect(attemptQueries[0][1]).toEqual([allStores.report.as_of]);
    expect(allStores.summary?.next_due_at).toBe('2026-08-05T11:01:00Z');

    activeCursorStoreId = '16';
    const moved = await read(24, null, 'running');
    expect(moved.summary?.unscheduled_items).toBe(3);
    expect(moved.report).toEqual(allStores.report);
    expect(query.mock.calls.filter(([sql]) => sql.includes('as staleness_hour'))).toHaveLength(1);
  });

  it('retains the prior observation after failure and retries only upon a request one minute later', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-05T11:00:00Z'));
    const readTime = Date.now();
    const listingReads = vi.fn().mockResolvedValueOnce({ rows: [
      { store_id: 12, store_name: 'One', staleness_hour: 1, eligible_items: 4, scheduled_items: 2 }
    ] }).mockResolvedValue({ rows: [
      { store_id: 12, store_name: 'One', staleness_hour: 2, eligible_items: 3 }
    ] });
    const attemptReads = vi.fn().mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('private database error'))
      .mockResolvedValue({ rows: [] });
    const query = vi.fn<Database['query']>(async (sql) => {
      if (sql.includes('as staleness_hour')) return listingReads();
      if (sql.includes('group by attempts.store_id')) return attemptReads();
      return { rows: [] };
    });
    const read = createStoreItemUpdateMonitor({ query });
    try {
      await read(24, null, 'running');
      await new Promise((resolve) => setImmediate(resolve));
      const fresh = await read(24, null, 'running');
      expect(fresh.summary).toMatchObject({ eligible_items: 4, scheduled_items: 2 });
      expect(fresh.live_queue).toBeNull();

      now.mockReturnValue(readTime + 180_000);
      expect(listingReads).toHaveBeenCalledTimes(1);
      const expired = await read(24, null, 'running');
      expect(expired.report).toEqual({ ...fresh.report, status: 'stale', refreshing: true });
      await new Promise((resolve) => setImmediate(resolve));
      now.mockReturnValue(readTime + 239_999);
      const failed = await read(24, null, 'running');
      expect(failed.report).toEqual({ ...fresh.report, status: 'stale' });
      expect(failed.summary).toEqual(fresh.summary);
      expect(failed.generated_at).not.toBe(fresh.generated_at);
      expect(JSON.stringify(failed)).not.toContain('private database error');
      expect(listingReads).toHaveBeenCalledTimes(2);

      now.mockReturnValue(readTime + 240_000);
      expect((await read(24, null, 'running')).report.refreshing).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      const updated = await read(24, null, 'running');
      expect(updated.summary?.eligible_items).toBe(3);
      expect(updated.report).toEqual({ status: 'fresh', as_of: new Date(Date.now()).toISOString(), refreshing: false });
    } finally {
      now.mockRestore();
    }
  });

  it('keeps live status available when the first report fails', async () => {
    const query = vi.fn<Database['query']>(async (sql) => {
      if (sql.includes('as staleness_hour')) throw new Error('statement timed out');
      if (sql.includes('limit 25')) return { rows: [{ status: 'succeeded' }] };
      return { rows: [] };
    });
    const read = createStoreItemUpdateMonitor({ query });
    await read(24, null, 'running');
    await new Promise((resolve) => setImmediate(resolve));
    expect(await read(24, null, 'paused')).toMatchObject({
      control_status: 'paused', summary: null, histogram: [], store_statistics: [],
      recent_attempts: [{ status: 'succeeded' }],
      report: { status: 'unavailable', as_of: null, refreshing: false }
    });
    expect(query.mock.calls.filter(([sql]) => sql.includes('as staleness_hour'))).toHaveLength(1);
  });
});
