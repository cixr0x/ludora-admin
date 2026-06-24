import type { Database } from '../db.js';
import type { BggClient } from './bggClient.js';

export const BGG_THING_REQUEST_TYPE = 'boardgame,boardgameexpansion';

export type BggThingBackfillResult = {
  failed: number;
  fetched: number;
  total: number;
};

export type BggThingBackfillOptions = {
  onFailure?: (bggId: number, error: unknown) => void;
  onProgress?: (progress: { bggId: number; completed: number; total: number }) => void;
};

export async function backfillBggThingCache(
  database: Database,
  bggClient: BggClient,
  options: BggThingBackfillOptions = {}
): Promise<BggThingBackfillResult> {
  const bggIds = await uncachedItemBggIds(database);
  let failed = 0;
  let fetched = 0;

  for (const [index, bggId] of bggIds.entries()) {
    try {
      await bggClient.fetchThing(bggId);
      fetched += 1;
      options.onProgress?.({ bggId, completed: index + 1, total: bggIds.length });
    } catch (error) {
      failed += 1;
      options.onFailure?.(bggId, error);
    }
  }

  return {
    failed,
    fetched,
    total: bggIds.length
  };
}

async function uncachedItemBggIds(database: Database): Promise<number[]> {
  const result = await database.query(
    `
    select distinct i.bgg_id
    from items i
    where i.bgg_id is not null
      and not exists (
        select 1
        from bgg_thing_cache btc
        where btc.bgg_id = i.bgg_id
          and btc.request_type = $1
      )
    order by i.bgg_id asc
    `,
    [BGG_THING_REQUEST_TYPE]
  );

  return result.rows.map((row) => Number((row as Record<string, unknown>).bgg_id)).filter(Number.isFinite);
}
