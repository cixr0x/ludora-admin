import type { BggClient, BggThingResult } from '../bgg/bggClient.js';
import type { BggSearchItem } from '../bgg/bggParser.js';
import type { Database } from '../db.js';
import type { TranslationService } from '../translation/translationService.js';
import {
  normalizeTitle,
  scoreBggThing,
  scoreLocalItem,
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
  generateMatchCandidates(discoveryItemCandidateId: number): Promise<ItemMatchCandidateRow[]>;
  listMatchCandidates(discoveryItemCandidateId: number): Promise<ItemMatchCandidateRow[]>;
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

const BGG_SEARCH_TYPE = 'boardgame,boardgameexpansion';
const HIGH_CONFIDENCE_BGG_MATCH_SCORE = 0.85;

export function createItemMatchingService(
  database: Database,
  bggClient?: BggClient,
  translationService?: TranslationService
): ItemMatchingService {
  return {
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
  const normalizedTitle = normalizeTitle(candidate.title);
  const result = await database.query(
    `
    select
      i.id,
      i.canonical_name,
      i.normalized_name,
      i.item_type,
      i.bgg_id,
      coalesce(json_agg(distinct ia.alias) filter (where ia.alias is not null), '[]'::json) as aliases
    from items i
    left join item_aliases ia on ia.item_id = i.id
    where i.normalized_name = $1
       or ia.normalized_alias = $1
    group by i.id, i.canonical_name, i.normalized_name, i.item_type, i.bgg_id
    order by i.canonical_name asc
    limit 20
    `,
    [normalizedTitle]
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
  translationService?: TranslationService
): Promise<GeneratedMatchCandidate[]> {
  if (!bggClient) {
    return [];
  }

  const originalQueries = dedupeStrings([candidate.title]);
  const originalMatches = await searchBggMatches(database, candidate, bggClient, originalQueries, originalQueries);
  if (originalMatches.some((match) => match.matchScore >= HIGH_CONFIDENCE_BGG_MATCH_SCORE)) {
    return originalMatches;
  }

  const translatedQueries = await translatedBggSearchQueries(candidate, translationService);
  if (translatedQueries.length === 0) {
    return originalMatches;
  }

  const translatedMatches = await searchBggMatches(database, candidate, bggClient, translatedQueries, [
    ...originalQueries,
    ...translatedQueries
  ]);

  return mergeMatchesByBggId([...originalMatches, ...translatedMatches]);
}

async function searchBggMatches(
  database: Database,
  candidate: DiscoveryItemCandidateRow,
  bggClient: BggClient,
  searchQueries: string[],
  titleVariants: string[]
): Promise<GeneratedMatchCandidate[]> {
  const searchResults: BggSearchItem[] = [];
  for (const query of searchQueries) {
    searchResults.push(...(await cachedBggSearch(database, bggClient, query)));
  }
  const uniqueSearchResults = selectSearchResultsForScoring(dedupeSearchResults(searchResults), titleVariants).slice(0, 10);
  const matches: GeneratedMatchCandidate[] = [];

  for (const searchResult of uniqueSearchResults) {
    const thing = await bggClient.fetchThing(searchResult.bggId);
    if (!thing) {
      continue;
    }
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

async function cachedBggSearch(database: Database, bggClient: BggClient, query: string): Promise<BggSearchItem[]> {
  const normalizedQuery = normalizeTitle(query);
  if (!normalizedQuery) {
    return [];
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
    return bggSearchItems(cachedResults.rows);
  }

  const results = await bggClient.search(query);
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
  translationService?: TranslationService
): Promise<string[]> {
  if (!translationService) {
    return [];
  }

  try {
    const translated = await translationService.translate({
      purpose: 'BGG_SEARCH_QUERY',
      sourceField: 'title',
      sourceId: candidate.id,
      sourceLanguage: languageCodeForTranslation(candidate.language),
      sourceType: 'discovery_item_candidate',
      targetLanguage: 'en',
      text: candidate.title
    });
    return dedupeStrings([translated.translatedText, ...translated.alternates]);
  } catch {
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
  thing: BggThingResult['details']
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
  return {
    aliases: stringList(row.aliases),
    bggId: numberOrNull(row.bgg_id),
    id: Number(row.id),
    itemType: stringOrNull(row.item_type),
    name: String(row.canonical_name ?? ''),
    normalizedName: String(row.normalized_name ?? '')
  };
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

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
