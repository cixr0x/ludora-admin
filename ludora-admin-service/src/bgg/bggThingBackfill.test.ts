import { describe, expect, it } from 'vitest';

import type { Database } from '../db.js';
import type { BggClient } from './bggClient.js';
import { backfillBggThingCache } from './bggThingBackfill.js';

describe('BGG thing cache backfill', () => {
  it('fetches missing BGG thing payloads for items with BGG ids', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [{ bgg_id: '13' }, { bgg_id: '377061' }] };
      }
    };
    const fetchedBggIds: number[] = [];
    const client: BggClient = {
      fetchThing: async (bggId) => {
        fetchedBggIds.push(bggId);
        return null;
      },
      search: async () => []
    };

    const result = await backfillBggThingCache(database, client);

    expect(fetchedBggIds).toEqual([13, 377061]);
    expect(result).toEqual({
      failed: 0,
      fetched: 2,
      total: 2
    });
    expect(normalizeSql(queries[0]?.sql ?? '')).toContain('from items i');
    expect(normalizeSql(queries[0]?.sql ?? '')).toContain('not exists');
    expect(normalizeSql(queries[0]?.sql ?? '')).toContain('from bgg_thing_cache btc');
    expect(queries[0]?.params).toEqual(['boardgame,boardgameexpansion']);
  });

  it('fetches thing payloads sequentially', async () => {
    const database: Database = {
      query: async () => ({ rows: [{ bgg_id: 1 }, { bgg_id: 2 }] })
    };
    const events: string[] = [];
    let releaseFirstFetch!: () => void;
    const firstFetch = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const client: BggClient = {
      fetchThing: async (bggId) => {
        events.push(`start ${bggId}`);
        if (bggId === 1) {
          await firstFetch;
        }
        events.push(`finish ${bggId}`);
        return null;
      },
      search: async () => []
    };

    const backfill = backfillBggThingCache(database, client);
    await flushPromises();
    expect(events).toEqual(['start 1']);

    releaseFirstFetch();
    await backfill;

    expect(events).toEqual(['start 1', 'finish 1', 'start 2', 'finish 2']);
  });

  it('continues after individual BGG thing fetch failures', async () => {
    const database: Database = {
      query: async () => ({ rows: [{ bgg_id: 1 }, { bgg_id: 2 }] })
    };
    const failedMessages: string[] = [];
    const client: BggClient = {
      fetchThing: async (bggId) => {
        if (bggId === 1) {
          throw new Error('BGG API request failed with 500');
        }
        return null;
      },
      search: async () => []
    };

    const result = await backfillBggThingCache(database, client, {
      onFailure: (_bggId, error) => failedMessages.push(error instanceof Error ? error.message : String(error))
    });

    expect(result).toEqual({
      failed: 1,
      fetched: 1,
      total: 2
    });
    expect(failedMessages).toEqual(['BGG API request failed with 500']);
  });
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
