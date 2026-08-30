import { describe, expect, it, vi } from 'vitest';

import {
  createAiBggMatchingService,
  type AiBggMatchDecision,
  type AiBggMatchFound,
  type AiBggMatchingService
} from '../aiBggMatching/aiBggMatchingService.js';
import type { BggClient } from '../bgg/bggClient.js';
import type { BggItemImporter } from '../bgg/bggItemImporter.js';
import type { BggMatchCache } from '../bgg/bggMatchCache.js';
import type { BggSearchItem, BggThingDetails } from '../bgg/bggParser.js';
import type {
  AutoListEvaluationResult,
  AutoListEvaluationService
} from '../autoListEvaluation/autoListEvaluationService.js';
import type { Database } from '../db.js';
import type { TraceLogger } from '../trace.js';
import { createItemMatchingService } from './itemMatchingService.js';

describe('item matching service', () => {
  it('loads image and store context for matching', async () => {
    const queries: RecordedQuery[] = [];
    const database = matchingDatabase(storeItemCandidate(), [], {
      onQuery: (query) => queries.push(query)
    });

    await createItemMatchingService(database, dependencies()).generateMatchCandidates(42);

    const candidateQuery = queries.find((query) => normalizeSql(query.sql).includes('from store_items'));
    expect(normalizeSql(candidateQuery?.sql ?? '')).toContain(
      'select si.id, si.title, si.image_url, si.publisher, si.item_type, si.min_players, si.max_players, si.language, si.is_boardgame_confirmed, si.match_source, si.processing_error, s.name as store_name'
    );
    expect(normalizeSql(candidateQuery?.sql ?? '')).toContain('left join stores s on s.id = si.store_id');
  });

  it('does not call AI when a local item is accepted', async () => {
    const updates: RecordedQuery[] = [];
    const database = matchingDatabase(
      storeItemCandidate(),
      [localItemRow()],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );
    const ai = aiService();
    const cache = matchCache();
    const bggClient = clientWithThing(null);
    const autoList = autoListService();
    const service = createItemMatchingService(database, dependencies({ ai, autoList, bggClient, cache }));

    await service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(ai.findMatch).not.toHaveBeenCalled();
    expect(cache.lookup).not.toHaveBeenCalled();
    expect(bggClient.searchFresh).not.toHaveBeenCalled();
    expect(linkUpdate(updates)?.params?.slice(0, 4)).toEqual([77, 'LOCAL', 377061, 'Coffee Rush']);
    expect(autoList.evaluateLinkedStoreItem).toHaveBeenCalledWith(42, 77);
  });

  it('logs that auto-list evaluation was skipped when the matched item has no generated translation', async () => {
    const events: TraceEvent[] = [];
    const autoList = skippedAutoListService();
    const service = createItemMatchingService(
      matchingDatabase(storeItemCandidate(), [localItemRow()]),
      dependencies({ autoList })
    );

    await service.confirmBoardgameAndMatch?.(42, {
      confirmationSource: 'automated',
      traceLogger: { log: (event, fields = {}) => events.push({ event, fields }) }
    });

    expect(autoList.evaluateLinkedStoreItem).toHaveBeenCalledWith(42, 77);
    expect(traceFields(events, 'auto_list_evaluation.skipped')).toEqual({
      item_id: 77,
      reason: 'TRANSLATION_NOT_GENERATED',
      store_item_id: 42
    });
    expect(events.map(({ event }) => event)).not.toContain('auto_list_evaluation.completed');
  });

  it('retrieves token candidates and accepts a local title surrounded by listing context', async () => {
    const queries: RecordedQuery[] = [];
    const updates: RecordedQuery[] = [];
    const database = matchingDatabase(
      storeItemCandidate({
        publisher: 'Devir',
        store_name: 'Amazon México',
        title: 'Amazon México Devir Catan Juego de Mesa Edición en Español Original'
      }),
      [localItemRow({
        bgg_id: 13,
        canonical_name: 'Catan',
        id: 13,
        normalized_name: 'catan',
        publishers: ['Devir']
      })],
      {
        onQuery: (query) => queries.push(query),
        onStoreItemUpdate: (query) => updates.push(query)
      }
    );
    const ai = aiService();
    const cache = matchCache();

    await createItemMatchingService(database, dependencies({ ai, cache }))
      .confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    const localQuery = queries.find((query) => normalizeSql(query.sql).startsWith('with local_names as'));
    expect(normalizeSql(localQuery?.sql ?? '')).toContain("string_to_array(normalized_match_name, ' ') && $2::text[]");
    expect(localQuery?.params?.[1]).toEqual(['catan']);
    expect(linkUpdate(updates)?.params?.slice(0, 5)).toEqual([13, 'LOCAL', 13, 'Catan', 0.92]);
    expect(cache.lookup).not.toHaveBeenCalled();
    expect(ai.findMatch).not.toHaveBeenCalled();
  });

  it('uses a trusted Spanish cache association without AI', async () => {
    const updates: RecordedQuery[] = [];
    const database = matchingDatabase(
      storeItemCandidate({ title: 'La Guerra del Anillo' }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );
    const ai = aiService();
    const cache = matchCache({
      cacheHit: true,
      matches: [{ item: bggSearchItem(), verifiedByAi: true }]
    });
    const importer = itemImporter(88);
    const service = createItemMatchingService(database, dependencies({ ai, cache, importer }));

    await service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(cache.lookup).toHaveBeenCalledWith('La Guerra del Anillo', {
      imageUrl: 'https://store.mx/coffee-rush.jpg'
    });
    expect(ai.findMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).toHaveBeenCalledWith(115746);
    expect(linkUpdate(updates)?.params?.slice(0, 6)).toEqual([
      88,
      'BGG',
      115746,
      'War of the Ring: Second Edition',
      0.9,
      JSON.stringify(['AI-verified BGG cache association', 'no exact BGG name match'])
    ]);
  });

  it('accepts a deterministic cache match without AI', async () => {
    const database = matchingDatabase(storeItemCandidate({ title: 'Coffee Rush' }));
    const ai = aiService();
    const cache = matchCache({
      cacheHit: true,
      matches: [{ item: bggSearchItem(377061, 'Coffee Rush', 2023), verifiedByAi: false }]
    });
    const importer = itemImporter(88);
    const bggClient = clientWithThing(null);

    await createItemMatchingService(database, dependencies({ ai, bggClient, cache, importer }))
      .confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(cache.lookup).toHaveBeenCalledWith('Coffee Rush', {
      imageUrl: 'https://store.mx/coffee-rush.jpg'
    });
    expect(bggClient.searchFresh).not.toHaveBeenCalled();
    expect(ai.findMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).toHaveBeenCalledWith(377061);
  });

  it('uses an accepted fresh BGG result before AI', async () => {
    const updates: RecordedQuery[] = [];
    const events: TraceEvent[] = [];
    const ai = aiService(null);
    const cache = matchCache({
      cacheHit: true,
      matches: [{ item: bggSearchItem(999, 'Coffee Rush: Expansion', 2024), verifiedByAi: false }]
    });
    const freshThing = bggThingDetails({
      bggId: 377061,
      name: 'Coffee Rush',
      yearPublished: 2023
    });
    const bggClient = clientWithFreshSearch(
      [bggSearchItem(377061, 'Coffee Rush', 2023)],
      new Map([[377061, freshThing]])
    );
    const importer = itemImporter(88);
    const database = matchingDatabase(storeItemCandidate({ title: 'Coffee Rush' }), [], {
      onStoreItemUpdate: (query) => updates.push(query)
    });

    await createItemMatchingService(database, dependencies({ ai, bggClient, cache, importer }))
      .confirmBoardgameAndMatch?.(42, {
        confirmationSource: 'automated',
        traceLogger: { log: (event, fields = {}) => events.push({ event, fields }) }
      });

    expect(bggClient.searchFresh).toHaveBeenCalledOnce();
    expect(bggClient.searchFresh).toHaveBeenCalledWith('Coffee Rush');
    expect(bggClient.search).not.toHaveBeenCalled();
    expect(ai.findMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).toHaveBeenCalledWith(377061);
    expect(linkUpdate(updates)?.params?.slice(0, 4)).toEqual([88, 'BGG', 377061, 'Coffee Rush']);
    expect(traceFields(events, 'item_matcher.bgg_live_search.completed')).toEqual({
      accepted_bgg_id: 377061,
      accepted_match: true,
      candidate_id: 42,
      evaluated_count: 1,
      result_count: 1
    });
    expect(events.map(({ event }) => event)).not.toContain('item_matcher.ai_match.start');
  });

  it('prioritizes an exact live title beyond the first ten search results', async () => {
    const unrelated = Array.from({ length: 11 }, (_, index) =>
      bggSearchItem(1000 + index, `Different Game ${index}`, 2000 + index)
    );
    const exact = bggSearchItem(377061, 'Coffee Rush', 2023);
    const bggClient = clientWithFreshSearch(
      [...unrelated, exact],
      new Map([[377061, bggThingDetails({ bggId: 377061, name: 'Coffee Rush', yearPublished: 2023 })]])
    );
    const ai = aiService(null);

    await createItemMatchingService(
      matchingDatabase(storeItemCandidate({ title: 'Coffee Rush' })),
      dependencies({ ai, bggClient, cache: matchCache(), importer: itemImporter(88) })
    ).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(bggClient.fetchThing).toHaveBeenCalledTimes(1);
    expect(bggClient.fetchThing).toHaveBeenCalledWith(377061);
    expect(ai.findMatch).not.toHaveBeenCalled();
  });

  it('deduplicates live IDs and evaluates at most ten Things', async () => {
    const searchResults = [
      bggSearchItem(1000, 'Different Game 0', 2000),
      bggSearchItem(1000, 'Different Game 0', 2000),
      ...Array.from({ length: 11 }, (_, index) =>
        bggSearchItem(1001 + index, `Different Game ${index + 1}`, 2001 + index)
      )
    ];
    const things = new Map<number, BggThingDetails | null>(
      searchResults.map((result) => [
        result.bggId,
        bggThingDetails({ bggId: result.bggId, name: result.name, maxPlayers: null, minPlayers: null })
      ])
    );
    const bggClient = clientWithFreshSearch(searchResults, things);

    await createItemMatchingService(
      matchingDatabase(storeItemCandidate({ title: 'Unmatched Store Title' })),
      dependencies({ ai: aiService(null), bggClient, cache: matchCache() })
    ).generateMatchCandidates(42);

    expect(bggClient.fetchThing).toHaveBeenCalledTimes(10);
    expect(vi.mocked(bggClient.fetchThing).mock.calls.filter(([id]) => id === 1000)).toHaveLength(1);
  });

  it('accepts a live match from a full Thing alternate name', async () => {
    const ai = aiService(null);
    const bggClient = clientWithFreshSearch(
      [bggSearchItem(115746, 'War of the Ring: Second Edition', 2011)],
      new Map([[115746, bggThingDetails({ alternateNames: ['La Guerra del Anillo'] })]])
    );

    await createItemMatchingService(
      matchingDatabase(storeItemCandidate({ title: 'La Guerra del Anillo' })),
      dependencies({ ai, bggClient, cache: matchCache(), importer: itemImporter(88) })
    ).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(ai.findMatch).not.toHaveBeenCalled();
  });

  it('rejects an exact live title when the BGG Thing type conflicts', async () => {
    const ai = aiService(null);
    const bggClient = clientWithFreshSearch(
      [bggSearchItem(377061, 'Coffee Rush', 2023)],
      new Map([[
        377061,
        bggThingDetails({ bggId: 377061, name: 'Coffee Rush', type: 'boardgameexpansion' })
      ]])
    );

    await createItemMatchingService(
      matchingDatabase(storeItemCandidate({ item_type: 'base_game', title: 'Coffee Rush' })),
      dependencies({ ai, bggClient, cache: matchCache() })
    ).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(ai.findMatch).toHaveBeenCalledOnce();
  });

  it('continues to AI when fresh BGG results stay below the deterministic threshold', async () => {
    const ai = aiService(aiMatchFound());
    const bggClient = clientWithFreshSearch(
      [bggSearchItem(999, 'War Ring Card Game', 2010)],
      new Map([
        [999, bggThingDetails({ bggId: 999, name: 'War Ring Card Game', type: 'boardgame' })],
        [115746, bggThingDetails()]
      ])
    );

    await createItemMatchingService(
      matchingDatabase(storeItemCandidate({ title: 'La Guerra del Anillo' })),
      dependencies({ ai, bggClient, cache: matchCache(), importer: itemImporter(88) })
    ).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(bggClient.searchFresh).toHaveBeenCalledWith('La Guerra del Anillo');
    expect(ai.findMatch).toHaveBeenCalledOnce();
  });

  it('continues to AI when fresh BGG search fails', async () => {
    const events: TraceEvent[] = [];
    const ai = aiService(aiMatchFound());
    const bggClient = clientWithFreshSearch([], new Map([[115746, bggThingDetails()]]));
    vi.mocked(bggClient.searchFresh!).mockRejectedValueOnce(new Error('BGG temporarily unavailable'));

    await createItemMatchingService(
      matchingDatabase(storeItemCandidate({ title: 'La Guerra del Anillo' })),
      dependencies({ ai, bggClient, cache: matchCache(), importer: itemImporter(88) })
    ).confirmBoardgameAndMatch?.(42, {
      confirmationSource: 'automated',
      traceLogger: { log: (event, fields = {}) => events.push({ event, fields }) }
    });

    expect(bggClient.search).not.toHaveBeenCalled();
    expect(ai.findMatch).toHaveBeenCalledOnce();
    expect(traceFields(events, 'item_matcher.bgg_live_search.failed')).toEqual({
      candidate_id: 42,
      error: 'Live BGG search failed',
      stage: 'search'
    });
  });

  it('continues to AI and traces a sanitized failure when a live Thing fetch fails', async () => {
    const events: TraceEvent[] = [];
    const ai = aiService(null);
    const bggClient = clientWithFreshSearch(
      [bggSearchItem(377061, 'Coffee Rush', 2023)],
      new Map()
    );
    vi.mocked(bggClient.fetchThing).mockRejectedValueOnce(new Error('private upstream response text'));

    await createItemMatchingService(
      matchingDatabase(storeItemCandidate({ title: 'Coffee Rush' })),
      dependencies({ ai, bggClient, cache: matchCache() })
    ).confirmBoardgameAndMatch?.(42, {
      confirmationSource: 'automated',
      traceLogger: { log: (event, fields = {}) => events.push({ event, fields }) }
    });

    expect(ai.findMatch).toHaveBeenCalledOnce();
    expect(traceFields(events, 'item_matcher.bgg_live_search.failed')).toEqual({
      bgg_id: 377061,
      candidate_id: 42,
      error: 'BGG Thing fetch failed',
      stage: 'thing_fetch'
    });
    expect(JSON.stringify(events)).not.toContain('private upstream response text');
  });

  it('continues to AI without using cached search when searchFresh is unavailable', async () => {
    const events: TraceEvent[] = [];
    const ai = aiService(aiMatchFound());
    const bggClient: BggClient = {
      fetchThing: vi.fn().mockResolvedValue({ details: bggThingDetails(), rawXml: '<items />' }),
      search: vi.fn().mockRejectedValue(new Error('Cached search must remain unused'))
    };

    await createItemMatchingService(
      matchingDatabase(storeItemCandidate({ title: 'La Guerra del Anillo' })),
      dependencies({ ai, bggClient, cache: matchCache(), importer: itemImporter(88) })
    ).confirmBoardgameAndMatch?.(42, {
      confirmationSource: 'automated',
      traceLogger: { log: (event, fields = {}) => events.push({ event, fields }) }
    });

    expect(bggClient.search).not.toHaveBeenCalled();
    expect(ai.findMatch).toHaveBeenCalledOnce();
    expect(traceFields(events, 'item_matcher.bgg_live_search.failed')).toEqual({
      candidate_id: 42,
      error: 'Fresh BGG search is not configured',
      stage: 'search'
    });
  });

  it('validates, caches, imports, and links an AI match after no accepted cache result', async () => {
    const updates: RecordedQuery[] = [];
    const database = matchingDatabase(
      storeItemCandidate({
        image_url: 'https://store.mx/guerra-del-anillo.jpg',
        title: 'La Guerra del Anillo'
      }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );
    const decision = aiMatchFound();
    const ai = aiService(decision);
    const cache = matchCache({
      cacheHit: true,
      matches: [{ item: bggSearchItem(999, 'War Ring Card Game', 2010), verifiedByAi: false }]
    });
    const bggClient = clientWithThing(bggThingDetails());
    const importer = itemImporter(88);

    await createItemMatchingService(database, dependencies({ ai, bggClient, cache, importer }))
      .confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(cache.lookup).toHaveBeenCalledWith('La Guerra del Anillo', {
      imageUrl: 'https://store.mx/guerra-del-anillo.jpg'
    });
    expect(ai.findMatch).toHaveBeenCalledWith({
      itemName: 'La Guerra del Anillo',
      imageUrl: 'https://store.mx/guerra-del-anillo.jpg'
    });
    expect(bggClient.fetchThing).toHaveBeenCalledWith(115746);
    expect(cache.recordAiMatch).toHaveBeenCalledWith(
      ['La Guerra del Anillo', 'War of the Ring: Second Edition'],
      { bggId: 115746, name: 'War of the Ring: Second Edition', type: 'boardgame', yearPublished: 2011 },
      { imageUrl: 'https://store.mx/guerra-del-anillo.jpg' }
    );
    expect(importer.importBggId).toHaveBeenCalledWith(115746);
    expect(linkUpdate(updates)?.params?.slice(0, 5)).toEqual([
      88,
      'BGG',
      115746,
      'War of the Ring: Second Edition',
      0.83
    ]);
  });

  it('forces a fresh AI match for an already-linked store item', async () => {
    const queries: RecordedQuery[] = [];
    const updates: RecordedQuery[] = [];
    const database = matchingDatabase(
      storeItemCandidate({
        image_url: 'https://store.mx/guerra-del-anillo.jpg',
        item_id: 77,
        match_source: 'LOCAL',
        title: 'La Guerra del Anillo'
      }),
      [localItemRow()],
      {
        onQuery: (query) => queries.push(query),
        onStoreItemUpdate: (query) => updates.push(query)
      }
    );
    const ai = aiService(aiMatchFound());
    const cache = matchCache({
      cacheHit: true,
      matches: [{ item: bggSearchItem(999, 'Wrong Game', 2010), verifiedByAi: true }]
    });
    const importer = itemImporter(88);
    const bggClient = clientWithThing(bggThingDetails());
    const service = createItemMatchingService(
      database,
      dependencies({ ai, bggClient, cache, importer })
    );

    const result = await service.matchWithAi?.(42);

    expect(cache.lookup).not.toHaveBeenCalled();
    expect(bggClient.searchFresh).not.toHaveBeenCalled();
    expect(bggClient.search).not.toHaveBeenCalled();
    expect(queries.some((query) => normalizeSql(query.sql).includes('from items'))).toBe(false);
    expect(ai.findMatch).toHaveBeenCalledOnce();
    expect(ai.findMatch).toHaveBeenCalledWith({
      itemName: 'La Guerra del Anillo',
      imageUrl: 'https://store.mx/guerra-del-anillo.jpg'
    });
    expect(cache.recordAiMatch).toHaveBeenCalledWith(
      ['La Guerra del Anillo', 'War of the Ring: Second Edition'],
      { bggId: 115746, name: 'War of the Ring: Second Edition', type: 'boardgame', yearPublished: 2011 },
      { imageUrl: 'https://store.mx/guerra-del-anillo.jpg' }
    );
    expect(importer.importBggId).toHaveBeenCalledWith(115746);
    expect(linkUpdate(updates)?.params?.slice(0, 5)).toEqual([
      88,
      'BGG',
      115746,
      'War of the Ring: Second Edition',
      0.83
    ]);
    expect(result).toEqual({
      status: 'matched',
      itemId: 88,
      bggId: 115746,
      matchedName: 'War of the Ring: Second Edition'
    });
  });

  it('allows a manual AI match without a store item image', async () => {
    const ai = aiService(aiMatchFound());
    const service = createItemMatchingService(
      matchingDatabase(storeItemCandidate({ image_url: null, title: 'Coffee Rush' })),
      dependencies({
        ai,
        bggClient: clientWithThing(bggThingDetails()),
        importer: itemImporter(88)
      })
    );

    const result = await service.matchWithAi?.(42);

    expect(ai.findMatch).toHaveBeenCalledWith({ itemName: 'Coffee Rush', imageUrl: null });
    expect(result).toMatchObject({ status: 'matched', itemId: 88, bggId: 115746 });
  });

  it('preserves the current association when manual AI finds no match', async () => {
    const queries: RecordedQuery[] = [];
    const updates: RecordedQuery[] = [];
    const cache = matchCache();
    const importer = itemImporter(88);
    const service = createItemMatchingService(
      matchingDatabase(storeItemCandidate({ item_id: 77, match_source: 'LOCAL', title: 'Unknown Game' }), [], {
        onQuery: (query) => queries.push(query),
        onStoreItemUpdate: (query) => updates.push(query)
      }),
      dependencies({ ai: aiService(null), bggClient: clientWithThing(bggThingDetails()), cache, importer })
    );

    const result = await service.matchWithAi?.(42);

    expect(result).toEqual({ status: 'not_found' });
    expect(cache.lookup).not.toHaveBeenCalled();
    expect(cache.recordAiMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(normalizeSql(queries[0]?.sql ?? '')).toContain('from store_items');
  });

  it('preserves the current association when the manual AI request fails', async () => {
    const updates: RecordedQuery[] = [];
    const service = createItemMatchingService(
      matchingDatabase(storeItemCandidate({ item_id: 77 }), [], {
        onStoreItemUpdate: (query) => updates.push(query)
      }),
      dependencies({
        ai: aiServiceRejecting(new Error('CodexAPI unavailable')),
        bggClient: clientWithThing(bggThingDetails()),
        importer: itemImporter(88)
      })
    );

    await expect(service.matchWithAi?.(42)).rejects.toThrow('CodexAPI unavailable');
    expect(linkUpdate(updates)).toBeUndefined();
  });

  it('preserves the current association when manual BGG validation finds no match', async () => {
    const updates: RecordedQuery[] = [];
    const cache = matchCache();
    const importer = itemImporter(88);
    const bggClient = clientWithThing(null);
    vi.mocked(bggClient.searchFresh!).mockResolvedValue([]);
    const service = createItemMatchingService(
      matchingDatabase(storeItemCandidate({ item_id: 77 }), [], {
        onStoreItemUpdate: (query) => updates.push(query)
      }),
      dependencies({ ai: aiService(aiMatchFound()), bggClient, cache, importer })
    );

    await expect(service.matchWithAi?.(42)).resolves.toEqual({ status: 'not_found' });
    expect(cache.recordAiMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('preserves the current association when a BGG validation request throws', async () => {
    const updates: RecordedQuery[] = [];
    const bggClient = clientWithThing(null);
    vi.mocked(bggClient.fetchThing).mockRejectedValueOnce(new Error('BGG unavailable'));
    const service = createItemMatchingService(
      matchingDatabase(storeItemCandidate({ item_id: 77 }), [], {
        onStoreItemUpdate: (query) => updates.push(query)
      }),
      dependencies({ ai: aiService(aiMatchFound()), bggClient, importer: itemImporter(88) })
    );

    await expect(service.matchWithAi?.(42)).rejects.toThrow('BGG unavailable');
    expect(linkUpdate(updates)).toBeUndefined();
  });

  it('preserves the current association when positive cache persistence fails', async () => {
    const updates: RecordedQuery[] = [];
    const cache = matchCache();
    vi.mocked(cache.recordAiMatch).mockRejectedValue(new Error('Cache failed'));
    const importer = itemImporter(88);
    const service = createItemMatchingService(
      matchingDatabase(storeItemCandidate({ item_id: 77 }), [], {
        onStoreItemUpdate: (query) => updates.push(query)
      }),
      dependencies({
        ai: aiService(aiMatchFound()),
        bggClient: clientWithThing(bggThingDetails()),
        cache,
        importer
      })
    );

    await expect(service.matchWithAi?.(42)).rejects.toThrow('Cache failed');
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(linkUpdate(updates)).toBeUndefined();
  });

  it('preserves the current association when the BGG import fails', async () => {
    const updates: RecordedQuery[] = [];
    const service = createItemMatchingService(
      matchingDatabase(storeItemCandidate({ item_id: 77 }), [], {
        onStoreItemUpdate: (query) => updates.push(query)
      }),
      dependencies({
        ai: aiService(aiMatchFound()),
        bggClient: clientWithThing(bggThingDetails()),
        importer: itemImporterRejecting(new Error('Import failed'))
      })
    );

    await expect(service.matchWithAi?.(42)).rejects.toThrow('Import failed');
    expect(linkUpdate(updates)).toBeUndefined();
  });

  it.each(['AI matcher', 'BGG client', 'BGG importer'] as const)(
    'rejects manual matching when the %s is not configured',
    async (missingDependency) => {
      const updates: RecordedQuery[] = [];
      const configuredDependencies = dependencies({
        ai: aiService(aiMatchFound()),
        bggClient: clientWithThing(bggThingDetails()),
        importer: itemImporter(88)
      });
      if (missingDependency === 'AI matcher') {
        delete configuredDependencies.aiBggMatchingService;
      } else if (missingDependency === 'BGG client') {
        delete configuredDependencies.bggClient;
      } else {
        delete configuredDependencies.bggItemImporter;
      }
      const service = createItemMatchingService(
        matchingDatabase(storeItemCandidate({ item_id: 77 }), [], {
          onStoreItemUpdate: (query) => updates.push(query)
        }),
        configuredDependencies
      );

      await expect(service.matchWithAi?.(42)).rejects.toMatchObject({ status: 503 });
      expect(linkUpdate(updates)).toBeUndefined();
    }
  );

  it('records the normal no-match state when AI finds no match', async () => {
    const updates: RecordedQuery[] = [];
    const database = matchingDatabase(
      storeItemCandidate({ title: 'Unknown Game' }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );
    const ai = aiService(null);
    const cache = matchCache();
    const bggClient = clientWithThing(bggThingDetails());
    const importer = itemImporter(88);
    const autoList = autoListService();

    await createItemMatchingService(database, dependencies({ ai, autoList, bggClient, cache, importer }))
      .confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(bggClient.fetchThing).not.toHaveBeenCalled();
    expect(cache.recordAiMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(autoList.evaluateLinkedStoreItem).not.toHaveBeenCalled();
    expect(linkUpdate(updates)).toBeUndefined();
    const noMatch = updates.find((query) => normalizeSql(query.sql).includes("match_source = 'none'"));
    expect(noMatch?.params).toEqual([JSON.stringify(['no match above threshold']), 42]);
    expect(normalizeSql(noMatch?.sql ?? '')).toContain('is_boardgame_confirmed = false');
  });

  it('confirms a fresh admin action without running item matching', async () => {
    const updates: RecordedQuery[] = [];
    const events: TraceEvent[] = [];
    const ai = aiService(null);
    const cache = matchCache();
    const importer = itemImporter(88);
    const autoList = autoListService();
    const database = matchingDatabase(
      storeItemCandidate({ title: 'Unknown Game' }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );

    await createItemMatchingService(database, dependencies({ ai, autoList, cache, importer }))
      .confirmBoardgameAndMatch?.(42, {
        confirmationSource: 'admin',
        traceLogger: { log: (event, fields = {}) => events.push({ event, fields }) }
      });

    expect(cache.lookup).not.toHaveBeenCalled();
    expect(ai.findMatch).not.toHaveBeenCalled();
    expect(cache.recordAiMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(autoList.evaluateLinkedStoreItem).not.toHaveBeenCalled();
    expect(linkUpdate(updates)).toBeUndefined();
    expect(updates).toHaveLength(1);
    expect(normalizeSql(updates[0]?.sql ?? '')).toContain('is_boardgame = true');
    expect(normalizeSql(updates[0]?.sql ?? '')).toContain('is_boardgame_confirmed = true');
    expect(updates[0]?.params).toEqual([42]);
    expect(traceFields(events, 'item_matcher.confirm.completed')).toEqual({
      candidate_id: 42,
      result: 'confirmed_without_matching'
    });
  });

  it('short-circuits an automated re-entry for a persisted confirmed no-match', async () => {
    const queries: RecordedQuery[] = [];
    const events: TraceEvent[] = [];
    const ai = aiService(null);
    const cache = matchCache();
    const importer = itemImporter(88);
    const database = matchingDatabase(
      storeItemCandidate({
        is_boardgame_confirmed: true,
        match_source: 'NONE',
        processing_error: '',
        title: 'Unknown Game'
      }),
      [],
      { onQuery: (query) => queries.push(query) }
    );

    await createItemMatchingService(database, dependencies({ ai, cache, importer }))
      .confirmBoardgameAndMatch?.(42, {
        confirmationSource: 'automated',
        traceLogger: { log: (event, fields = {}) => events.push({ event, fields }) }
      });

    expect(ai.findMatch).not.toHaveBeenCalled();
    expect(cache.lookup).not.toHaveBeenCalled();
    expect(cache.recordAiMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(queries).toHaveLength(1);
    expect(normalizeSql(queries[0]?.sql ?? '')).toContain('from store_items');
    expect(events.map(({ event }) => event)).toEqual([
      'item_matcher.confirm.start',
      'item_matcher.candidate.loaded',
      'item_matcher.confirm.completed'
    ]);
    expect(traceFields(events, 'item_matcher.confirm.completed')).toEqual({
      candidate_id: 42,
      result: 'already_confirmed_no_match'
    });
  });

  it('does not rerun matching when an admin confirms a persisted no-match', async () => {
    const updates: RecordedQuery[] = [];
    const ai = aiService(null);
    const cache = matchCache();
    const database = matchingDatabase(
      storeItemCandidate({
        is_boardgame_confirmed: true,
        match_source: 'NONE',
        processing_error: '',
        title: 'Unknown Game'
      }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );

    await createItemMatchingService(database, dependencies({ ai, cache }))
      .confirmBoardgameAndMatch?.(42, { confirmationSource: 'admin' });

    expect(cache.lookup).not.toHaveBeenCalled();
    expect(ai.findMatch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(normalizeSql(updates[0]?.sql ?? '')).toContain('is_boardgame_confirmed = true');
  });

  it('retries matching for an automated confirmed no-match that has a processing error', async () => {
    const updates: RecordedQuery[] = [];
    const ai = aiService(null);
    const cache = matchCache();
    const importer = itemImporter(88);
    const database = matchingDatabase(
      storeItemCandidate({
        is_boardgame_confirmed: true,
        match_source: 'NONE',
        processing_error: 'CodexAPI unavailable',
        title: 'Unknown Game'
      }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );

    await createItemMatchingService(database, dependencies({ ai, cache, importer }))
      .confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(cache.lookup).toHaveBeenCalledOnce();
    expect(ai.findMatch).toHaveBeenCalledOnce();
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(updates).toHaveLength(2);
    expect(normalizeSql(updates[0]?.sql ?? '')).toContain("processing_error = ''");
    expect(normalizeSql(updates[1]?.sql ?? '')).toContain("match_source = 'none'");
  });

  it('records no match when the returned BGG ID does not resolve', async () => {
    const updates: RecordedQuery[] = [];
    const cache = matchCache();
    const importer = itemImporter(88);
    const database = matchingDatabase(
      storeItemCandidate({ title: 'La Guerra del Anillo' }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );
    const bggClient = clientWithThing(null);
    vi.mocked(bggClient.searchFresh!)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await createItemMatchingService(database, dependencies({
      ai: aiService(aiMatchFound()),
      bggClient,
      cache,
      importer
    })).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(processingErrorUpdate(updates)).toBeUndefined();
    expect(cache.recordAiMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(linkUpdate(updates)).toBeUndefined();
    expect(updates.some((query) => normalizeSql(query.sql).includes("match_source = 'none'"))).toBe(true);
  });

  it('corrects a hallucinated AI ID through an exact authenticated BGG title search', async () => {
    const updates: RecordedQuery[] = [];
    const cache = matchCache();
    const importer = itemImporter(88);
    const bggClient: BggClient = {
      fetchThing: vi.fn(async (bggId) => ({
        details: bggId === 402794
          ? bggThingDetails({
              bggId: 402794,
              name: 'Dígalo con Memes: Pack de Expansión #2'
            })
          : bggThingDetails({
              bggId: 377061,
              name: 'Coffee Rush',
              yearPublished: 2023
            }),
        rawXml: '<items />'
      })),
      search: vi.fn().mockRejectedValue(new Error('Cached search must not resolve an AI identity')),
      searchFresh: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([bggSearchItem(377061, 'Coffee Rush', 2023)])
    };
    const database = matchingDatabase(
      storeItemCandidate({ title: 'Coffee Rush' }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );

    await createItemMatchingService(database, dependencies({
      ai: aiService(aiMatchFound({
        bggId: 402794,
        bggUrl: 'https://boardgamegeek.com/boardgame/402794/coffee-rush',
        matchedName: 'Coffee Rush'
      })),
      bggClient,
      cache,
      importer
    })).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(bggClient.fetchThing).toHaveBeenNthCalledWith(1, 402794);
    expect(bggClient.searchFresh).toHaveBeenCalledWith('Coffee Rush');
    expect(bggClient.fetchThing).toHaveBeenNthCalledWith(2, 377061);
    expect(cache.recordAiMatch).toHaveBeenCalledWith(
      ['Coffee Rush', 'Coffee Rush'],
      { bggId: 377061, name: 'Coffee Rush', type: 'boardgame', yearPublished: 2023 },
      { imageUrl: 'https://store.mx/coffee-rush.jpg' }
    );
    expect(importer.importBggId).toHaveBeenCalledWith(377061);
    expect(processingErrorUpdate(updates)).toBeUndefined();
    expect(linkUpdate(updates)).toBeDefined();
  });

  it('records no match for a hallucinated AI ID when BGG has no unique exact title result', async () => {
    const updates: RecordedQuery[] = [];
    const cache = matchCache();
    const importer = itemImporter(88);
    const bggClient: BggClient = {
      fetchThing: vi.fn().mockResolvedValue({
        details: bggThingDetails({
          bggId: 402794,
          name: 'Dígalo con Memes: Pack de Expansión #2'
        }),
        rawXml: '<items />'
      }),
      search: vi.fn().mockRejectedValue(new Error('Cached search must not resolve an AI identity')),
      searchFresh: vi.fn().mockResolvedValue([
        bggSearchItem(398366, 'Coffee Rush: Piece of Cake', 2024)
      ])
    };
    const database = matchingDatabase(
      storeItemCandidate({ title: 'Coffee Rush' }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );

    await createItemMatchingService(database, dependencies({
      ai: aiService(aiMatchFound({
        bggId: 402794,
        bggUrl: 'https://boardgamegeek.com/boardgame/402794/coffee-rush',
        matchedName: 'Coffee Rush'
      })),
      bggClient,
      cache,
      importer
    })).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(processingErrorUpdate(updates)).toBeUndefined();
    expect(cache.recordAiMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(linkUpdate(updates)).toBeUndefined();
    expect(updates.some((query) => normalizeSql(query.sql).includes("match_source = 'none'"))).toBe(true);
  });

  it('records a processing error when CodexAPI fails', async () => {
    const updates: RecordedQuery[] = [];
    const database = matchingDatabase(
      storeItemCandidate({ title: 'La Guerra del Anillo' }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );
    const ai = aiService();
    vi.mocked(ai.findMatch).mockRejectedValueOnce(new Error('CodexAPI unavailable'));

    await createItemMatchingService(database, dependencies({
      ai,
      bggClient: clientWithThing(bggThingDetails()),
      cache: matchCache(),
      importer: itemImporter(88)
    })).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(processingErrorUpdate(updates)?.params).toEqual(['CodexAPI unavailable', 42]);
    expect(linkUpdate(updates)).toBeUndefined();
  });

  it('clears a prior processing error on manual confirmation without retrying matching', async () => {
    const updates: RecordedQuery[] = [];
    const ai = aiService();
    const cache = matchCache();
    const importer = itemImporter(88);
    vi.mocked(ai.findMatch).mockRejectedValueOnce(new Error('CodexAPI unavailable'));
    const database = matchingDatabase(
      storeItemCandidate({ title: 'La Guerra del Anillo' }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );

    await createItemMatchingService(database, dependencies({
      ai,
      bggClient: clientWithThing(bggThingDetails()),
      cache,
      importer
    })).confirmBoardgameAndMatch?.(42, { confirmationSource: 'admin' });

    expect(cache.recordAiMatch).not.toHaveBeenCalled();
    expect(cache.lookup).not.toHaveBeenCalled();
    expect(ai.findMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(linkUpdate(updates)).toBeUndefined();
    expect(processingErrorUpdate(updates)).toBeUndefined();
    expect(updates).toHaveLength(1);
    expect(normalizeSql(updates[0]?.sql ?? '')).toContain('is_boardgame_confirmed = true');
    expect(normalizeSql(updates[0]?.sql ?? '')).toContain("processing_error = ''");
    expect(updates[0]?.params).toEqual([42]);
  });

  it('does not cache or import a failed AI decision', async () => {
    const database = matchingDatabase(storeItemCandidate({ title: 'La Guerra del Anillo' }));
    const cache = matchCache();
    const importer = itemImporter(88);
    const mismatchedThing = bggThingDetails({ bggId: 999999 });

    await createItemMatchingService(database, dependencies({
      ai: aiService(aiMatchFound()),
      bggClient: clientWithThing(mismatchedThing),
      cache,
      importer
    })).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(cache.recordAiMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).not.toHaveBeenCalled();
  });

  it('rechecks with AI when the title changes to War of the Ring but the Coffee Rush cover remains', async () => {
    const database = matchingDatabase(storeItemCandidate({
      image_url: 'https://store.mx/coffee-rush.jpg',
      title: 'War of the Ring'
    }));
    const ai = aiService(null);
    const cache = matchCache();
    vi.mocked(cache.lookup).mockImplementation(async (_query, context) =>
      context?.imageUrl === 'https://store.mx/coffee-rush.jpg'
        ? {
            cacheHit: true,
            matches: [{ item: bggSearchItem(), verifiedByAi: false }]
          }
        : {
            cacheHit: true,
            matches: [{ item: bggSearchItem(), verifiedByAi: true }]
          });
    const importer = itemImporter(88);

    await createItemMatchingService(database, dependencies({
      ai,
      bggClient: clientWithThing(bggThingDetails()),
      cache,
      importer
    })).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(cache.lookup).toHaveBeenCalledWith('War of the Ring', {
      imageUrl: 'https://store.mx/coffee-rush.jpg'
    });
    expect(ai.findMatch).toHaveBeenCalledWith({
      itemName: 'War of the Ring',
      imageUrl: 'https://store.mx/coffee-rush.jpg'
    });
    expect(importer.importBggId).not.toHaveBeenCalled();
  });

  it('stages an AI candidate without auto-linking from generateMatchCandidates', async () => {
    const updates: RecordedQuery[] = [];
    const decision = aiMatchFound({ confidence: 0.2 });
    const database = matchingDatabase(
      storeItemCandidate({
        image_url: 'https://store.mx/guerra-del-anillo.jpg',
        title: 'La Guerra del Anillo'
      }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );
    const cache = matchCache();
    const importer = itemImporter(88);

    const result = await createItemMatchingService(database, dependencies({
      ai: aiService(decision),
      bggClient: clientWithThing(bggThingDetails()),
      cache,
      importer
    })).generateMatchCandidates(42);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      bgg_id: 115746,
      item_id: null,
      match_score: 0.2,
      matched_name: 'War of the Ring: Second Edition',
      source: 'BGG',
      status: 'PENDING'
    });
    expect(result[0].raw_payload).toEqual({ ai_match: decision, thing: bggThingDetails() });
    expect(cache.recordAiMatch).toHaveBeenCalledWith(
      ['La Guerra del Anillo', 'War of the Ring: Second Edition'],
      { bggId: 115746, name: 'War of the Ring: Second Edition', type: 'boardgame', yearPublished: 2011 },
      { imageUrl: 'https://store.mx/guerra-del-anillo.jpg' }
    );
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('stages rejected live BGG evidence without linking it', async () => {
    const updates: RecordedQuery[] = [];
    const thing = bggThingDetails({ bggId: 377061, name: 'Coffee Rush' });
    const bggClient = clientWithFreshSearch(
      [bggSearchItem(377061, 'Coffee Rush', 2023)],
      new Map([[377061, thing]])
    );

    const result = await createItemMatchingService(
      matchingDatabase(storeItemCandidate({ title: 'Coffee Rush Deluxe' }), [], {
        onStoreItemUpdate: (query) => updates.push(query)
      }),
      dependencies({ ai: aiService(null), bggClient, cache: matchCache() })
    ).generateMatchCandidates(42);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ bgg_id: 377061, source: 'BGG', status: 'PENDING' });
    expect(result[0].raw_payload).toMatchObject({ source: 'live_bgg_search', thing });
    expect(updates).toEqual([]);
  });

  it('uses and records a name-only AI result when candidate image_url is empty', async () => {
    const ai = aiService(aiMatchFound());
    const cache = matchCache();
    const database = matchingDatabase(storeItemCandidate({ image_url: '   ', title: 'Image Free Game' }));

    await createItemMatchingService(database, dependencies({
      ai,
      bggClient: clientWithThing(bggThingDetails()),
      cache,
      importer: itemImporter(88)
    })).generateMatchCandidates(42);

    expect(cache.lookup).toHaveBeenCalledWith('Image Free Game', { imageUrl: null });
    expect(ai.findMatch).toHaveBeenCalledWith({ itemName: 'Image Free Game', imageUrl: null });
    expect(cache.recordAiMatch).toHaveBeenCalledWith(
      ['Image Free Game', 'War of the Ring: Second Edition'],
      { bggId: 115746, name: 'War of the Ring: Second Edition', type: 'boardgame', yearPublished: 2011 },
      { imageUrl: null }
    );
  });

  it('logs AI start, result, validation, cache, import, and link events', async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const traceLogger: TraceLogger = {
      log: (event, fields = {}) => events.push({ event, fields })
    };
    const database = matchingDatabase(storeItemCandidate({ title: 'La Guerra del Anillo' }));

    await createItemMatchingService(database, dependencies({
      ai: aiService(aiMatchFound()),
      bggClient: clientWithThing(bggThingDetails()),
      cache: matchCache(),
      importer: itemImporter(88)
    })).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated', traceLogger });

    expect(events.map(({ event }) => event)).toEqual([
      'item_matcher.confirm.start',
      'item_matcher.candidate.loaded',
      'item_matcher.boardgame.confirmed',
      'item_matcher.local_match.start',
      'item_matcher.local_match.completed',
      'item_matcher.bgg_match.start',
      'item_matcher.bgg_cache.start',
      'item_matcher.bgg_cache.completed',
      'item_matcher.bgg_live_search.start',
      'item_matcher.bgg_live_search.failed',
      'item_matcher.ai_match.start',
      'item_matcher.ai_match.completed',
      'item_matcher.ai_match.validation.completed',
      'item_matcher.ai_match.cache.completed',
      'item_matcher.bgg_match.completed',
      'item_matcher.bgg_import.start',
      'item_matcher.bgg_import.completed',
      'item_matcher.link.completed',
      'auto_list_evaluation.start',
      'auto_list_evaluation.completed',
      'item_matcher.confirm.completed'
    ]);
    expect(events[11]?.fields).toMatchObject({
      bgg_id: 115746,
      candidate_id: 42,
      confidence: 0.83,
      cover_assessment: 'MATCH',
      match_found: true,
      matched_name: 'War of the Ring: Second Edition',
      name_assessment: 'MATCH'
    });
    expect(events[12]?.fields).toMatchObject({ bgg_id: 115746, candidate_id: 42, validated: true });
    expect(events[13]?.fields).toMatchObject({ bgg_id: 115746, candidate_id: 42, query_count: 2 });
    expect(events[16]?.fields).toMatchObject({ bgg_id: 115746, item_id: 88 });
    expect(events[18]?.fields).toEqual({ item_id: 88, store_item_id: 42 });
    expect(events[19]?.fields).toEqual({
      auto_list_eligible: false,
      image_similarity_pass: false,
      image_similarity_score: null,
      item_id: 88,
      status: 'ERROR',
      store_item_id: 42,
      verdict: 'NOT PASS'
    });
  });

  it('logs AI no-match and failure events', async () => {
    const noMatchEvents: TraceEvent[] = [];
    const failedEvents: TraceEvent[] = [];
    const noMatchLogger: TraceLogger = {
      log: (event, fields = {}) => noMatchEvents.push({ event, fields })
    };
    const failedLogger: TraceLogger = {
      log: (event, fields = {}) => failedEvents.push({ event, fields })
    };
    const database = matchingDatabase(storeItemCandidate({ title: 'Unknown Game' }));
    const failedAi = aiService();
    vi.mocked(failedAi.findMatch).mockRejectedValueOnce(new Error('CodexAPI unavailable'));

    await createItemMatchingService(database, dependencies({
      ai: aiService(null),
      bggClient: clientWithFreshSearch([], new Map()),
      cache: matchCache(),
      importer: itemImporter(88)
    })).confirmBoardgameAndMatch?.(42, { traceLogger: noMatchLogger });
    await createItemMatchingService(database, dependencies({
      ai: failedAi,
      bggClient: clientWithThing(bggThingDetails()),
      cache: matchCache(),
      importer: itemImporter(88)
    })).confirmBoardgameAndMatch?.(42, { traceLogger: failedLogger });

    expect(noMatchEvents.map(({ event }) => event)).toContain('item_matcher.ai_match.no_match');
    expect(traceFields(noMatchEvents, 'item_matcher.ai_match.no_match')).toMatchObject({
      reason: 'ai_decision_not_accepted'
    });
    expect(traceFields(noMatchEvents, 'item_matcher.ai_match.completed')).toMatchObject({
      bgg_id: null,
      confidence: null,
      cover_assessment: null,
      matched_name: null,
      name_assessment: null
    });
    expect(traceFields(failedEvents, 'item_matcher.ai_match.failed')).toMatchObject({
      bgg_id: null,
      confidence: null,
      cover_assessment: null,
      matched_name: null,
      name_assessment: null
    });
    const eventNames = noMatchEvents.map(({ event }) => event);
    const cacheCompletedIndex = eventNames.indexOf('item_matcher.bgg_cache.completed');
    const liveSearchStartIndex = eventNames.indexOf('item_matcher.bgg_live_search.start');
    const liveSearchCompletedIndex = eventNames.indexOf('item_matcher.bgg_live_search.completed');
    const aiMatchStartIndex = eventNames.indexOf('item_matcher.ai_match.start');
    expect(cacheCompletedIndex).toBeGreaterThanOrEqual(0);
    expect(liveSearchStartIndex).toBeGreaterThanOrEqual(0);
    expect(liveSearchCompletedIndex).toBeGreaterThanOrEqual(0);
    expect(aiMatchStartIndex).toBeGreaterThanOrEqual(0);
    expect(cacheCompletedIndex).toBeLessThan(liveSearchStartIndex);
    expect(liveSearchStartIndex).toBeLessThan(liveSearchCompletedIndex);
    expect(liveSearchCompletedIndex).toBeLessThan(aiMatchStartIndex);
  });

  it.each([
    {
      decision: aiDecision({
        bggId: 13,
        bggUrl: 'https://boardgamegeek.com/boardgame/13/catan',
        coverAssessment: 'CONFLICT',
        matchFound: true,
        matchedName: 'Catan',
        nameAssessment: 'MATCH'
      }),
      label: 'cover conflict'
    },
    {
      decision: aiDecision({ bggId: 13 }),
      label: 'negative decision with leftover identity'
    }
  ])('logs no match and performs no downstream writes for a completed $label decision', async ({ decision }) => {
    const events: TraceEvent[] = [];
    const updates: RecordedQuery[] = [];
    const cache = matchCache();
    const importer = itemImporter(88);
    const ai = createAiBggMatchingService(
      { findMatch: vi.fn().mockResolvedValue(decision) },
      { model: 'gpt-5.6-terra' }
    );
    const database = matchingDatabase(
      storeItemCandidate({ title: 'Catan' }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );

    await createItemMatchingService(database, dependencies({
      ai,
      bggClient: clientWithThing(bggThingDetails({ bggId: 13, name: 'Catan' })),
      cache,
      importer
    })).confirmBoardgameAndMatch?.(42, {
      confirmationSource: 'automated',
      traceLogger: { log: (event, fields = {}) => events.push({ event, fields }) }
    });

    expect(processingErrorUpdate(updates)).toBeUndefined();
    expect(cache.recordAiMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(linkUpdate(updates)).toBeUndefined();
    expect(traceFields(events, 'item_matcher.ai_match.no_match')).toMatchObject({
      reason: 'ai_decision_not_accepted'
    });
    expect(traceFields(events, 'item_matcher.ai_match.failed')).toBeUndefined();
  });

  it('retains decision evidence when BGG validation finds no match', async () => {
    const events: TraceEvent[] = [];
    const cache = matchCache();
    const importer = itemImporter(88);
    const bggClient = clientWithThing(null);
    vi.mocked(bggClient.searchFresh!).mockResolvedValue([]);

    await createItemMatchingService(
      matchingDatabase(storeItemCandidate({ title: 'La Guerra del Anillo' })),
      dependencies({
        ai: aiService(aiMatchFound()),
        bggClient,
        cache,
        importer
      })
    ).confirmBoardgameAndMatch?.(42, {
      traceLogger: { log: (event, fields = {}) => events.push({ event, fields }) }
    });

    expect(cache.recordAiMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(traceFields(events, 'item_matcher.ai_match.validation.completed')).toMatchObject({
      ai_bgg_id: 115746,
      bgg_id: 115746,
      id_validated: false,
      name_validated: false,
      validated: false
    });
    expect(traceFields(events, 'item_matcher.ai_match.no_match')).toMatchObject({
      ...aiTraceEvidence(),
      reason: 'bgg_identity_unvalidated'
    });
    expect(traceFields(events, 'item_matcher.ai_match.failed')).toBeUndefined();
  });

  it('retains decision evidence and stops before import when the cache write fails', async () => {
    const events: TraceEvent[] = [];
    const cache = matchCache();
    const importer = itemImporter(88);
    vi.mocked(cache.recordAiMatch).mockRejectedValueOnce(new Error('AI cache write failed'));

    await createItemMatchingService(
      matchingDatabase(storeItemCandidate({ title: 'La Guerra del Anillo' })),
      dependencies({
        ai: aiService(aiMatchFound()),
        bggClient: clientWithThing(bggThingDetails()),
        cache,
        importer
      })
    ).confirmBoardgameAndMatch?.(42, {
      traceLogger: { log: (event, fields = {}) => events.push({ event, fields }) }
    });

    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(traceFields(events, 'item_matcher.ai_match.failed')).toMatchObject(aiTraceEvidence());
  });

  it('preserves local candidate staging and listing', async () => {
    const stored = new Map<number, unknown[]>();
    const database = matchingDatabase(storeItemCandidate(), [localItemRow()], { storedCandidates: stored });
    const ai = aiService(aiMatchFound());
    const cache = matchCache();
    const service = createItemMatchingService(database, dependencies({ ai, cache }));

    const generated = await service.generateMatchCandidates(42);
    const listed = await service.listMatchCandidates(42);

    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ item_id: 77, source: 'LOCAL', status: 'PENDING' });
    expect(listed).toEqual(generated);
    expect(cache.lookup).not.toHaveBeenCalled();
    expect(ai.findMatch).not.toHaveBeenCalled();
  });

  it('throws 404 when the discovery item candidate is missing', async () => {
    const database: Database = { query: async () => ({ rows: [] }) };

    await expect(createItemMatchingService(database, dependencies()).generateMatchCandidates(404)).rejects.toMatchObject({
      message: 'Discovery item candidate not found',
      status: 404
    });
  });
});

type RecordedQuery = { params?: unknown[]; sql: string };
type TraceEvent = { event: string; fields: Record<string, unknown> };

function dependencies({
  ai = aiService(null),
  autoList = autoListService(),
  bggClient = clientWithThing(null),
  cache = matchCache(),
  importer = itemImporter(null)
}: {
  ai?: AiBggMatchingService;
  autoList?: AutoListEvaluationService;
  bggClient?: BggClient;
  cache?: BggMatchCache;
  importer?: BggItemImporter;
} = {}) {
  return {
    aiBggMatchingService: ai,
    autoListEvaluationService: autoList,
    bggClient,
    bggItemImporter: importer,
    bggMatchCache: cache
  };
}

function aiService(result: AiBggMatchFound | null = null): AiBggMatchingService {
  return { findMatch: vi.fn().mockResolvedValue(result) };
}

function autoListService(): AutoListEvaluationService {
  const result: AutoListEvaluationResult = {
    auto_list_eligible: false,
    evaluated_at: '2026-08-25T18:00:00.000Z',
    image_similarity: {
      pass: false,
      reasoning: 'Test image similarity result',
      score: null,
      status: 'ERROR',
      threshold: 95
    },
    item_id: 77,
    model: 'gpt-5.6-terra',
    reasoning: 'Test result',
    status: 'ERROR',
    store_item_id: 42,
    verdict: 'NOT PASS',
    version: 2
  };
  return { evaluateLinkedStoreItem: vi.fn().mockResolvedValue(result) };
}

function skippedAutoListService(): AutoListEvaluationService {
  return {
    evaluateLinkedStoreItem: vi.fn().mockResolvedValue({
      auto_list_eligible: false,
      item_id: 77,
      reason: 'TRANSLATION_NOT_GENERATED',
      reasoning: 'Auto-list evaluation skipped because the linked catalog item does not have a generated Spanish translation.',
      status: 'SKIPPED',
      store_item_id: 42
    })
  };
}

function aiServiceRejecting(error: Error): AiBggMatchingService {
  return { findMatch: vi.fn().mockRejectedValue(error) };
}

function matchCache(result: Awaited<ReturnType<BggMatchCache['lookup']>> = { cacheHit: false, matches: [] }): BggMatchCache {
  return {
    lookup: vi.fn().mockResolvedValue(result),
    recordAiMatch: vi.fn().mockResolvedValue(undefined),
    recordSearch: vi.fn().mockResolvedValue(undefined)
  };
}

function clientWithThing(details: BggThingDetails | null): BggClient {
  return {
    fetchThing: vi.fn().mockResolvedValue(details ? { details, rawXml: '<items />' } : null),
    search: vi.fn().mockRejectedValue(new Error('Live BGG search must not be used by item matching')),
    searchFresh: vi.fn().mockRejectedValue(new Error('Fresh BGG search must not be used by item matching'))
  };
}

function clientWithFreshSearch(
  searchResults: BggSearchItem[],
  things: Map<number, BggThingDetails | null>
): BggClient {
  return {
    fetchThing: vi.fn(async (bggId) => {
      const details = things.get(bggId) ?? null;
      return details ? { details, rawXml: '<items />' } : null;
    }),
    search: vi.fn().mockRejectedValue(new Error('Cached BGG search must not be used by live matching')),
    searchFresh: vi.fn().mockResolvedValue(searchResults)
  };
}

function itemImporter(itemId: number | null): BggItemImporter {
  return { importBggId: vi.fn().mockResolvedValue(itemId) };
}

function itemImporterRejecting(error: Error): BggItemImporter {
  return { importBggId: vi.fn().mockRejectedValue(error) };
}

function aiMatchFound(overrides: Partial<AiBggMatchFound> = {}): AiBggMatchFound {
  return {
    bggId: 115746,
    bggImageUrl: 'https://cf.geekdo-images.com/war-ring.jpg',
    bggUrl: 'https://boardgamegeek.com/boardgame/115746',
    confidence: 0.83,
    coverAssessment: 'MATCH',
    matchFound: true,
    matchedName: 'War of the Ring: Second Edition',
    nameAssessment: 'MATCH',
    reasoning: 'The Spanish listing and cover match the English BGG entry.',
    ...overrides
  };
}

function aiDecision(overrides: Partial<AiBggMatchDecision> = {}): AiBggMatchDecision {
  return {
    bggId: null,
    bggImageUrl: null,
    bggUrl: null,
    confidence: 0.2,
    coverAssessment: 'UNAVAILABLE',
    matchFound: false,
    matchedName: null,
    nameAssessment: 'NO_MATCH',
    reasoning: 'No reliable BGG result.',
    ...overrides
  };
}

function aiTraceEvidence(): Record<string, unknown> {
  return {
    bgg_id: 115746,
    confidence: 0.83,
    cover_assessment: 'MATCH',
    matched_name: 'War of the Ring: Second Edition',
    name_assessment: 'MATCH'
  };
}

function bggSearchItem(
  bggId = 115746,
  name = 'War of the Ring: Second Edition',
  yearPublished: number | null = 2011
): BggSearchItem {
  return { bggId, name, type: 'boardgame', yearPublished };
}

function bggThingDetails(overrides: Partial<BggThingDetails> = {}): BggThingDetails {
  return {
    alternateNames: [],
    artists: [],
    bggId: 115746,
    categories: [],
    description: '',
    designers: [],
    expansionLinks: [],
    families: [],
    image: 'https://cf.geekdo-images.com/war-ring.jpg',
    implementationLinks: [],
    maxPlayers: 4,
    maxPlaytime: 180,
    mechanics: [],
    minAge: 12,
    minPlayers: 2,
    minPlaytime: 120,
    name: 'War of the Ring: Second Edition',
    parentLinks: [],
    playingTime: 180,
    publishers: [],
    rating: 8.5,
    thumbnail: 'https://cf.geekdo-images.com/war-ring-thumb.jpg',
    type: 'boardgame',
    weight: 4.2,
    yearPublished: 2011,
    ...overrides
  };
}

function storeItemCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    image_url: 'https://store.mx/coffee-rush.jpg',
    is_boardgame_confirmed: false,
    item_type: 'base_game',
    language: 'es',
    match_source: null,
    max_players: 4,
    min_players: 2,
    processing_error: '',
    publisher: 'Korea Boardgames',
    store_name: 'Korea Boardgames Store',
    title: 'Coffee Rush',
    ...overrides
  };
}

function localItemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aliases: [],
    bgg_id: 377061,
    canonical_name: 'Coffee Rush',
    canonical_name_es: null,
    id: 77,
    item_type: 'base_game',
    normalized_name: 'coffee rush',
    normalized_name_es: null,
    publishers: ['Korea Boardgames'],
    ...overrides
  };
}

function matchingDatabase(
  candidate: Record<string, unknown>,
  localRows: Record<string, unknown>[] = [],
  options: {
    onQuery?: (query: RecordedQuery) => void;
    onStoreItemUpdate?: (query: RecordedQuery) => void;
    storedCandidates?: Map<number, unknown[]>;
  } = {}
): Database {
  const storedCandidates = options.storedCandidates ?? new Map<number, unknown[]>();
  return {
    query: async (sql, params) => {
      options.onQuery?.({ params, sql });
      const normalized = normalizeSql(sql);
      if (normalized.includes('from store_items')) {
        return { rows: candidate.id === undefined ? [] : [candidate] };
      }
      if (normalized.includes('from items')) {
        return { rows: localRows };
      }
      if (normalized.startsWith('update store_items')) {
        options.onStoreItemUpdate?.({ params, sql });
        return { rows: [] };
      }
      if (normalized.startsWith('delete from item_match_candidates')) {
        storedCandidates.set(Number(params?.[0]), []);
        return { rows: [] };
      }
      if (normalized.startsWith('insert into item_match_candidates')) {
        const row = {
          bgg_id: params?.[3] ?? null,
          discovery_item_candidate_id: params?.[0],
          id: 20 + (storedCandidates.get(Number(params?.[0]))?.length ?? 0),
          item_id: params?.[2] ?? null,
          match_reasons: JSON.parse(String(params?.[6] ?? '[]')) as unknown,
          match_score: params?.[5],
          matched_name: params?.[4],
          raw_payload: JSON.parse(String(params?.[7] ?? '{}')) as unknown,
          source: params?.[1],
          status: 'PENDING'
        };
        const candidateRows = storedCandidates.get(Number(params?.[0])) ?? [];
        candidateRows.push(row);
        storedCandidates.set(Number(params?.[0]), candidateRows);
        return { rows: [row] };
      }
      if (normalized.includes('from item_match_candidates')) {
        return { rows: storedCandidates.get(Number(params?.[0])) ?? [] };
      }
      return { rows: [] };
    }
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function linkUpdate(updates: RecordedQuery[]): RecordedQuery | undefined {
  return updates.find((query) => normalizeSql(query.sql).includes('set item_id = $1'));
}

function processingErrorUpdate(updates: RecordedQuery[]): RecordedQuery | undefined {
  return updates.find((query) => normalizeSql(query.sql).includes('processing_error = $1'));
}

function traceFields(events: TraceEvent[], eventName: string): Record<string, unknown> | undefined {
  return events.find(({ event }) => event === eventName)?.fields;
}
