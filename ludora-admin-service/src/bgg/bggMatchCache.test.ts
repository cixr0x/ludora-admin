import { describe, expect, it } from 'vitest';

import type { Database } from '../db.js';
import {
  BGG_AI_MATCH_SEARCH_TYPE,
  BGG_SEARCH_TYPE,
  createBggMatchCache
} from './bggMatchCache.js';

const warOfTheRing = {
  bggId: 115746,
  name: 'War of the Ring: Second Edition',
  type: 'boardgame',
  yearPublished: 2011
};

describe('BGG match cache', () => {
  it('marks AI query associations as verified', async () => {
    const cache = createBggMatchCache(databaseForAiQueryRow({
      bgg_id: 115746,
      name: 'War of the Ring: Second Edition',
      item_type: 'boardgame',
      year_published: 2011
    }));

    await expect(cache.lookup('La Guerra del Anillo')).resolves.toEqual({
      cacheHit: true,
      matches: [{ item: warOfTheRing, verifiedByAi: true }]
    });
  });

  it('marks ordinary query associations as unverified', async () => {
    const cache = createBggMatchCache(databaseForOrdinaryQueryRow({
      bgg_id: 377061,
      name: 'Coffee Rush',
      item_type: 'boardgame',
      year_published: 2023
    }));

    await expect(cache.lookup('Coffee Rush')).resolves.toEqual({
      cacheHit: true,
      matches: [{
        item: { bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 },
        verifiedByAi: false
      }]
    });
  });

  it('returns direct BGG cache-name matches as unverified', async () => {
    const cache = createBggMatchCache(databaseForDirectCacheRow({
      bgg_id: 13,
      name: 'Catan',
      item_type: 'boardgame',
      year_published: 1995
    }));

    await expect(cache.lookup('Catan')).resolves.toEqual({
      cacheHit: true,
      matches: [{
        item: { bggId: 13, name: 'Catan', type: 'boardgame', yearPublished: 1995 },
        verifiedByAi: false
      }]
    });
  });

  it('returns thing-cache name matches as unverified', async () => {
    const cache = createBggMatchCache(databaseForThingCacheRow({
      bgg_id: 174430,
      name: 'Gloomhaven',
      item_type: 'boardgame',
      year_published: 2017
    }));

    await expect(cache.lookup('Gloomhaven')).resolves.toEqual({
      cacheHit: true,
      matches: [{
        item: { bggId: 174430, name: 'Gloomhaven', type: 'boardgame', yearPublished: 2017 },
        verifiedByAi: false
      }]
    });
  });

  it('deduplicates by BGG id without losing AI verification', async () => {
    const cache = createBggMatchCache(databaseForDuplicateAiAndOrdinaryRows());

    await expect(cache.lookup('La Guerra del Anillo')).resolves.toEqual({
      cacheHit: true,
      matches: [{ item: warOfTheRing, verifiedByAi: true }]
    });
  });

  it('returns a complete miss without an upstream dependency', async () => {
    const cache = createBggMatchCache(databaseWithEmptyRows());

    await expect(cache.lookup('Juego desconocido')).resolves.toEqual({ cacheHit: false, matches: [] });
  });

  it('writes each trusted AI query once and links it to the result at rank zero', async () => {
    const { database, executedParams, executedSql } = recordingDatabase();
    const cache = createBggMatchCache(database);

    await cache.recordAiMatch(['La Guerra del Anillo', 'War of the Ring: Second Edition'], warOfTheRing);

    expect(executedSql).toContainEqual(expect.stringContaining('insert into bgg_search_cache'));
    expect(executedParams).toContainEqual(expect.arrayContaining([BGG_AI_MATCH_SEARCH_TYPE]));
    expect(executedParams.filter((params) => params[2] === BGG_AI_MATCH_SEARCH_TYPE)).toEqual([
      ['La Guerra del Anillo', 'la guerra del anillo', BGG_AI_MATCH_SEARCH_TYPE],
      ['War of the Ring: Second Edition', 'war of the ring second edition', BGG_AI_MATCH_SEARCH_TYPE]
    ]);
    expect(executedParams.filter((params) => params.length === 3 && params[2] === 0)).toEqual([
      [201, 101, 0],
      [202, 101, 0]
    ]);
  });

  it('keeps standard search entries under the ordinary search type', async () => {
    const { database, executedParams } = recordingDatabase();
    const cache = createBggMatchCache(database);

    await cache.recordSearch('Catan', [{ bggId: 13, name: 'Catan', type: 'boardgame', yearPublished: 1995 }]);

    expect(executedParams).toContainEqual(['Catan', 'catan', BGG_SEARCH_TYPE, 1]);
  });
});

function databaseForAiQueryRow(row: Record<string, unknown>): Database {
  return databaseForLookup({ aiRows: [row] });
}

function databaseForOrdinaryQueryRow(row: Record<string, unknown>): Database {
  return databaseForLookup({ ordinaryRows: [row] });
}

function databaseForDirectCacheRow(row: Record<string, unknown>): Database {
  return databaseForLookup({ directRows: [row] });
}

function databaseForThingCacheRow(row: Record<string, unknown>): Database {
  return databaseForLookup({ thingRows: [row] });
}

function databaseForDuplicateAiAndOrdinaryRows(): Database {
  return databaseForLookup({ aiRows: [toCacheRow(warOfTheRing)], ordinaryRows: [toCacheRow(warOfTheRing)] });
}

function databaseWithEmptyRows(): Database {
  return databaseForLookup({});
}

function databaseForLookup(options: {
  aiRows?: unknown[];
  directRows?: unknown[];
  ordinaryRows?: unknown[];
  thingRows?: unknown[];
}): Database {
  return {
    query: async (sql, params) => {
      const normalized = normalizeSql(sql);
      if (normalized.startsWith('select id from bgg_search_queries')) {
        const searchType = params?.[1];
        if (searchType === BGG_AI_MATCH_SEARCH_TYPE && options.aiRows !== undefined) {
          return { rows: [{ id: 11 }] };
        }
        if (searchType === BGG_SEARCH_TYPE && options.ordinaryRows !== undefined) {
          return { rows: [{ id: 12 }] };
        }
        return { rows: [] };
      }
      if (normalized.includes('from bgg_search_query_results')) {
        return { rows: params?.[0] === 11 ? (options.aiRows ?? []) : (options.ordinaryRows ?? []) };
      }
      if (normalized.includes('from bgg_search_cache')) {
        return { rows: options.directRows ?? [] };
      }
      if (normalized.includes('from bgg_thing_cache')) {
        return { rows: options.thingRows ?? [] };
      }
      throw new Error(`Unexpected lookup SQL: ${normalized}`);
    }
  };
}

function recordingDatabase(): {
  database: Database;
  executedParams: unknown[][];
  executedSql: string[];
} {
  const executedParams: unknown[][] = [];
  const executedSql: string[] = [];
  let nextOrdinaryQueryId = 301;
  let nextAiQueryId = 201;
  return {
    database: {
      query: async (sql, params = []) => {
        executedSql.push(normalizeSql(sql));
        executedParams.push(params);
        const normalized = normalizeSql(sql);
        if (normalized.startsWith('insert into bgg_search_cache')) {
          return { rows: [{ id: 101 }] };
        }
        if (normalized.startsWith('insert into bgg_search_queries')) {
          return {
            rows: [{
              id: params[2] === BGG_AI_MATCH_SEARCH_TYPE ? nextAiQueryId++ : nextOrdinaryQueryId++
            }]
          };
        }
        return { rows: [] };
      }
    },
    executedParams,
    executedSql
  };
}

function toCacheRow(item: typeof warOfTheRing): Record<string, unknown> {
  return {
    bgg_id: item.bggId,
    item_type: item.type,
    name: item.name,
    year_published: item.yearPublished
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
