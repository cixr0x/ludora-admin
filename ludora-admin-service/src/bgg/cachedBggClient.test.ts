import { describe, expect, it } from 'vitest';

import type { Database } from '../db.js';
import type { BggThingXmlClient } from './bggClient.js';
import type { BggSearchItem } from './bggParser.js';
import { createCachedBggClient } from './cachedBggClient.js';

const BGG_THING_REQUEST_TYPE = 'boardgame,boardgameexpansion';

const coffeeRushXml = `
<items>
  <item type="boardgame" id="377061">
    <name type="primary" value="Coffee Rush" />
    <yearpublished value="2023" />
  </item>
</items>
`;

describe('cached BGG client', () => {
  it('returns cached thing XML without calling the upstream BGG client', async () => {
    const { database, queries } = fakeDatabase([[{ raw_xml: coffeeRushXml }]]);
    const upstream = fakeUpstreamClient(async () => {
      throw new Error('BGG API should not be called when thing XML is cached');
    });

    const result = await createCachedBggClient(database, upstream).fetchThing(377061);

    expect(result?.details.name).toBe('Coffee Rush');
    expect(result?.rawXml).toBe(coffeeRushXml);
    expect(queries).toHaveLength(1);
    expect(normalizeSql(queries[0]?.sql ?? '')).toContain('from bgg_thing_cache');
  });

  it('stores fresh upstream thing XML before returning parsed details', async () => {
    const { database, queries } = fakeDatabase([[]]);
    const fetchedBggIds: number[] = [];
    const upstream = fakeUpstreamClient(async (bggId) => {
      fetchedBggIds.push(bggId);
      return coffeeRushXml;
    });

    const result = await createCachedBggClient(database, upstream).fetchThing(377061);

    expect(result?.details.name).toBe('Coffee Rush');
    expect(fetchedBggIds).toEqual([377061]);
    const cacheWrite = queries.find((query) => normalizeSql(query.sql).startsWith('insert into bgg_thing_cache'));
    expect(cacheWrite?.params?.slice(0, 6)).toEqual([
      377061,
      BGG_THING_REQUEST_TYPE,
      coffeeRushXml,
      'Coffee Rush',
      'boardgame',
      2023
    ]);
    expect(cacheWrite?.params?.[6]).toMatchObject({
      bggId: 377061,
      name: 'Coffee Rush',
      type: 'boardgame',
      yearPublished: 2023
    });
  });

  it('stores upstream thing XML even when BGG returns no item details', async () => {
    const emptyXml = '<items></items>';
    const { database, queries } = fakeDatabase([[]]);
    const upstream = fakeUpstreamClient(async () => emptyXml);

    const result = await createCachedBggClient(database, upstream).fetchThing(999999);

    expect(result).toBeNull();
    const cacheWrite = queries.find((query) => normalizeSql(query.sql).startsWith('insert into bgg_thing_cache'));
    expect(cacheWrite?.params?.slice(0, 6)).toEqual([999999, BGG_THING_REQUEST_TYPE, emptyXml, '', '', null]);
    expect(cacheWrite?.params?.[6]).toEqual({});
  });

  it('refreshes malformed cached XML from the upstream BGG client', async () => {
    const { database, queries } = fakeDatabase([[{ raw_xml: '<items><item' }]]);
    const fetchedBggIds: number[] = [];
    const upstream = fakeUpstreamClient(async (bggId) => {
      fetchedBggIds.push(bggId);
      return coffeeRushXml;
    });

    const result = await createCachedBggClient(database, upstream).fetchThing(377061);

    expect(result?.details.name).toBe('Coffee Rush');
    expect(fetchedBggIds).toEqual([377061]);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into bgg_thing_cache'))).toBe(true);
  });

  it('returns cached search results without calling the upstream BGG client', async () => {
    const { database, queries } = fakeDatabase([
      [{ id: 91 }],
      [
        {
          bgg_id: '377061',
          item_type: 'boardgame',
          name: 'Coffee Rush',
          year_published: 2023
        }
      ]
    ]);
    const upstream = fakeUpstreamClient(
      async () => coffeeRushXml,
      async () => {
        throw new Error('BGG search API should not be called when search results are cached');
      }
    );

    const results = await createCachedBggClient(database, upstream).search('Coffee Rush');

    expect(results).toEqual([{ bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 }]);
    expect(queries).toHaveLength(2);
    expect(normalizeSql(queries[0]?.sql ?? '')).toContain('from bgg_search_queries');
    expect(normalizeSql(queries[1]?.sql ?? '')).toContain('from bgg_search_query_results');
  });

  it('bypasses cached search results when a fresh upstream search is requested', async () => {
    const { database, queries } = fakeDatabase([]);
    const upstreamSearches: string[] = [];
    const upstream = fakeUpstreamClient(
      async () => coffeeRushXml,
      async (query) => {
        upstreamSearches.push(query);
        return [{ bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 }];
      }
    );

    const results = await createCachedBggClient(database, upstream).searchFresh?.('Coffee Rush');

    expect(results).toEqual([{ bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 }]);
    expect(upstreamSearches).toEqual(['Coffee Rush']);
    expect(queries.some((query) => normalizeSql(query.sql).includes('from bgg_search_queries'))).toBe(false);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into bgg_search_queries'))).toBe(true);
  });

  it('stores upstream search results when the search cache misses', async () => {
    const { database, queries } = fakeDatabase([[]]);
    const upstreamSearches: string[] = [];
    const upstream = fakeUpstreamClient(
      async () => coffeeRushXml,
      async (query) => {
        upstreamSearches.push(query);
        return [{ bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 }];
      }
    );

    const results = await createCachedBggClient(database, upstream).search('Coffee Rush');

    expect(results).toEqual([{ bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 }]);
    expect(upstreamSearches).toEqual(['Coffee Rush']);
    const queryWrite = queries.find((query) => normalizeSql(query.sql).startsWith('insert into bgg_search_queries'));
    const resultWrite = queries.find((query) => normalizeSql(query.sql).startsWith('insert into bgg_search_cache'));
    const relationWrite = queries.find((query) => normalizeSql(query.sql).startsWith('insert into bgg_search_query_results'));
    expect(queryWrite?.params).toEqual(['Coffee Rush', 'coffee rush', BGG_THING_REQUEST_TYPE, 1]);
    expect(resultWrite?.params).toEqual([
      377061,
      'Coffee Rush',
      'boardgame',
      2023,
      JSON.stringify({ bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 })
    ]);
    expect(relationWrite?.params).toEqual([91, 101, 0]);
  });

  it('returns thing cache search results before calling the upstream BGG search API', async () => {
    const { database, queries } = fakeDatabase([
      [],
      [
        {
          bgg_id: '377061',
          item_type: 'boardgame',
          name: 'Coffee Rush',
          year_published: 2023
        }
      ]
    ]);
    const upstream = fakeUpstreamClient(
      async () => coffeeRushXml,
      async () => {
        throw new Error('BGG search API should not be called when thing cache can answer the search');
      }
    );

    const results = await createCachedBggClient(database, upstream).search('Coffee Rush');

    expect(results).toEqual([{ bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 }]);
    expect(queries.some((query) => normalizeSql(query.sql).includes('from bgg_thing_cache'))).toBe(true);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into bgg_search_queries'))).toBe(true);
  });

  it('does not call upstream search for empty normalized queries', async () => {
    const { database, queries } = fakeDatabase([]);
    const upstream = fakeUpstreamClient(
      async () => coffeeRushXml,
      async () => {
        throw new Error('BGG search API should not be called for empty queries');
      }
    );

    const results = await createCachedBggClient(database, upstream).search('   ');

    expect(results).toEqual([]);
    expect(queries).toEqual([]);
  });
});

function fakeUpstreamClient(
  fetchThingXml: (bggId: number) => Promise<string>,
  search: (query: string) => Promise<BggSearchItem[]> = async () => []
): BggThingXmlClient {
  return {
    fetchThing: async () => {
      throw new Error('cached client should use fetchThingXml to persist every thing response');
    },
    fetchThingXml,
    search
  };
}

function fakeDatabase(selectResults: unknown[][]): { database: Database; queries: Array<{ params?: unknown[]; sql: string }> } {
  const queries: Array<{ params?: unknown[]; sql: string }> = [];
  const insertIds = [91, 101, 102, 103];
  const database: Database = {
    query: async (sql, params) => {
      queries.push({ params, sql });
      const normalized = normalizeSql(sql);
      if (
        normalized.startsWith('select raw_xml') ||
        normalized.startsWith('select id') ||
        normalized.startsWith('select c.bgg_id') ||
        normalized.startsWith('select bgg_id')
      ) {
        return { rows: selectResults.shift() ?? [] };
      }
      if (normalized.includes('returning id')) {
        return { rows: [{ id: insertIds.shift() }] };
      }
      return { rows: [] };
    }
  };
  return { database, queries };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
