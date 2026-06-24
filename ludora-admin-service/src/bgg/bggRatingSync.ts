import type { Database } from '../db.js';
import { parseBggThingResponse } from './bggParser.js';

const BGG_THING_REQUEST_TYPE = 'boardgame,boardgameexpansion';

export type BggRatingSyncInput = {
  cachedThings: CachedThingRatingRow[];
  items: ItemRatingRow[];
};

export type CachedThingRatingRow = {
  bgg_id: number | string;
  raw_xml: string;
};

export type ItemRatingRow = {
  bgg_id: number | string;
  id: number | string;
  rating?: number | string | null;
};

export type BggRatingUpdate = {
  bggId: number;
  itemId: number;
  previousRating: number | null;
  rating: number;
};

export type BggRatingSyncPlan = {
  malformedCacheBggIds: number[];
  missingCacheBggIds: number[];
  missingRatingBggIds: number[];
  ratingUpdates: BggRatingUpdate[];
  summary: BggRatingSyncSummary;
};

export type BggRatingSyncSummary = {
  cachedThings: number;
  itemsWithBggId: number;
  malformedCacheRows: number;
  missingCacheRows: number;
  missingRatings: number;
  ratingUpdates: number;
  unchangedRatings: number;
};

export type AppliedBggRatingSync = {
  plan: BggRatingSyncPlan;
  updatedRatingRows: number;
};

export async function loadBggRatingSyncPlan(database: Database): Promise<BggRatingSyncPlan> {
  const [items, cachedThings] = await Promise.all([
    database.query(
      `
      select id, bgg_id, rating
      from items
      where bgg_id is not null
      order by bgg_id asc
      `
    ),
    database.query(
      `
      select bgg_id, raw_xml
      from bgg_thing_cache
      where request_type = $1
      order by bgg_id asc
      `,
      [BGG_THING_REQUEST_TYPE]
    )
  ]);

  return buildBggRatingSyncPlan({
    cachedThings: cachedThings.rows as CachedThingRatingRow[],
    items: items.rows as ItemRatingRow[]
  });
}

export function buildBggRatingSyncPlan(input: BggRatingSyncInput): BggRatingSyncPlan {
  const cacheByBggId = new Map<number, CachedThingRatingRow>();
  for (const cachedThing of input.cachedThings) {
    const bggId = numberOrNull(cachedThing.bgg_id);
    if (bggId !== null && !cacheByBggId.has(bggId)) {
      cacheByBggId.set(bggId, cachedThing);
    }
  }

  const ratingUpdates: BggRatingUpdate[] = [];
  const malformedCacheBggIds: number[] = [];
  const missingCacheBggIds: number[] = [];
  const missingRatingBggIds: number[] = [];
  let itemsWithBggId = 0;
  let unchangedRatings = 0;

  for (const item of input.items) {
    const itemId = numberOrNull(item.id);
    const bggId = numberOrNull(item.bgg_id);
    if (itemId === null || bggId === null) {
      continue;
    }
    itemsWithBggId += 1;

    const cachedThing = cacheByBggId.get(bggId);
    if (!cachedThing) {
      missingCacheBggIds.push(bggId);
      continue;
    }

    try {
      const thing = parseBggThingResponse(cachedThing.raw_xml);
      if (!thing || thing.bggId !== bggId) {
        malformedCacheBggIds.push(bggId);
        continue;
      }
      if (thing.rating === null) {
        missingRatingBggIds.push(bggId);
        continue;
      }

      const previousRating = numberOrNull(item.rating);
      if (previousRating === thing.rating) {
        unchangedRatings += 1;
        continue;
      }

      ratingUpdates.push({
        bggId,
        itemId,
        previousRating,
        rating: thing.rating
      });
    } catch {
      malformedCacheBggIds.push(bggId);
    }
  }

  ratingUpdates.sort((left, right) => left.bggId - right.bggId || left.itemId - right.itemId);

  return {
    malformedCacheBggIds: uniqueNumbers(malformedCacheBggIds).sort(compareNumbers),
    missingCacheBggIds: uniqueNumbers(missingCacheBggIds).sort(compareNumbers),
    missingRatingBggIds: uniqueNumbers(missingRatingBggIds).sort(compareNumbers),
    ratingUpdates,
    summary: {
      cachedThings: input.cachedThings.length,
      itemsWithBggId,
      malformedCacheRows: uniqueNumbers(malformedCacheBggIds).length,
      missingCacheRows: uniqueNumbers(missingCacheBggIds).length,
      missingRatings: uniqueNumbers(missingRatingBggIds).length,
      ratingUpdates: ratingUpdates.length,
      unchangedRatings
    }
  };
}

export async function applyBggRatingSync(database: Database): Promise<AppliedBggRatingSync> {
  const plan = await loadBggRatingSyncPlan(database);
  const updates = plan.ratingUpdates.map((update) => ({
    item_id: update.itemId,
    rating: update.rating
  }));

  if (updates.length === 0) {
    return {
      plan,
      updatedRatingRows: 0
    };
  }

  const result = await database.query(
    `
    with rating_updates as (
      select *
      from jsonb_to_recordset($1::jsonb) as rating_update(
        item_id bigint,
        rating numeric
      )
    ),
    updated as (
      update items
      set rating = rating_updates.rating,
          updated_at = now()
      from rating_updates
      where items.id = rating_updates.item_id
        and items.rating is distinct from rating_updates.rating
      returning items.id
    )
    select count(*)::int as updated_rating_rows
    from updated
    `,
    [JSON.stringify(updates)]
  );

  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return {
    plan,
    updatedRatingRows: numberOrNull(row.updated_rating_rows) ?? 0
  };
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values));
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
