import type { BggClient, BggThingResult } from '../bgg/bggClient.js';
import type { BggItemImporter } from '../bgg/bggItemImporter.js';
import type { BggSearchItem } from '../bgg/bggParser.js';
import type { Database } from '../db.js';
import { nullTraceLogger, type TraceLogger } from '../trace.js';
import type { TranslationService } from '../translation/translationService.js';
import {
  normalizeTitle,
  normalizeTitleVariants,
  scoreBggThing,
  scoreLocalItem,
  type BggThingForMatch,
  type DiscoveryCandidateForMatch,
  type LocalItemForMatch
} from './itemMatcher.js';

export type ItemMatchCandidateRow = {
  bgg_id?: number | null;
  discovery_item_candidate_id?: number;
  id?: number;
  item_id?: number | null;
  match_reasons?: unknown;
  match_score?: number;
  matched_name?: string;
  raw_payload?: unknown;
  source: 'LOCAL' | 'BGG';
  status?: string;
};

export type ItemMatchingService = {
  confirmBoardgameAndMatch?(
    discoveryItemCandidateId: number,
    options?: ConfirmBoardgameOptions
  ): Promise<void>;
  generateMatchCandidates(discoveryItemCandidateId: number): Promise<ItemMatchCandidateRow[]>;
  listMatchCandidates(discoveryItemCandidateId: number): Promise<ItemMatchCandidateRow[]>;
};

type ConfirmBoardgameOptions = {
  confirmationSource?: 'admin' | 'automated';
  traceLogger?: TraceLogger;
};

type DiscoveryItemCandidateRow = {
  id: number;
  item_type?: string | null;
  language?: string | null;
  max_players?: number | null;
  min_players?: number | null;
  publisher?: string | null;
  title: string;
};

type GeneratedMatchCandidate = {
  bggId: number | null;
  itemId: number | null;
  matchReasons: string[];
  matchScore: number;
  matchedName: string;
  rawPayload: unknown;
  source: 'LOCAL' | 'BGG';
};

const matchCandidateSelect = `
  id, discovery_item_candidate_id, source, item_id, bgg_id, matched_name,
  match_score, match_reasons, status, raw_payload, created_at, updated_at
`;

const BGG_SEARCH_ITEM_TYPES = ['boardgame', 'boardgameexpansion'];
const BGG_SEARCH_TYPE = BGG_SEARCH_ITEM_TYPES.join(',');
const AUTO_MATCH_SCORE_THRESHOLD = 0.9;

export function createItemMatchingService(
  database: Database,
  bggClient?: BggClient,
  translationService?: TranslationService,
  bggItemImporter?: BggItemImporter
): ItemMatchingService {
  return {
    async confirmBoardgameAndMatch(
      discoveryItemCandidateId: number,
      options: ConfirmBoardgameOptions = {}
    ): Promise<void> {
      const traceLogger = options.traceLogger ?? nullTraceLogger;
      traceLog(traceLogger, 'item_matcher.confirm.start', {
        candidate_id: discoveryItemCandidateId,
        confirmation_source: options.confirmationSource ?? 'admin'
      });
      const candidate = await loadDiscoveryItemCandidate(database, discoveryItemCandidateId);
      traceLog(traceLogger, 'item_matcher.candidate.loaded', {
        candidate_id: discoveryItemCandidateId,
        item_type: candidate.item_type ?? null,
        language: candidate.language ?? null,
        title: candidate.title
      });
      const isAdminConfirmation = options.confirmationSource === 'admin';
      await confirmStoreItemAsBoardgame(database, discoveryItemCandidateId, isAdminConfirmation);
      traceLog(traceLogger, 'item_matcher.boardgame.confirmed', {
        candidate_id: discoveryItemCandidateId,
        is_boardgame_confirmed: isAdminConfirmation
      });

      try {
        traceLog(traceLogger, 'item_matcher.local_match.start', { candidate_id: discoveryItemCandidateId });
        const localMatches = await generateLocalMatches(database, candidate);
        const localMatch = bestMatchAboveThreshold(localMatches);
        traceLog(traceLogger, 'item_matcher.local_match.completed', {
          best_item_id: localMatch?.itemId ?? null,
          best_score: localMatch?.matchScore ?? null,
          candidate_id: discoveryItemCandidateId,
          match_count: localMatches.length
        });
        if (localMatch?.itemId) {
          await linkStoreItemMatch(
            database,
            discoveryItemCandidateId,
            localMatch,
            localMatch.itemId,
            shouldConfirmBoardgameMatch(localMatch, isAdminConfirmation)
          );
          traceLog(traceLogger, 'item_matcher.link.completed', {
            candidate_id: discoveryItemCandidateId,
            item_id: localMatch.itemId,
            match_source: localMatch.source,
            match_score: localMatch.matchScore,
            matched_bgg_id: localMatch.bggId
          });
          traceLog(traceLogger, 'item_matcher.confirm.completed', {
            candidate_id: discoveryItemCandidateId,
            result: 'linked_local_match'
          });
          return;
        }

        if (!bggClient) {
          await markStoreItemProcessingError(
            database,
            discoveryItemCandidateId,
            'BGG client is not configured',
            isAdminConfirmation
          );
          traceLog(traceLogger, 'item_matcher.failed', {
            candidate_id: discoveryItemCandidateId,
            error: 'BGG client is not configured'
          });
          return;
        }

        traceLog(traceLogger, 'item_matcher.bgg_match.start', { candidate_id: discoveryItemCandidateId });
        const bggMatches = await generateBggMatches(database, candidate, bggClient, translationService, traceLogger);
        const bggMatch = bestMatchAboveThreshold(bggMatches);
        traceLog(traceLogger, 'item_matcher.bgg_match.completed', {
          best_bgg_id: bggMatch?.bggId ?? null,
          best_score: bggMatch?.matchScore ?? null,
          candidate_id: discoveryItemCandidateId,
          match_count: bggMatches.length
        });
        if (!bggMatch?.bggId) {
          await markStoreItemMatchNotFound(database, discoveryItemCandidateId, ['no match above threshold'], isAdminConfirmation);
          traceLog(traceLogger, 'item_matcher.no_match', {
            candidate_id: discoveryItemCandidateId,
            match_count: bggMatches.length,
            reason: 'no match above threshold'
          });
          traceLog(traceLogger, 'item_matcher.confirm.completed', {
            candidate_id: discoveryItemCandidateId,
            result: 'no_match'
          });
          return;
        }

        if (!bggItemImporter) {
          await markStoreItemProcessingError(
            database,
            discoveryItemCandidateId,
            'BGG item importer is not configured',
            isAdminConfirmation
          );
          traceLog(traceLogger, 'item_matcher.failed', {
            bgg_id: bggMatch.bggId,
            candidate_id: discoveryItemCandidateId,
            error: 'BGG item importer is not configured'
          });
          return;
        }

        traceLog(traceLogger, 'item_matcher.bgg_import.start', {
          bgg_id: bggMatch.bggId,
          candidate_id: discoveryItemCandidateId
        });
        const itemId = await bggItemImporter.importBggId(bggMatch.bggId);
        traceLog(traceLogger, 'item_matcher.bgg_import.completed', {
          bgg_id: bggMatch.bggId,
          candidate_id: discoveryItemCandidateId,
          item_id: itemId
        });
        if (!itemId) {
          await markStoreItemProcessingError(
            database,
            discoveryItemCandidateId,
            'BGG item could not be imported',
            isAdminConfirmation
          );
          traceLog(traceLogger, 'item_matcher.failed', {
            bgg_id: bggMatch.bggId,
            candidate_id: discoveryItemCandidateId,
            error: 'BGG item could not be imported'
          });
          return;
        }

        await linkStoreItemMatch(
          database,
          discoveryItemCandidateId,
          bggMatch,
          itemId,
          shouldConfirmBoardgameMatch(bggMatch, isAdminConfirmation)
        );
        traceLog(traceLogger, 'item_matcher.link.completed', {
          candidate_id: discoveryItemCandidateId,
          item_id: itemId,
          match_source: bggMatch.source,
          match_score: bggMatch.matchScore,
          matched_bgg_id: bggMatch.bggId
        });
        traceLog(traceLogger, 'item_matcher.confirm.completed', {
          candidate_id: discoveryItemCandidateId,
          result: 'linked_bgg_match'
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Item matching failed';
        await markStoreItemProcessingError(
          database,
          discoveryItemCandidateId,
          message,
          isAdminConfirmation
        );
        traceLog(traceLogger, 'item_matcher.failed', {
          candidate_id: discoveryItemCandidateId,
          error: message
        });
      }
    },

    async generateMatchCandidates(discoveryItemCandidateId: number): Promise<ItemMatchCandidateRow[]> {
      const candidate = await loadDiscoveryItemCandidate(database, discoveryItemCandidateId);
      const generated = [
        ...(await generateLocalMatches(database, candidate)),
        ...(await generateBggMatches(database, candidate, bggClient, translationService))
      ].filter((match) => match.matchScore >= 0.3);

      await database.query(
        `
        delete from item_match_candidates
        where discovery_item_candidate_id = $1
          and status = 'PENDING'
        `,
        [discoveryItemCandidateId]
      );

      const storedRows: ItemMatchCandidateRow[] = [];
      for (const match of generated) {
        const result = await database.query(
          `
          insert into item_match_candidates (
            discovery_item_candidate_id,
            source,
            item_id,
            bgg_id,
            matched_name,
            match_score,
            match_reasons,
            status,
            raw_payload,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'PENDING', $8::jsonb, now())
          returning ${matchCandidateSelect}
          `,
          [
            candidate.id,
            match.source,
            match.itemId,
            match.bggId,
            match.matchedName,
            match.matchScore,
            JSON.stringify(match.matchReasons),
            JSON.stringify(match.rawPayload)
          ]
        );
        storedRows.push(...(result.rows as ItemMatchCandidateRow[]));
      }

      return storedRows;
    },

    async listMatchCandidates(discoveryItemCandidateId: number): Promise<ItemMatchCandidateRow[]> {
      const result = await database.query(
        `
        select ${matchCandidateSelect}
        from item_match_candidates
        where discovery_item_candidate_id = $1
        order by match_score desc, updated_at desc
        `,
        [discoveryItemCandidateId]
      );
      return result.rows as ItemMatchCandidateRow[];
    }
  };
}

function bestMatchAboveThreshold(matches: GeneratedMatchCandidate[]): GeneratedMatchCandidate | null {
  const match = [...matches].sort((left, right) => right.matchScore - left.matchScore)[0];
  return match && match.matchScore >= AUTO_MATCH_SCORE_THRESHOLD ? match : null;
}

function shouldConfirmBoardgameMatch(match: GeneratedMatchCandidate, isAdminConfirmation: boolean): boolean {
  return isAdminConfirmation || match.bggId !== null;
}

async function confirmStoreItemAsBoardgame(
  database: Database,
  discoveryItemCandidateId: number,
  isBoardgameConfirmed: boolean
): Promise<void> {
  await database.query(
    `
    update store_items
    set is_boardgame = true,
        is_boardgame_confirmed = ${isBoardgameConfirmed ? 'true' : 'false'},
        processing_error = '',
        last_updated = now()
    where id = $1
    `,
    [discoveryItemCandidateId]
  );
}

async function linkStoreItemMatch(
  database: Database,
  discoveryItemCandidateId: number,
  match: GeneratedMatchCandidate,
  itemId: number,
  isBoardgameConfirmed: boolean
): Promise<void> {
  await database.query(
    `
    update store_items
    set item_id = $1,
        is_boardgame = true,
        is_boardgame_confirmed = ${isBoardgameConfirmed ? 'true' : 'false'},
        match_source = $2,
        matched_bgg_id = $3,
        matched_name = $4,
        match_score = $5,
        match_reasons = $6::jsonb,
        match_payload = $7::jsonb,
        matched_at = now(),
        processed_at = now(),
        processing_error = '',
        last_updated = now()
    where id = $8
    `,
    [
      itemId,
      match.source,
      match.bggId,
      match.matchedName,
      match.matchScore,
      JSON.stringify(match.matchReasons),
      JSON.stringify(match.rawPayload),
      discoveryItemCandidateId
    ]
  );
}

async function markStoreItemMatchNotFound(
  database: Database,
  discoveryItemCandidateId: number,
  reasons: string[],
  isBoardgameConfirmed: boolean
): Promise<void> {
  await database.query(
    `
    update store_items
    set is_boardgame = true,
        is_boardgame_confirmed = ${isBoardgameConfirmed ? 'true' : 'false'},
        match_source = 'NONE',
        match_reasons = $1::jsonb,
        match_payload = '{}'::jsonb,
        processed_at = now(),
        processing_error = '',
        last_updated = now()
    where id = $2
    `,
    [JSON.stringify(reasons), discoveryItemCandidateId]
  );
}

async function markStoreItemProcessingError(
  database: Database,
  discoveryItemCandidateId: number,
  error: string,
  isBoardgameConfirmed: boolean
): Promise<void> {
  await database.query(
    `
    update store_items
    set is_boardgame = true,
        is_boardgame_confirmed = ${isBoardgameConfirmed ? 'true' : 'false'},
        processing_error = $1,
        processed_at = now(),
        last_updated = now()
    where id = $2
    `,
    [error, discoveryItemCandidateId]
  );
}

async function loadDiscoveryItemCandidate(database: Database, discoveryItemCandidateId: number): Promise<DiscoveryItemCandidateRow> {
  const result = await database.query(
    `
    select id, title, publisher, item_type, min_players, max_players, language
    from store_items
    where id = $1
    `,
    [discoveryItemCandidateId]
  );
  const row = result.rows[0] as DiscoveryItemCandidateRow | undefined;
  if (!row) {
    throw httpError(404, 'Discovery item candidate not found');
  }
  return row;
}

async function generateLocalMatches(database: Database, candidate: DiscoveryItemCandidateRow): Promise<GeneratedMatchCandidate[]> {
  const normalizedTitleVariants = normalizeTitleVariants(candidate.title);
  const result = await database.query(
    `
    select
      i.id,
      i.canonical_name,
      i.canonical_name_es,
      i.normalized_name,
      i.normalized_name_es,
      i.item_type,
      i.bgg_id,
      coalesce(json_agg(distinct ia.alias) filter (where ia.alias is not null), '[]'::json) as aliases
    from items i
    left join item_aliases ia on ia.item_id = i.id
    where i.normalized_name = any($1::text[])
       or i.normalized_name_es = any($1::text[])
       or ia.normalized_alias = any($1::text[])
    group by i.id, i.canonical_name, i.canonical_name_es, i.normalized_name, i.normalized_name_es, i.item_type, i.bgg_id
    order by i.canonical_name asc
    limit 20
    `,
    [normalizedTitleVariants]
  );

  return result.rows.map((row) => {
    const item = localItemFromRow(row as Record<string, unknown>);
    const score = scoreLocalItem(discoveryCandidateForMatch(candidate), item);
    return {
      bggId: item.bggId ?? null,
      itemId: item.id,
      matchReasons: score.matchReasons,
      matchScore: score.matchScore,
      matchedName: item.name,
      rawPayload: { item },
      source: 'LOCAL' as const
    };
  });
}

async function generateBggMatches(
  database: Database,
  candidate: DiscoveryItemCandidateRow,
  bggClient?: BggClient,
  translationService?: TranslationService,
  traceLogger: TraceLogger = nullTraceLogger
): Promise<GeneratedMatchCandidate[]> {
  const originalQueries = dedupeStrings([candidate.title]);
  traceLog(traceLogger, 'item_matcher.bgg_cache.start', {
    candidate_id: candidate.id,
    phase: 'original',
    query_count: originalQueries.length
  });
  const originalCacheMatches = await generateBggCacheMatches(database, candidate, originalQueries, originalQueries);
  traceLog(traceLogger, 'item_matcher.bgg_cache.completed', {
    candidate_id: candidate.id,
    auto_match: hasAcceptedMatch(originalCacheMatches),
    match_count: originalCacheMatches.length,
    phase: 'original'
  });
  if (hasAcceptedMatch(originalCacheMatches)) {
    return originalCacheMatches;
  }

  if (!bggClient) {
    return originalCacheMatches;
  }

  let originalMatches = mergeMatchesByBggId([
    ...originalCacheMatches,
    ...(await searchBggMatches(database, candidate, bggClient, originalQueries, originalQueries, traceLogger))
  ]);
  if (hasAcceptedMatch(originalMatches)) {
    return originalMatches;
  }

  originalMatches = mergeMatchesByBggId([
    ...originalMatches,
    ...(await searchBggMatches(database, candidate, bggClient, originalQueries, originalQueries, traceLogger, true))
  ]);
  if (hasAcceptedMatch(originalMatches)) {
    return originalMatches;
  }

  const translatedQueries = await translatedBggSearchQueries(candidate, translationService, traceLogger);
  if (translatedQueries.length === 0) {
    return originalMatches;
  }

  const titleVariants = [...originalQueries, ...translatedQueries];
  traceLog(traceLogger, 'item_matcher.bgg_cache.start', {
    candidate_id: candidate.id,
    phase: 'translated',
    query_count: translatedQueries.length
  });
  const translatedCacheMatches = await generateBggCacheMatches(database, candidate, translatedQueries, titleVariants);
  traceLog(traceLogger, 'item_matcher.bgg_cache.completed', {
    candidate_id: candidate.id,
    auto_match: hasAcceptedMatch(translatedCacheMatches),
    match_count: translatedCacheMatches.length,
    phase: 'translated'
  });
  let cacheMatches = mergeMatchesByBggId([...originalMatches, ...translatedCacheMatches]);
  if (hasAcceptedMatch(translatedCacheMatches)) {
    return cacheMatches;
  }

  let translatedMatches = await searchBggMatches(database, candidate, bggClient, translatedQueries, titleVariants, traceLogger);
  cacheMatches = mergeMatchesByBggId([...cacheMatches, ...translatedMatches]);
  if (hasAcceptedMatch(cacheMatches)) {
    return cacheMatches;
  }

  translatedMatches = await searchBggMatches(
    database,
    candidate,
    bggClient,
    translatedQueries,
    titleVariants,
    traceLogger,
    true
  );

  return mergeMatchesByBggId([...cacheMatches, ...translatedMatches]);
}

function hasAcceptedMatch(matches: GeneratedMatchCandidate[]): boolean {
  return matches.some((match) => match.matchScore >= AUTO_MATCH_SCORE_THRESHOLD);
}

async function generateBggCacheMatches(
  database: Database,
  candidate: DiscoveryItemCandidateRow,
  searchQueries: string[],
  titleVariants: string[]
): Promise<GeneratedMatchCandidate[]> {
  const namePatterns = bggCacheNamePatterns(searchQueries);
  if (namePatterns.length === 0) {
    return [];
  }

  const namePredicates = namePatterns.map((_, index) => `name ilike $${index + 2} escape '\\'`).join('\n       or ');
  const cacheRows = await database.query(
    `
    select bgg_id, name, item_type, year_published, result_json
    from bgg_search_cache
    where item_type = any($1::text[])
      and (
        ${namePredicates}
      )
    order by year_published desc nulls last, bgg_id desc
    limit 20
    `,
    [BGG_SEARCH_ITEM_TYPES, ...namePatterns]
  );

  const searchResults = selectSearchResultsForScoring(dedupeSearchResults(bggSearchItems(cacheRows.rows)), titleVariants).slice(0, 10);
  return searchResults.map((searchResult) => {
    const score = scoreBggThingWithTitleVariants(candidate, titleVariants, bggThingFromSearchItem(searchResult));
    return {
      bggId: searchResult.bggId,
      itemId: null,
      matchReasons: score.matchReasons,
      matchScore: score.matchScore,
      matchedName: searchResult.name,
      rawPayload: bggCacheRawPayload(searchResult),
      source: 'BGG' as const
    };
  });
}

async function searchBggMatches(
  database: Database,
  candidate: DiscoveryItemCandidateRow,
  bggClient: BggClient,
  searchQueries: string[],
  titleVariants: string[],
  traceLogger: TraceLogger = nullTraceLogger,
  forceRefresh = false
): Promise<GeneratedMatchCandidate[]> {
  const searchResults: BggSearchItem[] = [];
  for (const query of searchQueries) {
    searchResults.push(...(await cachedBggSearch(database, bggClient, query, traceLogger, forceRefresh)));
  }
  const uniqueSearchResults = selectSearchResultsForScoring(dedupeSearchResults(searchResults), titleVariants).slice(0, 10);
  const matches: GeneratedMatchCandidate[] = [];

  for (const searchResult of uniqueSearchResults) {
    traceLog(traceLogger, 'item_matcher.bgg_thing_fetch.start', {
      bgg_id: searchResult.bggId,
      candidate_id: candidate.id,
      name: searchResult.name
    });
    const thing = await bggClient.fetchThing(searchResult.bggId);
    if (!thing) {
      traceLog(traceLogger, 'item_matcher.bgg_thing_fetch.completed', {
        bgg_id: searchResult.bggId,
        candidate_id: candidate.id,
        found: false,
        name: searchResult.name
      });
      continue;
    }
    traceLog(traceLogger, 'item_matcher.bgg_thing_fetch.completed', {
      bgg_id: searchResult.bggId,
      candidate_id: candidate.id,
      found: true,
      name: thing.details.name
    });
    const score = scoreBggThingWithTitleVariants(candidate, titleVariants, thing.details);
    matches.push({
      bggId: thing.details.bggId,
      itemId: null,
      matchReasons: score.matchReasons,
      matchScore: score.matchScore,
      matchedName: thing.details.name,
      rawPayload: bggRawPayload(searchResult, thing),
      source: 'BGG'
    });
  }

  return matches;
}

async function cachedBggSearch(
  database: Database,
  bggClient: BggClient,
  query: string,
  traceLogger: TraceLogger = nullTraceLogger,
  forceRefresh = false
): Promise<BggSearchItem[]> {
  const normalizedQuery = normalizeTitle(query);
  if (!normalizedQuery) {
    return [];
  }

  traceLog(traceLogger, 'item_matcher.bgg_search.start', {
    normalized_query: normalizedQuery,
    query
  });
  if (forceRefresh) {
    traceLog(traceLogger, 'item_matcher.bgg_search.api_start', {
      normalized_query: normalizedQuery,
      query,
      refresh: true
    });
    const results = await (bggClient.searchFresh?.(query) ?? bggClient.search(query));
    traceLog(traceLogger, 'item_matcher.bgg_search.completed', {
      normalized_query: normalizedQuery,
      query,
      result_count: results.length,
      source: 'api_refresh'
    });
    return results;
  }

  const cachedQuery = await database.query(
    `
    select id
    from bgg_search_queries
    where normalized_query = $1
      and search_type = $2
    limit 1
    `,
    [normalizedQuery, BGG_SEARCH_TYPE]
  );

  const cachedQueryId = numberOrNull((cachedQuery.rows[0] as Record<string, unknown> | undefined)?.id);
  if (cachedQueryId !== null) {
    const cachedResults = await database.query(
      `
      select
        c.bgg_id,
        c.name,
        c.item_type,
        c.year_published
      from bgg_search_query_results qr
      join bgg_search_cache c on c.id = qr.cache_id
      where qr.query_id = $1
      order by qr.result_rank asc
      `,
      [cachedQueryId]
    );
    const results = bggSearchItems(cachedResults.rows);
    traceLog(traceLogger, 'item_matcher.bgg_search.completed', {
      normalized_query: normalizedQuery,
      query,
      result_count: results.length,
      source: 'cache'
    });
    return results;
  }

  traceLog(traceLogger, 'item_matcher.bgg_search.api_start', {
    normalized_query: normalizedQuery,
    query
  });
  const results = await bggClient.search(query);
  traceLog(traceLogger, 'item_matcher.bgg_search.completed', {
    normalized_query: normalizedQuery,
    query,
    result_count: results.length,
    source: 'api'
  });
  const queryWrite = await database.query(
    `
    insert into bgg_search_queries (
      query,
      normalized_query,
      search_type,
      result_count,
      fetched_at,
      updated_at
    )
    values ($1, $2, $3, $4, now(), now())
    on conflict (normalized_query, search_type) do update set
      query = excluded.query,
      result_count = excluded.result_count,
      fetched_at = excluded.fetched_at,
      updated_at = now()
    returning id
    `,
    [query, normalizedQuery, BGG_SEARCH_TYPE, results.length]
  );
  const queryId = numberOrNull((queryWrite.rows[0] as Record<string, unknown> | undefined)?.id);
  if (queryId === null) {
    throw new Error('Failed to write BGG search query cache');
  }

  await database.query(
    `
    delete from bgg_search_query_results
    where query_id = $1
    `,
    [queryId]
  );

  for (const [index, result] of results.entries()) {
    const resultWrite = await database.query(
      `
      insert into bgg_search_cache (
        bgg_id,
        name,
        item_type,
        year_published,
        result_json,
        updated_at
      )
      values ($1, $2, $3, $4, $5::jsonb, now())
      on conflict (bgg_id) do update set
        name = excluded.name,
        item_type = excluded.item_type,
        year_published = excluded.year_published,
        result_json = excluded.result_json,
        updated_at = now()
      returning id
      `,
      [result.bggId, result.name, result.type, result.yearPublished, JSON.stringify(result)]
    );
    const cacheId = numberOrNull((resultWrite.rows[0] as Record<string, unknown> | undefined)?.id);
    if (cacheId === null) {
      throw new Error('Failed to write BGG search result cache');
    }
    await database.query(
      `
      insert into bgg_search_query_results (
        query_id,
        cache_id,
        result_rank
      )
      values ($1, $2, $3)
      on conflict (query_id, cache_id) do update set
        result_rank = excluded.result_rank
      `,
      [queryId, cacheId, index]
    );
  }

  return results;
}

function selectSearchResultsForScoring(searchResults: BggSearchItem[], titleVariants: string[]): BggSearchItem[] {
  const normalizedTitleVariants = new Set(titleVariants.map(normalizeTitle).filter(Boolean));
  const exactMatches = searchResults.filter((item) => normalizedTitleVariants.has(normalizeTitle(item.name)));

  if (exactMatches.length <= 1) {
    return searchResults;
  }

  return [exactMatches.sort(compareNewestBggSearchItem)[0]];
}

function compareNewestBggSearchItem(left: BggSearchItem, right: BggSearchItem): number {
  if (left.yearPublished !== null && right.yearPublished !== null && left.yearPublished !== right.yearPublished) {
    return right.yearPublished - left.yearPublished;
  }
  return right.bggId - left.bggId;
}

async function translatedBggSearchQueries(
  candidate: DiscoveryItemCandidateRow,
  translationService?: TranslationService,
  traceLogger: TraceLogger = nullTraceLogger
): Promise<string[]> {
  if (!translationService) {
    traceLog(traceLogger, 'item_matcher.translation.skipped', {
      candidate_id: candidate.id,
      reason: 'translation service is not configured'
    });
    return [];
  }

  try {
    traceLog(traceLogger, 'item_matcher.translation.start', {
      candidate_id: candidate.id,
      source_language: languageCodeForTranslation(candidate.language),
      title: candidate.title
    });
    const translated = await translationService.translate({
      purpose: 'BGG_SEARCH_QUERY',
      sourceField: 'title',
      sourceId: candidate.id,
      sourceLanguage: languageCodeForTranslation(candidate.language),
      sourceType: 'discovery_item_candidate',
      targetLanguage: 'en',
      text: candidate.title
    });
    const queries = dedupeStrings([translated.translatedText, ...translated.alternates]);
    traceLog(traceLogger, 'item_matcher.translation.completed', {
      candidate_id: candidate.id,
      from_cache: translated.fromCache,
      model: translated.model,
      query_count: queries.length
    });
    return queries;
  } catch {
    traceLog(traceLogger, 'item_matcher.translation.failed', {
      candidate_id: candidate.id
    });
    return [];
  }
}

function languageCodeForTranslation(value?: string | null): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || 'auto';
}

function discoveryCandidateForMatch(candidate: DiscoveryItemCandidateRow): DiscoveryCandidateForMatch {
  return {
    itemType: candidate.item_type,
    maxPlayers: candidate.max_players,
    minPlayers: candidate.min_players,
    publisher: candidate.publisher,
    title: candidate.title
  };
}

function scoreBggThingWithTitleVariants(
  candidate: DiscoveryItemCandidateRow,
  titleVariants: string[],
  thing: BggThingForMatch
) {
  const baseCandidate = discoveryCandidateForMatch(candidate);
  const scores = titleVariants.map((title, index) => {
    const score = scoreBggThing({ ...baseCandidate, title }, thing);
    return index === 0
      ? score
      : {
          matchReasons: ['translated title variant evaluated', ...score.matchReasons],
          matchScore: score.matchScore
        };
  });

  return scores.sort((left, right) => right.matchScore - left.matchScore)[0];
}

function localItemFromRow(row: Record<string, unknown>): LocalItemForMatch {
  const item: LocalItemForMatch = {
    aliases: stringList(row.aliases),
    bggId: numberOrNull(row.bgg_id),
    id: Number(row.id),
    itemType: stringOrNull(row.item_type),
    name: String(row.canonical_name ?? ''),
    normalizedName: String(row.normalized_name ?? '')
  };
  const nameEs = stringOrNull(row.canonical_name_es)?.trim();
  const normalizedNameEs = stringOrNull(row.normalized_name_es)?.trim();
  if (nameEs) {
    item.nameEs = nameEs;
  }
  if (normalizedNameEs) {
    item.normalizedNameEs = normalizedNameEs;
  }
  return item;
}

function dedupeSearchResults(items: BggSearchItem[]): BggSearchItem[] {
  const seen = new Set<number>();
  const deduped: BggSearchItem[] = [];
  for (const item of items) {
    if (seen.has(item.bggId)) {
      continue;
    }
    seen.add(item.bggId);
    deduped.push(item);
  }
  return deduped;
}

function mergeMatchesByBggId(matches: GeneratedMatchCandidate[]): GeneratedMatchCandidate[] {
  const merged = new Map<number | null, GeneratedMatchCandidate>();
  for (const match of matches) {
    const existing = merged.get(match.bggId);
    if (!existing || match.matchScore > existing.matchScore) {
      merged.set(match.bggId, match);
    }
  }
  return [...merged.values()].sort((left, right) => right.matchScore - left.matchScore);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

function bggRawPayload(searchResult: BggSearchItem, thing: BggThingResult): unknown {
  return {
    search_result: searchResult,
    thing: thing.details
  };
}

function bggCacheRawPayload(searchResult: BggSearchItem): unknown {
  return {
    search_result: searchResult,
    source: 'bgg_search_cache'
  };
}

function bggThingFromSearchItem(searchResult: BggSearchItem): BggThingForMatch {
  return {
    alternateNames: [],
    bggId: searchResult.bggId,
    maxPlayers: null,
    minPlayers: null,
    name: searchResult.name,
    publishers: [],
    type: searchResult.type,
    yearPublished: searchResult.yearPublished
  };
}

function bggCacheNamePatterns(searchQueries: string[]): string[] {
  return dedupeStrings(
    searchQueries
      .flatMap((query) => normalizeTitleVariants(query))
      .map((query) => query.trim())
      .filter(Boolean)
      .map((query) => `%${query.split(' ').map(escapeLikePattern).join('%')}%`)
  );
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return stringList(parsed);
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
}

function bggSearchItems(value: unknown): BggSearchItem[] {
  const parsed = typeof value === 'string' ? parseJson(value, []) : value;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      return {
        bggId: numberOrNull(row.bggId ?? row.bgg_id) ?? 0,
        name: String(row.name ?? ''),
        type: String(row.type ?? row.item_type ?? ''),
        yearPublished: numberOrNull(row.yearPublished ?? row.year_published)
      };
    })
    .filter((item) => item.bggId > 0 && item.name);
}

function parseJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function traceLog(traceLogger: TraceLogger, event: string, fields: Record<string, unknown> = {}): void {
  try {
    traceLogger.log(event, fields);
  } catch {
    return;
  }
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
