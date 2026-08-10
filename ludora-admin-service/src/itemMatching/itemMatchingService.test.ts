import { describe, expect, it, vi } from 'vitest';

import type { AiBggMatchFound, AiBggMatchingService } from '../aiBggMatching/aiBggMatchingService.js';
import type { BggClient } from '../bgg/bggClient.js';
import type { BggItemImporter } from '../bgg/bggItemImporter.js';
import type { BggMatchCache } from '../bgg/bggMatchCache.js';
import type { BggSearchItem, BggThingDetails } from '../bgg/bggParser.js';
import type { Database } from '../db.js';
import type { TraceLogger } from '../trace.js';
import { createItemMatchingService } from './itemMatchingService.js';

describe('item matching service', () => {
  it('does not call AI when a local item is accepted', async () => {
    const updates: RecordedQuery[] = [];
    const database = matchingDatabase(
      storeItemCandidate(),
      [localItemRow()],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );
    const ai = aiService();
    const cache = matchCache();
    const service = createItemMatchingService(database, dependencies({ ai, cache }));

    await service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(ai.findMatch).not.toHaveBeenCalled();
    expect(cache.lookup).not.toHaveBeenCalled();
    expect(linkUpdate(updates)?.params?.slice(0, 4)).toEqual([77, 'LOCAL', 377061, 'Coffee Rush']);
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

    await createItemMatchingService(database, dependencies({ ai, cache, importer }))
      .confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(cache.lookup).toHaveBeenCalledWith('Coffee Rush', {
      imageUrl: 'https://store.mx/coffee-rush.jpg'
    });
    expect(ai.findMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).toHaveBeenCalledWith(377061);
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

    await createItemMatchingService(database, dependencies({ ai, bggClient, cache, importer }))
      .confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    expect(bggClient.fetchThing).not.toHaveBeenCalled();
    expect(cache.recordAiMatch).not.toHaveBeenCalled();
    expect(importer.importBggId).not.toHaveBeenCalled();
    expect(linkUpdate(updates)).toBeUndefined();
    const noMatch = updates.find((query) => normalizeSql(query.sql).includes("match_source = 'none'"));
    expect(noMatch?.params).toEqual([JSON.stringify(['no match above threshold']), 42]);
    expect(normalizeSql(noMatch?.sql ?? '')).toContain('is_boardgame_confirmed = false');
  });

  it('records a processing error when the returned BGG ID does not resolve', async () => {
    const updates: RecordedQuery[] = [];
    const database = matchingDatabase(
      storeItemCandidate({ title: 'La Guerra del Anillo' }),
      [],
      { onStoreItemUpdate: (query) => updates.push(query) }
    );
    const bggClient = clientWithThing(null);

    await createItemMatchingService(database, dependencies({
      ai: aiService(aiMatchFound()),
      bggClient,
      cache: matchCache(),
      importer: itemImporter(88)
    })).confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });

    const errorUpdate = processingErrorUpdate(updates);
    expect(errorUpdate?.params).toEqual(['AI BGG match could not validate BGG ID 115746', 42]);
    expect(linkUpdate(updates)).toBeUndefined();
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
      'item_matcher.ai_match.start',
      'item_matcher.ai_match.completed',
      'item_matcher.ai_match.validation.completed',
      'item_matcher.ai_match.cache.completed',
      'item_matcher.bgg_match.completed',
      'item_matcher.bgg_import.start',
      'item_matcher.bgg_import.completed',
      'item_matcher.link.completed',
      'item_matcher.confirm.completed'
    ]);
    expect(events[9]?.fields).toMatchObject({ bgg_id: 115746, candidate_id: 42, match_found: true });
    expect(events[10]?.fields).toMatchObject({ bgg_id: 115746, candidate_id: 42, validated: true });
    expect(events[11]?.fields).toMatchObject({ bgg_id: 115746, candidate_id: 42, query_count: 2 });
    expect(events[14]?.fields).toMatchObject({ bgg_id: 115746, item_id: 88 });
  });

  it('logs AI no-match and failure events', async () => {
    const noMatchEvents: string[] = [];
    const failedEvents: string[] = [];
    const noMatchLogger: TraceLogger = { log: (event) => noMatchEvents.push(event) };
    const failedLogger: TraceLogger = { log: (event) => failedEvents.push(event) };
    const database = matchingDatabase(storeItemCandidate({ title: 'Unknown Game' }));
    const failedAi = aiService();
    vi.mocked(failedAi.findMatch).mockRejectedValueOnce(new Error('CodexAPI unavailable'));

    await createItemMatchingService(database, dependencies({
      ai: aiService(null),
      bggClient: clientWithThing(bggThingDetails()),
      cache: matchCache(),
      importer: itemImporter(88)
    })).confirmBoardgameAndMatch?.(42, { traceLogger: noMatchLogger });
    await createItemMatchingService(database, dependencies({
      ai: failedAi,
      bggClient: clientWithThing(bggThingDetails()),
      cache: matchCache(),
      importer: itemImporter(88)
    })).confirmBoardgameAndMatch?.(42, { traceLogger: failedLogger });

    expect(noMatchEvents).toContain('item_matcher.ai_match.no_match');
    expect(failedEvents).toContain('item_matcher.ai_match.failed');
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

function dependencies({
  ai = aiService(null),
  bggClient = clientWithThing(null),
  cache = matchCache(),
  importer = itemImporter(null)
}: {
  ai?: AiBggMatchingService;
  bggClient?: BggClient;
  cache?: BggMatchCache;
  importer?: BggItemImporter;
} = {}) {
  return {
    aiBggMatchingService: ai,
    bggClient,
    bggItemImporter: importer,
    bggMatchCache: cache
  };
}

function aiService(result: AiBggMatchFound | null = null): AiBggMatchingService {
  return { findMatch: vi.fn().mockResolvedValue(result) };
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

function itemImporter(itemId: number | null): BggItemImporter {
  return { importBggId: vi.fn().mockResolvedValue(itemId) };
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
    item_type: 'base_game',
    language: 'es',
    max_players: 4,
    min_players: 2,
    publisher: 'Korea Boardgames',
    title: 'Coffee Rush',
    ...overrides
  };
}

function localItemRow(): Record<string, unknown> {
  return {
    aliases: [],
    bgg_id: 377061,
    canonical_name: 'Coffee Rush',
    canonical_name_es: null,
    id: 77,
    item_type: 'base_game',
    normalized_name: 'coffee rush',
    normalized_name_es: null
  };
}

function matchingDatabase(
  candidate: Record<string, unknown>,
  localRows: Record<string, unknown>[] = [],
  options: {
    onStoreItemUpdate?: (query: RecordedQuery) => void;
    storedCandidates?: Map<number, unknown[]>;
  } = {}
): Database {
  const storedCandidates = options.storedCandidates ?? new Map<number, unknown[]>();
  return {
    query: async (sql, params) => {
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
