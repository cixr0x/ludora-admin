import { describe, expect, it } from 'vitest';

import type { Database } from '../db.js';
import { applyBggRatingSync, buildBggRatingSyncPlan } from './bggRatingSync.js';

describe('BGG rating sync', () => {
  it('builds rating updates from cached BGG thing payloads', () => {
    const plan = buildBggRatingSyncPlan({
      cachedThings: [
        {
          bgg_id: 377061,
          raw_xml: thingXml(377061, 'Coffee Rush', '7.48231')
        },
        {
          bgg_id: 411435,
          raw_xml: thingXml(411435, 'Coffee Rush: Piece of Cake', '6.5')
        },
        {
          bgg_id: 999001,
          raw_xml: `
            <items>
              <item type="boardgame" id="999001">
                <name type="primary" value="Unrated Game" />
              </item>
            </items>
          `
        }
      ],
      items: [
        { bgg_id: 377061, id: 1, rating: '7.1' },
        { bgg_id: 411435, id: 2, rating: '6.5' },
        { bgg_id: 999001, id: 3, rating: null },
        { bgg_id: 999002, id: 4, rating: null }
      ]
    });

    expect(plan.ratingUpdates).toEqual([
      {
        bggId: 377061,
        itemId: 1,
        previousRating: 7.1,
        rating: 7.48231
      }
    ]);
    expect(plan.missingCacheBggIds).toEqual([999002]);
    expect(plan.missingRatingBggIds).toEqual([999001]);
    expect(plan.summary).toEqual({
      cachedThings: 3,
      itemsWithBggId: 4,
      malformedCacheRows: 0,
      missingCacheRows: 1,
      missingRatings: 1,
      ratingUpdates: 1,
      unchangedRatings: 1
    });
  });

  it('applies changed ratings with one items update from the cached payload plan', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        const normalized = normalizeSql(sql);
        if (normalized.includes('from items') && normalized.includes('where bgg_id is not null')) {
          return { rows: [{ bgg_id: 377061, id: 1, rating: '7.1' }] };
        }
        if (normalized.includes('from bgg_thing_cache')) {
          return { rows: [{ bgg_id: 377061, raw_xml: thingXml(377061, 'Coffee Rush', '7.48231') }] };
        }
        if (normalized.startsWith('with rating_updates as')) {
          return { rows: [{ updated_rating_rows: 1 }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }
    };

    const result = await applyBggRatingSync(database);

    expect(result.updatedRatingRows).toBe(1);
    expect(result.plan.ratingUpdates).toHaveLength(1);
    const mutation = queries.find((query) => normalizeSql(query.sql).startsWith('with rating_updates as'));
    expect(normalizeSql(mutation?.sql ?? '')).toContain('update items');
    expect(normalizeSql(mutation?.sql ?? '')).toContain('set rating = rating_updates.rating');
    expect(normalizeSql(mutation?.sql ?? '')).toContain('updated_at = now()');
    expect(mutation?.params).toEqual([
      JSON.stringify([
        {
          item_id: 1,
          rating: 7.48231
        }
      ])
    ]);
  });
});

function thingXml(bggId: number, name: string, rating: string): string {
  return `
    <items>
      <item type="boardgame" id="${bggId}">
        <name type="primary" value="${name}" />
        <statistics page="1">
          <ratings>
            <average value="${rating}" />
          </ratings>
        </statistics>
      </item>
    </items>
  `;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
