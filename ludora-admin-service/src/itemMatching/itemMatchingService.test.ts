import { describe, expect, it } from 'vitest';

import type { BggClient } from '../bgg/bggClient.js';
import type { Database } from '../db.js';
import type { TranslationRequest, TranslationService } from '../translation/translationService.js';
import { createItemMatchingService } from './itemMatchingService.js';

describe('item matching service', () => {
  it('generates and stores local and BGG match candidates', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        const normalized = normalizeSql(sql);
        if (normalized.includes('from store_items')) {
          return {
            rows: [
              {
                id: 42,
                item_type: 'base_game',
                max_players: 4,
                min_players: 2,
                publisher: 'Korea Boardgames',
                title: 'Cafe Barista'
              }
            ]
          };
        }
        if (normalized.includes('from items')) {
          return {
            rows: [
              {
                aliases: ['Cafe Barista'],
                bgg_id: 377061,
                canonical_name: 'Coffee Rush',
                id: 7,
                item_type: 'base_game',
                normalized_name: 'coffee rush'
              }
            ]
          };
        }
        const cacheRows = bggSearchCacheRows(normalized);
        if (cacheRows) {
          return cacheRows;
        }
        if (normalized.startsWith('delete from item_match_candidates')) {
          return { rows: [] };
        }
        if (normalized.startsWith('insert into item_match_candidates')) {
          return {
            rows: [
              {
                bgg_id: params?.[3] ?? null,
                discovery_item_candidate_id: params?.[0],
                id: queries.length,
                item_id: params?.[2] ?? null,
                match_reasons: JSON.parse(String(params?.[6])),
                match_score: params?.[5],
                matched_name: params?.[4],
                raw_payload: JSON.parse(String(params?.[7])),
                source: params?.[1],
                status: 'PENDING'
              }
            ]
          };
        }
        return { rows: [] };
      }
    };
    const bggClient: BggClient = {
      fetchThing: async () => ({
        details: {
          alternateNames: ['Café Barista'],
          artists: [],
          bggId: 377061,
          categories: [],
          description: '',
          designers: [],
          families: [],
          image: '',
          maxPlayers: 4,
          maxPlaytime: 30,
          mechanics: [],
          minAge: 8,
          minPlayers: 2,
          minPlaytime: 30,
          name: 'Coffee Rush',
          playingTime: 30,
          publishers: [{ bggId: 8291, name: 'Korea Boardgames' }],
          thumbnail: '',
          type: 'boardgame',
          yearPublished: 2023
        },
        rawXml: '<items />'
      }),
      search: async () => [{ bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 }]
    };

    const result = await createItemMatchingService(database, bggClient).generateMatchCandidates(42);

    expect(result).toHaveLength(2);
    expect(result.map((row) => row.source)).toEqual(['LOCAL', 'BGG']);
    expect(normalizeSql(queries[0].sql)).toContain('from store_items');
    expect(normalizeSql(queries[1].sql)).toContain('from items');
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('delete from item_match_candidates'))).toBe(true);
  });

  it('skips BGG matching when no BGG client is configured', async () => {
    const database: Database = {
      query: async (sql, params) => {
        const normalized = normalizeSql(sql);
        if (normalized.includes('from store_items')) {
          return { rows: [{ id: 42, item_type: 'base_game', publisher: '', title: 'Catan' }] };
        }
        if (normalized.includes('from items')) {
          return {
            rows: [{ aliases: [], bgg_id: 13, canonical_name: 'Catan', id: 7, item_type: 'base_game', normalized_name: 'catan' }]
          };
        }
        if (normalized.startsWith('insert into item_match_candidates')) {
          return {
            rows: [
              {
                discovery_item_candidate_id: params?.[0],
                id: 1,
                item_id: params?.[2],
                source: params?.[1],
                status: 'PENDING'
              }
            ]
          };
        }
        return { rows: [] };
      }
    };

    const result = await createItemMatchingService(database).generateMatchCandidates(42);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('LOCAL');
  });

  it('uses translated query variants for BGG search', async () => {
    const searchedQueries: string[] = [];
    const database: Database = {
      query: async (sql, params) => {
        const normalized = normalizeSql(sql);
        if (normalized.includes('from store_items')) {
          return {
            rows: [
              {
                id: 920,
                item_type: 'unknown',
                language: 'es',
                max_players: 6,
                min_players: 5,
                publisher: 'Devir',
                title: 'Catan: Mercaderes y Bárbaros, Ampliación 5-6 jugadores (Español)'
              }
            ]
          };
        }
        if (normalized.includes('from items')) {
          return { rows: [] };
        }
        const cacheRows = bggSearchCacheRows(normalized);
        if (cacheRows) {
          return cacheRows;
        }
        if (normalized.startsWith('insert into item_match_candidates')) {
          return {
            rows: [
              {
                bgg_id: params?.[3],
                discovery_item_candidate_id: params?.[0],
                id: 10,
                matched_name: params?.[4],
                source: params?.[1],
                status: 'PENDING'
              }
            ]
          };
        }
        return { rows: [] };
      }
    };
    const bggClient: BggClient = {
      fetchThing: async () => ({
        details: {
          alternateNames: [],
          artists: [],
          bggId: 34691,
          categories: [],
          description: '',
          designers: [],
          families: [],
          image: '',
          maxPlayers: 6,
          maxPlaytime: 120,
          mechanics: [],
          minAge: 10,
          minPlayers: 5,
          minPlaytime: 90,
          name: 'Catan: Traders & Barbarians – 5-6 Player Expansion',
          playingTime: 120,
          publishers: [{ bggId: 10, name: 'Devir' }],
          thumbnail: '',
          type: 'boardgameexpansion',
          yearPublished: 2008
        },
        rawXml: '<items />'
      }),
      search: async (query) => {
        searchedQueries.push(query);
        return query === 'Catan Traders Barbarians 5 6'
          ? [{ bggId: 34691, name: 'Catan: Traders & Barbarians – 5-6 Player Expansion', type: 'boardgameexpansion', yearPublished: 2008 }]
          : [];
      }
    };
    const translationRequests: TranslationRequest[] = [];
    const translationService: TranslationService = {
      translate: async (request) => {
        translationRequests.push(request);
        return {
          alternates: ['Catan Traders Barbarians 5 6'],
          fromCache: false,
          metadata: { confidence: 0.88 },
          model: 'fake',
          promptVersion: 'translation-v1',
          translatedText: 'Catan: Traders & Barbarians 5-6 Player Expansion'
        };
      }
    };

    const result = await createItemMatchingService(database, bggClient, translationService).generateMatchCandidates(920);

    expect(searchedQueries).toContain('Catan: Mercaderes y Bárbaros, Ampliación 5-6 jugadores (Español)');
    expect(translationRequests[0]).toMatchObject({ sourceLanguage: 'es', targetLanguage: 'en' });
    expect(searchedQueries).toContain('Catan Traders Barbarians 5 6');
    expect(result).toHaveLength(1);
    expect(result[0].bgg_id).toBe(34691);
  });

  it('skips translated BGG search when the original title has a high-confidence match', async () => {
    const searchedQueries: string[] = [];
    const translationRequests: TranslationRequest[] = [];
    const database: Database = {
      query: async (sql, params) => {
        const normalized = normalizeSql(sql);
        if (normalized.includes('from store_items')) {
          return {
            rows: [
              {
                id: 43,
                item_type: 'base_game',
                language: 'en',
                max_players: 4,
                min_players: 2,
                publisher: 'Korea Boardgames',
                title: 'Coffee Rush'
              }
            ]
          };
        }
        if (normalized.includes('from items')) {
          return { rows: [] };
        }
        const cacheRows = bggSearchCacheRows(normalized);
        if (cacheRows) {
          return cacheRows;
        }
        if (normalized.startsWith('insert into item_match_candidates')) {
          return {
            rows: [
              {
                bgg_id: params?.[3],
                discovery_item_candidate_id: params?.[0],
                id: 11,
                matched_name: params?.[4],
                source: params?.[1],
                status: 'PENDING'
              }
            ]
          };
        }
        return { rows: [] };
      }
    };
    const bggClient: BggClient = {
      fetchThing: async () => ({
        details: {
          alternateNames: [],
          artists: [],
          bggId: 377061,
          categories: [],
          description: '',
          designers: [],
          families: [],
          image: '',
          maxPlayers: 4,
          maxPlaytime: 30,
          mechanics: [],
          minAge: 8,
          minPlayers: 2,
          minPlaytime: 30,
          name: 'Coffee Rush',
          playingTime: 30,
          publishers: [{ bggId: 8291, name: 'Korea Boardgames' }],
          thumbnail: '',
          type: 'boardgame',
          yearPublished: 2023
        },
        rawXml: '<items />'
      }),
      search: async (query) => {
        searchedQueries.push(query);
        return [{ bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 }];
      }
    };
    const translationService: TranslationService = {
      translate: async (request) => {
        translationRequests.push(request);
        return {
          alternates: ['Cafe Barista'],
          fromCache: false,
          metadata: {},
          model: 'fake',
          promptVersion: 'translation-v1',
          translatedText: 'Cafe Barista'
        };
      }
    };

    const result = await createItemMatchingService(database, bggClient, translationService).generateMatchCandidates(43);

    expect(result).toHaveLength(1);
    expect(result[0].bgg_id).toBe(377061);
    expect(searchedQueries).toEqual(['Coffee Rush']);
    expect(translationRequests).toEqual([]);
  });

  it('keeps only the newest exact BGG search result by published year', async () => {
    const fetchedBggIds: number[] = [];
    const database = matchOnlyDatabase({ id: 44, item_type: 'base_game', publisher: '', title: 'Courtisans' });
    const bggClient: BggClient = {
      fetchThing: async (bggId) => {
        fetchedBggIds.push(bggId);
        return {
          details: bggThing({
            bggId,
            name: bggId === 450001 ? 'Courtisans' : 'Courtisans Deluxe',
            yearPublished: bggId === 450001 ? 2024 : 2023
          }),
          rawXml: '<items />'
        };
      },
      search: async () => [
        { bggId: 410001, name: 'Courtisans', type: 'boardgame', yearPublished: 2023 },
        { bggId: 450001, name: 'Courtisans', type: 'boardgame', yearPublished: 2024 },
        { bggId: 450002, name: 'Courtisans Deluxe', type: 'boardgame', yearPublished: 2024 }
      ]
    };

    const result = await createItemMatchingService(database, bggClient).generateMatchCandidates(44);

    expect(fetchedBggIds).toEqual([450001]);
    expect(result).toHaveLength(1);
    expect(result[0].bgg_id).toBe(450001);
  });

  it('uses the highest BGG id for exact BGG search results with missing years', async () => {
    const fetchedBggIds: number[] = [];
    const database = matchOnlyDatabase({ id: 45, item_type: 'base_game', publisher: '', title: 'Res Arcana Duo' });
    const bggClient: BggClient = {
      fetchThing: async (bggId) => {
        fetchedBggIds.push(bggId);
        return {
          details: bggThing({
            bggId,
            name: 'Res Arcana Duo',
            yearPublished: null
          }),
          rawXml: '<items />'
        };
      },
      search: async () => [
        { bggId: 501001, name: 'Res Arcana Duo', type: 'boardgame', yearPublished: null },
        { bggId: 503001, name: 'Res Arcana Duo', type: 'boardgame', yearPublished: null }
      ]
    };

    const result = await createItemMatchingService(database, bggClient).generateMatchCandidates(45);

    expect(fetchedBggIds).toEqual([503001]);
    expect(result).toHaveLength(1);
    expect(result[0].bgg_id).toBe(503001);
  });

  it('uses cached BGG search results before calling the BGG search API', async () => {
    const database = matchOnlyDatabase(
      { id: 46, item_type: 'base_game', publisher: '', title: 'Coffee Rush' },
      {
        cachedSearchResults: [{ bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 }]
      }
    );
    const bggClient: BggClient = {
      fetchThing: async (bggId) => ({
        details: bggThing({ bggId, name: 'Coffee Rush', yearPublished: 2023 }),
        rawXml: '<items />'
      }),
      search: async () => {
        throw new Error('BGG search API should not be called when cache is populated');
      }
    };

    const result = await createItemMatchingService(database, bggClient).generateMatchCandidates(46);

    expect(result).toHaveLength(1);
    expect(result[0].bgg_id).toBe(377061);
  });

  it('stores BGG search results when the search cache misses', async () => {
    const cacheWrites: Array<{ sql: string; params: unknown[] }> = [];
    const database = matchOnlyDatabase(
      { id: 47, item_type: 'base_game', publisher: '', title: 'Coffee Rush' },
      {
        onCacheWrite: (sql, params) => cacheWrites.push({ sql, params: params ?? [] })
      }
    );
    const bggClient: BggClient = {
      fetchThing: async (bggId) => ({
        details: bggThing({ bggId, name: 'Coffee Rush', yearPublished: 2023 }),
        rawXml: '<items />'
      }),
      search: async () => [{ bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 }]
    };

    await createItemMatchingService(database, bggClient).generateMatchCandidates(47);

    const queryWrite = cacheWrites.find((write) => normalizeSql(write.sql).startsWith('insert into bgg_search_queries'));
    const resultWrite = cacheWrites.find((write) => normalizeSql(write.sql).startsWith('insert into bgg_search_cache'));
    const relationWrite = cacheWrites.find((write) =>
      normalizeSql(write.sql).startsWith('insert into bgg_search_query_results')
    );
    expect(queryWrite?.params.slice(0, 4)).toEqual(['Coffee Rush', 'coffee rush', 'boardgame,boardgameexpansion', 1]);
    expect(resultWrite?.params.slice(0, 5)).toEqual([
      377061,
      'Coffee Rush',
      'boardgame',
      2023,
      JSON.stringify({ bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 })
    ]);
    expect(relationWrite?.params).toEqual([91, 92, 0]);
  });

  it('throws 404 when the discovery item candidate is missing', async () => {
    const database: Database = {
      query: async () => ({ rows: [] })
    };

    await expect(createItemMatchingService(database).generateMatchCandidates(404)).rejects.toMatchObject({
      message: 'Discovery item candidate not found',
      status: 404
    });
  });
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function bggSearchCacheRows(normalizedSql: string): { rows: Record<string, unknown>[] } | null {
  if (normalizedSql.includes('from bgg_search_queries')) {
    return { rows: [] };
  }
  if (normalizedSql.startsWith('delete from bgg_search_query_results')) {
    return { rows: [] };
  }
  if (normalizedSql.startsWith('insert into bgg_search_queries')) {
    return { rows: [{ id: 91 }] };
  }
  if (normalizedSql.startsWith('insert into bgg_search_cache')) {
    return { rows: [{ id: 92 }] };
  }
  if (normalizedSql.startsWith('insert into bgg_search_query_results')) {
    return { rows: [] };
  }
  return null;
}

function matchOnlyDatabase(
  candidate: Record<string, unknown>,
  options: {
    cachedSearchResults?: unknown[];
    onCacheWrite?: (sql: string, params: unknown[] | undefined) => void;
  } = {}
): Database {
  return {
    query: async (sql, params) => {
      const normalized = normalizeSql(sql);
      if (normalized.includes('from store_items')) {
        return { rows: [candidate] };
      }
      if (normalized.includes('from items')) {
        return { rows: [] };
      }
      if (normalized.includes('from bgg_search_queries')) {
        return options.cachedSearchResults ? { rows: [{ id: 91, result_count: options.cachedSearchResults.length }] } : { rows: [] };
      }
      if (normalized.includes('from bgg_search_query_results')) {
        return {
          rows: (options.cachedSearchResults ?? []).map((item) => {
            const row = item as Record<string, unknown>;
            return {
              bgg_id: row.bggId ?? row.bgg_id,
              item_type: row.type ?? row.item_type,
              name: row.name,
              year_published: row.yearPublished ?? row.year_published
            };
          })
        };
      }
      if (normalized.startsWith('delete from bgg_search_query_results')) {
        return { rows: [] };
      }
      if (normalized.startsWith('insert into bgg_search_queries')) {
        options.onCacheWrite?.(sql, params);
        return { rows: [{ id: 91 }] };
      }
      if (normalized.startsWith('insert into bgg_search_cache')) {
        options.onCacheWrite?.(sql, params);
        return { rows: [{ id: 92 }] };
      }
      if (normalized.startsWith('insert into bgg_search_query_results')) {
        options.onCacheWrite?.(sql, params);
        return { rows: [] };
      }
      if (normalized.startsWith('insert into item_match_candidates')) {
        return {
          rows: [
            {
              bgg_id: params?.[3],
              discovery_item_candidate_id: params?.[0],
              id: 20,
              matched_name: params?.[4],
              source: params?.[1],
              status: 'PENDING'
            }
          ]
        };
      }
      return { rows: [] };
    }
  };
}

function bggThing({
  bggId,
  name,
  yearPublished
}: {
  bggId: number;
  name: string;
  yearPublished: number | null;
}) {
  return {
    alternateNames: [],
    artists: [],
    bggId,
    categories: [],
    description: '',
    designers: [],
    families: [],
    image: '',
    maxPlayers: null,
    maxPlaytime: null,
    mechanics: [],
    minAge: null,
    minPlayers: null,
    minPlaytime: null,
    name,
    playingTime: null,
    publishers: [],
    thumbnail: '',
    type: 'boardgame',
    yearPublished
  };
}
