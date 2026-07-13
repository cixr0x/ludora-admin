import { describe, expect, it } from 'vitest';

import type { BggClient } from '../bgg/bggClient.js';
import type { BggItemImporter } from '../bgg/bggItemImporter.js';
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

  it('matches local items by Spanish normalized name', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        const normalized = normalizeSql(sql);
        if (normalized.includes('from store_items')) {
          return { rows: [{ id: 50, item_type: 'base_game', publisher: '', title: 'Cafe Barista' }] };
        }
        if (normalized.includes('from items')) {
          return {
            rows: [
              {
                aliases: [],
                bgg_id: 377061,
                canonical_name: 'Coffee Rush',
                canonical_name_es: 'Cafe Barista',
                id: 77,
                item_type: 'base_game',
                normalized_name: 'coffee rush',
                normalized_name_es: 'cafe barista'
              }
            ]
          };
        }
        if (normalized.startsWith('insert into item_match_candidates')) {
          return {
            rows: [
              {
                discovery_item_candidate_id: params?.[0],
                id: 50,
                item_id: params?.[2],
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

    const result = await createItemMatchingService(database).generateMatchCandidates(50);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      item_id: 77,
      match_reasons: ['exact local Spanish item name match'],
      source: 'LOCAL'
    });
    const localQuery = queries.find((query) => normalizeSql(query.sql).includes('from items'));
    const sql = normalizeSql(localQuery?.sql ?? '');
    expect(sql).toContain('i.normalized_name_es = any($1::text[])');
    expect(localQuery?.params).toEqual([['cafe barista']]);
  });

  it('queries local item matches using language-edition title variants', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        const normalized = normalizeSql(sql);
        if (normalized.includes('from store_items')) {
          return {
            rows: [
              {
                id: 51,
                item_type: 'base_game',
                publisher: '',
                title: '7 Wonders: Architects (Español)'
              }
            ]
          };
        }
        if (normalized.includes('from items')) {
          return {
            rows: [
              {
                aliases: [],
                bgg_id: 346703,
                canonical_name: '7 Wonders: Architects',
                id: 77,
                item_type: 'base_game',
                normalized_name: '7 wonders architects'
              }
            ]
          };
        }
        if (normalized.startsWith('insert into item_match_candidates')) {
          return {
            rows: [
              {
                discovery_item_candidate_id: params?.[0],
                id: 51,
                item_id: params?.[2],
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

    const result = await createItemMatchingService(database).generateMatchCandidates(51);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      item_id: 77,
      match_reasons: ['exact local item name match after ignoring language edition'],
      source: 'LOCAL'
    });
    const localQuery = queries.find((query) => normalizeSql(query.sql).includes('from items'));
    const sql = normalizeSql(localQuery?.sql ?? '');
    expect(sql).toContain('i.normalized_name = any($1::text[])');
    expect(sql).toContain('ia.normalized_alias = any($1::text[])');
    expect(localQuery?.params).toEqual([['7 wonders architects espanol', '7 wonders architects']]);
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

  it('refreshes BGG search when a cached title overlap is below the acceptance threshold', async () => {
    const importedBggIds: number[] = [];
    const refreshedQueries: string[] = [];
    const updates: Array<{ params?: unknown[]; sql: string }> = [];
    const database = confirmMatchDatabase(
      {
        id: 14966,
        item_type: 'unknown',
        max_players: 5,
        min_players: 5,
        publisher: 'Asmodee',
        title: 'Star Wars: Imperial Assault'
      },
      [],
      {
        cachedSearchResults: [
          {
            bggId: 177086,
            name: 'Star Wars: Imperial Assault – Wookiee Warriors Ally Pack',
            type: 'boardgameexpansion',
            yearPublished: 2015
          }
        ],
        onStoreItemUpdate: (sql, params) => updates.push({ params, sql })
      }
    );
    const bggClient: BggClient = {
      fetchThing: async (bggId) => ({
        details: {
          ...bggThing({
            bggId,
            name:
              bggId === 164153
                ? 'Star Wars: Imperial Assault'
                : 'Star Wars: Imperial Assault – Wookiee Warriors Ally Pack',
            yearPublished: bggId === 164153 ? 2014 : 2015
          }),
          maxPlayers: 5,
          minPlayers: bggId === 164153 ? 1 : 2,
          publishers: []
        },
        rawXml: '<items />'
      }),
      search: async () => {
        throw new Error('regular BGG search should not run when the query cache is populated');
      },
      searchFresh: async (query) => {
        refreshedQueries.push(query);
        return [
          {
            bggId: 177086,
            name: 'Star Wars: Imperial Assault – Wookiee Warriors Ally Pack',
            type: 'boardgameexpansion',
            yearPublished: 2015
          },
          { bggId: 164153, name: 'Star Wars: Imperial Assault', type: 'boardgame', yearPublished: 2014 }
        ];
      }
    };
    const bggItemImporter: BggItemImporter = {
      importBggId: async (bggId) => {
        importedBggIds.push(bggId);
        return 3200;
      }
    };

    await createItemMatchingService(database, bggClient, undefined, bggItemImporter).confirmBoardgameAndMatch?.(14966);

    expect(refreshedQueries).toEqual(['Star Wars: Imperial Assault']);
    expect(importedBggIds).toEqual([164153]);
    const linkedUpdate = updates.find((update) => normalizeSql(update.sql).includes('set item_id = $1'));
    expect(linkedUpdate?.params?.slice(0, 5)).toEqual([3200, 'BGG', 164153, 'Star Wars: Imperial Assault', 0.92]);
  });

  it('matches direct BGG cache entries before calling the BGG API', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database = matchOnlyDatabase(
      { id: 54, item_type: 'base_game', publisher: '', title: '7 Wonders: Architects (Español)' },
      {
        directCacheResults: [{ bggId: 346703, name: '7 Wonders: Architects', type: 'boardgame', yearPublished: 2021 }],
        onQuery: (sql, params) => queries.push({ params, sql })
      }
    );
    const bggClient: BggClient = {
      fetchThing: async () => {
        throw new Error('BGG fetch API should not be called when direct BGG cache has a strong match');
      },
      search: async () => {
        throw new Error('BGG search API should not be called when direct BGG cache has a strong match');
      }
    };

    const result = await createItemMatchingService(database, bggClient).generateMatchCandidates(54);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      bgg_id: 346703,
      match_reasons: ['exact BGG primary name match after ignoring language edition'],
      matched_name: '7 Wonders: Architects',
      source: 'BGG'
    });
    expect(result[0].match_score).toBeGreaterThanOrEqual(0.9);
    const directCacheQuery = queries.find((query) => normalizeSql(query.sql).startsWith('select bgg_id, name'));
    expect(normalizeSql(directCacheQuery?.sql ?? '')).toContain('from bgg_search_cache');
    expect(directCacheQuery?.params?.[0]).toEqual(['boardgame', 'boardgameexpansion']);
    expect(directCacheQuery?.params).toContain('%7%wonders%architects%');
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

  it('confirms and links the best local item without searching BGG', async () => {
    const updates: Array<{ params?: unknown[]; sql: string }> = [];
    const database = confirmMatchDatabase(
      {
        id: 48,
        item_type: 'base_game',
        max_players: 4,
        min_players: 2,
        publisher: 'Korea Boardgames',
        title: 'Coffee Rush'
      },
      [
        {
          aliases: [],
          bgg_id: 377061,
          canonical_name: 'Coffee Rush',
          id: 77,
          item_type: 'base_game',
          normalized_name: 'coffee rush'
        }
      ],
      {
        onStoreItemUpdate: (sql, params) => updates.push({ params, sql })
      }
    );
    const bggClient: BggClient = {
      fetchThing: async () => {
        throw new Error('BGG fetch should not run when local match is high confidence');
      },
      search: async () => {
        throw new Error('BGG search should not run when local match is high confidence');
      }
    };

    await createItemMatchingService(database, bggClient).confirmBoardgameAndMatch?.(48);

    const linkedUpdate = updates.find((update) => normalizeSql(update.sql).includes('set item_id = $1'));
    expect(normalizeSql(linkedUpdate?.sql ?? '')).not.toContain('listing_status');
    expect(normalizeSql(linkedUpdate?.sql ?? '')).not.toContain("status = 'listed'");
    expect(linkedUpdate?.params).toEqual([
      77,
      'LOCAL',
      377061,
      'Coffee Rush',
      0.94,
      JSON.stringify(['exact local item name match']),
      JSON.stringify({
        item: {
          aliases: [],
          bggId: 377061,
          id: 77,
          itemType: 'base_game',
          name: 'Coffee Rush',
          normalizedName: 'coffee rush'
        }
      }),
      48
    ]);
  });

  it('links but does not confirm an automatic local match without a BGG id', async () => {
    const updates: Array<{ params?: unknown[]; sql: string }> = [];
    const database = confirmMatchDatabase(
      {
        id: 54,
        item_type: 'base_game',
        max_players: 4,
        min_players: 2,
        publisher: '',
        title: 'Local Manual Game'
      },
      [
        {
          aliases: [],
          bgg_id: null,
          canonical_name: 'Local Manual Game',
          id: 91,
          item_type: 'base_game',
          normalized_name: 'local manual game'
        }
      ],
      {
        onStoreItemUpdate: (sql, params) => updates.push({ params, sql })
      }
    );
    const bggClient: BggClient = {
      fetchThing: async () => {
        throw new Error('BGG fetch should not run when local match is high confidence');
      },
      search: async () => {
        throw new Error('BGG search should not run when local match is high confidence');
      }
    };

    await createItemMatchingService(database, bggClient).confirmBoardgameAndMatch?.(54);

    const linkedUpdate = updates.find((update) => normalizeSql(update.sql).includes('set item_id = $1'));
    expect(normalizeSql(linkedUpdate?.sql ?? '')).toContain('is_boardgame_confirmed = false');
    expect(linkedUpdate?.params?.slice(0, 4)).toEqual([91, 'LOCAL', null, 'Local Manual Game']);
  });

  it('confirms, imports, and links a cached BGG match before calling the BGG search API', async () => {
    const importedBggIds: number[] = [];
    const updates: Array<{ params?: unknown[]; sql: string }> = [];
    const database = confirmMatchDatabase(
      {
        id: 49,
        item_type: 'base_game',
        max_players: 4,
        min_players: 2,
        publisher: 'Korea Boardgames',
        title: 'Coffee Rush'
      },
      [],
      {
        cachedSearchResults: [{ bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 }],
        onStoreItemUpdate: (sql, params) => updates.push({ params, sql })
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
    const bggItemImporter: BggItemImporter = {
      importBggId: async (bggId) => {
        importedBggIds.push(bggId);
        return 88;
      }
    };

    await createItemMatchingService(database, bggClient, undefined, bggItemImporter).confirmBoardgameAndMatch?.(49);

    expect(importedBggIds).toEqual([377061]);
    const linkedUpdate = updates.find((update) => normalizeSql(update.sql).includes('set item_id = $1'));
    expect(normalizeSql(linkedUpdate?.sql ?? '')).not.toContain('listing_status');
    expect(normalizeSql(linkedUpdate?.sql ?? '')).not.toContain("status = 'listed'");
    expect(linkedUpdate?.params?.slice(0, 6)).toEqual([
      88,
      'BGG',
      377061,
      'Coffee Rush',
      0.9,
      JSON.stringify(['exact BGG primary name match'])
    ]);
  });

  it('logs each automated boardgame matching step', async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const database = confirmMatchDatabase(
      {
        id: 49,
        item_type: 'base_game',
        max_players: 4,
        min_players: 2,
        publisher: 'Korea Boardgames',
        title: 'Coffee Rush'
      },
      [],
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
    const bggItemImporter: BggItemImporter = {
      importBggId: async () => 88
    };
    const traceLogger = {
      log: (event: string, fields: Record<string, unknown> = {}) => {
        events.push({ event, fields });
      }
    };

    await createItemMatchingService(database, bggClient, undefined, bggItemImporter).confirmBoardgameAndMatch?.(49, {
      confirmationSource: 'automated',
      traceLogger
    });

    expect(events.map((event) => event.event)).toEqual([
      'item_matcher.confirm.start',
      'item_matcher.candidate.loaded',
      'item_matcher.boardgame.confirmed',
      'item_matcher.local_match.start',
      'item_matcher.local_match.completed',
      'item_matcher.bgg_match.start',
      'item_matcher.bgg_cache.start',
      'item_matcher.bgg_cache.completed',
      'item_matcher.bgg_search.start',
      'item_matcher.bgg_search.completed',
      'item_matcher.bgg_thing_fetch.start',
      'item_matcher.bgg_thing_fetch.completed',
      'item_matcher.bgg_match.completed',
      'item_matcher.bgg_import.start',
      'item_matcher.bgg_import.completed',
      'item_matcher.link.completed',
      'item_matcher.confirm.completed'
    ]);
    expect(events[0].fields).toMatchObject({ candidate_id: 49, confirmation_source: 'automated' });
    expect(events[1].fields).toMatchObject({ candidate_id: 49, title: 'Coffee Rush' });
    expect(events[4].fields).toMatchObject({ best_score: null, candidate_id: 49, match_count: 0 });
    expect(events[9].fields).toMatchObject({ query: 'Coffee Rush', result_count: 1, source: 'cache' });
    expect(events[12].fields).toMatchObject({ best_bgg_id: 377061, best_score: 0.9, match_count: 1 });
    expect(events[14].fields).toMatchObject({ bgg_id: 377061, item_id: 88 });
  });

  it('does not mark a boardgame as confirmed when no item match is found', async () => {
    const updates: Array<{ params?: unknown[]; sql: string }> = [];
    const database = confirmMatchDatabase(
      {
        id: 50,
        item_type: 'base_game',
        max_players: 4,
        min_players: 2,
        publisher: '',
        title: 'Unknown Game'
      },
      [],
      {
        cachedSearchResults: [],
        onStoreItemUpdate: (sql, params) => updates.push({ params, sql })
      }
    );
    const bggClient: BggClient = {
      fetchThing: async () => {
        throw new Error('BGG fetch should not run without search results');
      },
      search: async () => []
    };

    await createItemMatchingService(database, bggClient).confirmBoardgameAndMatch?.(50);

    expect(updates.some((update) => normalizeSql(update.sql).includes('set item_id = $1'))).toBe(false);
    expect(updates.every((update) => !normalizeSql(update.sql).includes('is_boardgame_confirmed = true'))).toBe(true);
    const noMatchUpdate = updates.find((update) => normalizeSql(update.sql).includes("match_source = 'none'"));
    expect(normalizeSql(noMatchUpdate?.sql ?? '')).toContain('is_boardgame_confirmed = false');
    expect(noMatchUpdate?.params).toEqual([JSON.stringify(['no match above threshold']), 50]);
  });

  it('keeps admin-confirmed boardgames confirmed when no item match is found', async () => {
    const updates: Array<{ params?: unknown[]; sql: string }> = [];
    const database = confirmMatchDatabase(
      {
        id: 52,
        item_type: 'base_game',
        max_players: 4,
        min_players: 2,
        publisher: '',
        title: 'Unknown Game'
      },
      [],
      {
        cachedSearchResults: [],
        onStoreItemUpdate: (sql, params) => updates.push({ params, sql })
      }
    );
    const bggClient: BggClient = {
      fetchThing: async () => {
        throw new Error('BGG fetch should not run without search results');
      },
      search: async () => []
    };
    const service = createItemMatchingService(database, bggClient) as ReturnType<typeof createItemMatchingService> & {
      confirmBoardgameAndMatch(discoveryItemCandidateId: number, options: { confirmationSource: 'admin' }): Promise<void>;
    };

    await service.confirmBoardgameAndMatch(52, { confirmationSource: 'admin' });

    expect(updates.some((update) => normalizeSql(update.sql).includes('set item_id = $1'))).toBe(false);
    const noMatchUpdate = updates.find((update) => normalizeSql(update.sql).includes("match_source = 'none'"));
    expect(normalizeSql(noMatchUpdate?.sql ?? '')).toContain('is_boardgame_confirmed = true');
    expect(noMatchUpdate?.params).toEqual([JSON.stringify(['no match above threshold']), 52]);
  });

  it('does not mark a boardgame as confirmed when automatic matching errors before linking an item', async () => {
    const updates: Array<{ params?: unknown[]; sql: string }> = [];
    const database = confirmMatchDatabase(
      {
        id: 51,
        item_type: 'base_game',
        max_players: 4,
        min_players: 2,
        publisher: '',
        title: 'Rate Limited Game'
      },
      [],
      {
        onStoreItemUpdate: (sql, params) => updates.push({ params, sql })
      }
    );
    const bggClient: BggClient = {
      fetchThing: async () => {
        throw new Error('BGG fetch should not run when search fails');
      },
      search: async () => {
        throw new Error('BGG API request failed with 429');
      }
    };

    await createItemMatchingService(database, bggClient).confirmBoardgameAndMatch?.(51);

    expect(updates.some((update) => normalizeSql(update.sql).includes('set item_id = $1'))).toBe(false);
    expect(updates.every((update) => !normalizeSql(update.sql).includes('is_boardgame_confirmed = true'))).toBe(true);
    const errorUpdate = updates.find((update) => normalizeSql(update.sql).includes('processing_error = $1'));
    expect(normalizeSql(errorUpdate?.sql ?? '')).toContain('is_boardgame_confirmed = false');
    expect(errorUpdate?.params).toEqual(['BGG API request failed with 429', 51]);
  });

  it('keeps admin-confirmed boardgames confirmed when matching errors before linking an item', async () => {
    const updates: Array<{ params?: unknown[]; sql: string }> = [];
    const database = confirmMatchDatabase(
      {
        id: 53,
        item_type: 'base_game',
        max_players: 4,
        min_players: 2,
        publisher: '',
        title: 'Rate Limited Game'
      },
      [],
      {
        onStoreItemUpdate: (sql, params) => updates.push({ params, sql })
      }
    );
    const bggClient: BggClient = {
      fetchThing: async () => {
        throw new Error('BGG fetch should not run when search fails');
      },
      search: async () => {
        throw new Error('BGG API request failed with 429');
      }
    };
    const service = createItemMatchingService(database, bggClient) as ReturnType<typeof createItemMatchingService> & {
      confirmBoardgameAndMatch(discoveryItemCandidateId: number, options: { confirmationSource: 'admin' }): Promise<void>;
    };

    await service.confirmBoardgameAndMatch(53, { confirmationSource: 'admin' });

    expect(updates.some((update) => normalizeSql(update.sql).includes('set item_id = $1'))).toBe(false);
    const errorUpdate = updates.find((update) => normalizeSql(update.sql).includes('processing_error = $1'));
    expect(normalizeSql(errorUpdate?.sql ?? '')).toContain('is_boardgame_confirmed = true');
    expect(errorUpdate?.params).toEqual(['BGG API request failed with 429', 53]);
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
    directCacheResults?: unknown[];
    onCacheWrite?: (sql: string, params: unknown[] | undefined) => void;
    onQuery?: (sql: string, params: unknown[] | undefined) => void;
  } = {}
): Database {
  return {
    query: async (sql, params) => {
      options.onQuery?.(sql, params);
      const normalized = normalizeSql(sql);
      if (normalized.includes('from store_items')) {
        return { rows: [candidate] };
      }
      if (normalized.includes('from items')) {
        return { rows: [] };
      }
      if (normalized.includes('from bgg_search_cache')) {
        return {
          rows: (options.directCacheResults ?? []).map((item) => {
            const row = item as Record<string, unknown>;
            return {
              bgg_id: row.bggId ?? row.bgg_id,
              item_type: row.type ?? row.item_type,
              name: row.name,
              result_json: row.resultJson ?? row.result_json ?? row,
              year_published: row.yearPublished ?? row.year_published
            };
          })
        };
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
              match_reasons: JSON.parse(String(params?.[6] ?? '[]')) as unknown,
              match_score: params?.[5],
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

function confirmMatchDatabase(
  candidate: Record<string, unknown>,
  localRows: Record<string, unknown>[],
  options: {
    cachedSearchResults?: unknown[];
    onStoreItemUpdate?: (sql: string, params: unknown[] | undefined) => void;
  } = {}
): Database {
  return {
    query: async (sql, params) => {
      const normalized = normalizeSql(sql);
      if (normalized.includes('from store_items')) {
        return { rows: [candidate] };
      }
      if (normalized.includes('from items')) {
        return { rows: localRows };
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
      if (normalized.startsWith('update store_items')) {
        options.onStoreItemUpdate?.(sql, params);
        return { rows: [] };
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
