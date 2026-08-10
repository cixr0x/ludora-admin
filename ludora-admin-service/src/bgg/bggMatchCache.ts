import type { Database } from '../db.js';
import { normalizeTitle } from '../itemMatching/itemMatcher.js';
import type { BggSearchItem } from './bggParser.js';

export const BGG_SEARCH_TYPE = 'boardgame,boardgameexpansion';
export const BGG_AI_MATCH_SEARCH_TYPE = `ai_match:${BGG_SEARCH_TYPE}`;

export type BggCachedMatch = {
  item: BggSearchItem;
  verifiedByAi: boolean;
};

export type BggMatchCache = {
  lookup(query: string): Promise<{ cacheHit: boolean; matches: BggCachedMatch[] }>;
  recordSearch(query: string, results: BggSearchItem[]): Promise<void>;
  recordAiMatch(queries: string[], result: BggSearchItem): Promise<void>;
};

export function createBggMatchCache(database: Database): BggMatchCache {
  return {
    async lookup(query): Promise<{ cacheHit: boolean; matches: BggCachedMatch[] }> {
      const normalizedQuery = normalizeTitle(query);
      if (!normalizedQuery) {
        return { cacheHit: false, matches: [] };
      }

      const aiQuery = await queryAssociations(database, normalizedQuery, BGG_AI_MATCH_SEARCH_TYPE, true);
      const ordinaryQuery = await queryAssociations(database, normalizedQuery, BGG_SEARCH_TYPE, false);
      const directCache = await searchCacheNames(database, query);
      const thingCache = await searchThingCache(database, query);

      return {
        cacheHit: aiQuery.cacheHit || ordinaryQuery.cacheHit || directCache.length > 0 || thingCache.length > 0,
        matches: dedupeMatches([...aiQuery.matches, ...ordinaryQuery.matches, ...directCache, ...thingCache])
      };
    },

    async recordSearch(query, results): Promise<void> {
      await writeSearch(database, query, results, BGG_SEARCH_TYPE);
    },

    async recordAiMatch(queries, result): Promise<void> {
      const uniqueQueries = uniqueNonEmptyQueries(queries);
      if (uniqueQueries.length === 0) {
        return;
      }

      const cacheId = await writeSearchResult(database, result);
      for (const query of uniqueQueries) {
        const queryId = await writeAiQuery(database, query.query, query.normalizedQuery);
        await replaceQueryResults(database, queryId, [{ cacheId, resultRank: 0 }]);
      }
    }
  };
}

async function queryAssociations(
  database: Database,
  normalizedQuery: string,
  searchType: string,
  verifiedByAi: boolean
): Promise<{ cacheHit: boolean; matches: BggCachedMatch[] }> {
  const cachedQuery = await database.query(
    `
    select id
    from bgg_search_queries
    where normalized_query = $1
      and search_type = $2
    limit 1
    `,
    [normalizedQuery, searchType]
  );
  const queryId = numberOrNull((cachedQuery.rows[0] as Record<string, unknown> | undefined)?.id);
  if (queryId === null) {
    return { cacheHit: false, matches: [] };
  }

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
    [queryId]
  );
  return {
    cacheHit: true,
    matches: bggSearchItems(cachedResults.rows).map((item) => ({ item, verifiedByAi }))
  };
}

async function searchCacheNames(database: Database, query: string): Promise<BggCachedMatch[]> {
  const results = await database.query(
    `
    select
      bgg_id,
      name,
      item_type,
      year_published
    from bgg_search_cache
    where item_type in ('boardgame', 'boardgameexpansion')
      and name ilike $1 escape '\\'
    order by
      case when lower(name) = lower($2) then 0 else 1 end,
      year_published desc nulls last,
      bgg_id desc
    limit 20
    `,
    [searchPattern(query), query.trim()]
  );
  return bggSearchItems(results.rows).map((item) => ({ item, verifiedByAi: false }));
}

async function searchThingCache(database: Database, query: string): Promise<BggCachedMatch[]> {
  const results = await database.query(
    `
    select
      bgg_id,
      name,
      item_type,
      year_published
    from bgg_thing_cache
    where request_type = $1
      and item_type in ('boardgame', 'boardgameexpansion')
      and name ilike $2 escape '\\'
    order by
      case when lower(name) = lower($3) then 0 else 1 end,
      year_published desc nulls last,
      bgg_id desc
    limit 20
    `,
    [BGG_SEARCH_TYPE, searchPattern(query), query.trim()]
  );
  return bggSearchItems(results.rows).map((item) => ({ item, verifiedByAi: false }));
}

async function writeAiQuery(database: Database, query: string, normalizedQuery: string): Promise<number> {
  const queryWrite = await database.query(
    `
    insert into bgg_search_queries (query, normalized_query, search_type, result_count, fetched_at, updated_at)
    values ($1, $2, $3, 1, now(), now())
    on conflict (normalized_query, search_type) do update set
      query = excluded.query,
      result_count = 1,
      fetched_at = excluded.fetched_at,
      updated_at = now()
    returning id;
    `,
    [query, normalizedQuery, BGG_AI_MATCH_SEARCH_TYPE]
  );
  const queryId = numberOrNull((queryWrite.rows[0] as Record<string, unknown> | undefined)?.id);
  if (queryId === null) {
    throw new Error('Failed to write BGG search query cache');
  }
  return queryId;
}

async function writeSearch(database: Database, query: string, results: BggSearchItem[], searchType: string): Promise<void> {
  const normalizedQuery = normalizeTitle(query);
  if (!normalizedQuery) {
    return;
  }

  const queryId = await writeQuery(database, query, normalizedQuery, searchType, results.length);
  await deleteQueryResults(database, queryId);
  for (const [resultRank, result] of results.entries()) {
    await writeQueryResult(database, queryId, await writeSearchResult(database, result), resultRank);
  }
}

async function writeSearchResult(database: Database, result: BggSearchItem): Promise<number> {
  const resultWrite = await database.query(
    `
    insert into bgg_search_cache (bgg_id, name, item_type, year_published, result_json, updated_at)
    values ($1, $2, $3, $4, $5::jsonb, now())
    on conflict (bgg_id) do update set
      name = excluded.name,
      item_type = excluded.item_type,
      year_published = excluded.year_published,
      result_json = excluded.result_json,
      updated_at = now()
    returning id;
    `,
    [result.bggId, result.name, result.type, result.yearPublished, JSON.stringify(result)]
  );
  const cacheId = numberOrNull((resultWrite.rows[0] as Record<string, unknown> | undefined)?.id);
  if (cacheId === null) {
    throw new Error('Failed to write BGG search result cache');
  }
  return cacheId;
}

async function writeQuery(
  database: Database,
  query: string,
  normalizedQuery: string,
  searchType: string,
  resultCount: number
): Promise<number> {
  const queryWrite = await database.query(
    `
    insert into bgg_search_queries (query, normalized_query, search_type, result_count, fetched_at, updated_at)
    values ($1, $2, $3, $4, now(), now())
    on conflict (normalized_query, search_type) do update set
      query = excluded.query,
      result_count = excluded.result_count,
      fetched_at = excluded.fetched_at,
      updated_at = now()
    returning id;
    `,
    [query, normalizedQuery, searchType, resultCount]
  );
  const queryId = numberOrNull((queryWrite.rows[0] as Record<string, unknown> | undefined)?.id);
  if (queryId === null) {
    throw new Error('Failed to write BGG search query cache');
  }
  return queryId;
}

async function replaceQueryResults(
  database: Database,
  queryId: number,
  cachedResults: Array<{ cacheId: number; resultRank: number }>
): Promise<void> {
  await deleteQueryResults(database, queryId);

  for (const { cacheId, resultRank } of cachedResults) {
    await writeQueryResult(database, queryId, cacheId, resultRank);
  }
}

async function deleteQueryResults(database: Database, queryId: number): Promise<void> {
  await database.query(
    `
    delete from bgg_search_query_results where query_id = $1;
    `,
    [queryId]
  );
}

async function writeQueryResult(database: Database, queryId: number, cacheId: number, resultRank: number): Promise<void> {
  await database.query(
    `
    insert into bgg_search_query_results (query_id, cache_id, result_rank)
    values ($1, $2, $3)
    on conflict (query_id, cache_id) do update set result_rank = excluded.result_rank;
    `,
    [queryId, cacheId, resultRank]
  );
}

function uniqueNonEmptyQueries(queries: string[]): Array<{ query: string; normalizedQuery: string }> {
  const uniqueQueries = new Map<string, { query: string; normalizedQuery: string }>();
  for (const query of queries) {
    const normalizedQuery = normalizeTitle(query);
    if (normalizedQuery && !uniqueQueries.has(normalizedQuery)) {
      uniqueQueries.set(normalizedQuery, { query, normalizedQuery });
    }
  }
  return [...uniqueQueries.values()];
}

function searchPattern(query: string): string {
  return `%${normalizeTitle(query).split(' ').map(escapeLikePattern).join('%')}%`;
}

function dedupeMatches(matches: BggCachedMatch[]): BggCachedMatch[] {
  const byBggId = new Map<number, BggCachedMatch>();
  for (const match of matches) {
    const existing = byBggId.get(match.item.bggId);
    if (!existing || (!existing.verifiedByAi && match.verifiedByAi)) {
      byBggId.set(match.item.bggId, match);
    }
  }
  return [...byBggId.values()];
}

function bggSearchItems(rows: unknown[]): BggSearchItem[] {
  return rows
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

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
