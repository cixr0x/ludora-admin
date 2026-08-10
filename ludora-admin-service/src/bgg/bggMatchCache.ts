import { createHash } from 'node:crypto';

import type { Database, SessionDatabase } from '../db.js';
import { normalizeTitle } from '../itemMatching/itemMatcher.js';
import type { BggSearchItem } from './bggParser.js';

export const BGG_SEARCH_TYPE = 'boardgame,boardgameexpansion';
export const BGG_AI_MATCH_SEARCH_TYPE = `ai_match:${BGG_SEARCH_TYPE}`;

export type BggCachedMatch = {
  item: BggSearchItem;
  verifiedByAi: boolean;
};

export type BggCachedSearch = {
  cacheHit: boolean;
  matches: BggCachedMatch[];
};

export type BggMatchCacheContext = {
  imageUrl: string | null;
};

export type BggMatchCache = {
  lookup(query: string, context?: BggMatchCacheContext): Promise<BggCachedSearch>;
  recordSearch(query: string, results: BggSearchItem[]): Promise<void>;
  recordAiMatch(queries: string[], result: BggSearchItem, context: BggMatchCacheContext): Promise<void>;
};

export function createBggMatchCache(database: Database): BggMatchCache {
  return {
    async lookup(query, context): Promise<BggCachedSearch> {
      const normalizedQuery = normalizeTitle(query);
      if (!normalizedQuery) {
        return { cacheHit: false, matches: [] };
      }

      const trustedAiQuery = context
        ? await queryAssociations(
            database,
            trustedAssociationKey(normalizedQuery, context),
            BGG_AI_MATCH_SEARCH_TYPE,
            true
          )
        : { cacheHit: false, matches: [] };
      const contextualAiCandidates = context
        ? await queryOtherContextAssociations(
            database,
            normalizedQuery,
            trustedAssociationKey(normalizedQuery, context)
          )
        : { cacheHit: false, matches: [] };
      const legacyAiQuery = await queryAssociations(
        database,
        normalizedQuery,
        BGG_AI_MATCH_SEARCH_TYPE,
        false
      );
      const ordinaryQuery = await queryAssociations(database, normalizedQuery, BGG_SEARCH_TYPE, false);
      const directCache = await searchCacheNames(database, query);
      const thingCache = await searchThingCache(database, query);

      return {
        cacheHit:
          trustedAiQuery.cacheHit ||
          contextualAiCandidates.cacheHit ||
          legacyAiQuery.cacheHit ||
          ordinaryQuery.cacheHit ||
          directCache.length > 0 ||
          thingCache.length > 0,
        matches: dedupeMatches([
          ...trustedAiQuery.matches,
          ...contextualAiCandidates.matches,
          ...legacyAiQuery.matches,
          ...ordinaryQuery.matches,
          ...directCache,
          ...thingCache
        ])
      };
    },

    async recordSearch(query, results): Promise<void> {
      await writeSearch(database, query, results, BGG_SEARCH_TYPE);
    },

    async recordAiMatch(queries, result, context): Promise<void> {
      const uniqueQueries = uniqueTrustedQueries(queries, context);
      if (uniqueQueries.length === 0) {
        return;
      }

      await requireSessionDatabase(database).withSession(async (session) => {
        let transactionStarted = false;
        try {
          await session.query('BEGIN');
          transactionStarted = true;

          for (const query of uniqueQueries) {
            await session.query('select pg_advisory_xact_lock($1, $2)', advisoryLockParts(query.associationKey));
          }

          const cacheId = await writeSearchResult(session, result);
          for (const query of uniqueQueries) {
            const queryId = await writeAiQuery(session, query.query, query.associationKey);
            await replaceQueryResults(session, queryId, [{ cacheId, resultRank: 0 }]);
          }

          await session.query('COMMIT');
        } catch (error) {
          if (transactionStarted) {
            await rollbackWithoutMasking(session);
          }
          throw error;
        }
      });
    }
  };
}

async function queryOtherContextAssociations(
  database: Database,
  normalizedQuery: string,
  trustedAssociationKeyValue: string
): Promise<BggCachedSearch> {
  const associationPrefix = `${normalizedQuery}::cover-context:`;
  const cachedResults = await database.query(
    `
    select
      q.id as query_id,
      c.bgg_id,
      c.name,
      c.item_type,
      c.year_published
    from bgg_search_queries q
    left join bgg_search_query_results qr on qr.query_id = q.id
    left join bgg_search_cache c on c.id = qr.cache_id
    where q.search_type = $1
      and q.normalized_query like $2 escape '\\'
      and q.normalized_query <> $3
    order by q.updated_at desc, q.id desc, qr.result_rank asc
    `,
    [BGG_AI_MATCH_SEARCH_TYPE, `${escapeLikePattern(associationPrefix)}%`, trustedAssociationKeyValue]
  );
  return {
    cacheHit: cachedResults.rows.length > 0,
    matches: bggSearchItems(cachedResults.rows).map((item) => ({ item, verifiedByAi: false }))
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

function uniqueTrustedQueries(
  queries: string[],
  context: BggMatchCacheContext
): Array<{ associationKey: string; query: string }> {
  const uniqueQueries = new Map<string, { associationKey: string; query: string }>();
  for (const query of queries) {
    const normalizedQuery = normalizeTitle(query);
    if (!normalizedQuery) {
      continue;
    }
    const associationKey = trustedAssociationKey(normalizedQuery, context);
    if (!uniqueQueries.has(associationKey)) {
      uniqueQueries.set(associationKey, { associationKey, query });
    }
  }
  return [...uniqueQueries.values()].sort((left, right) =>
    left.associationKey < right.associationKey ? -1 : left.associationKey > right.associationKey ? 1 : 0
  );
}

function trustedAssociationKey(normalizedQuery: string, context: BggMatchCacheContext): string {
  return `${normalizedQuery}::cover-context:${coverContextDiscriminator(context.imageUrl)}`;
}

function coverContextDiscriminator(imageUrl: string | null): string {
  const normalizedImageUrl = canonicalImageUrl(imageUrl);
  if (normalizedImageUrl === null) {
    return 'name-only';
  }
  return `image-sha256:${sha256(normalizedImageUrl)}`;
}

function canonicalImageUrl(imageUrl: string | null): string | null {
  const trimmed = imageUrl?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
}

function advisoryLockParts(associationKey: string): [number, number] {
  const digest = createHash('sha256').update(associationKey).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireSessionDatabase(database: Database): SessionDatabase {
  const sessionDatabase = database as Partial<SessionDatabase>;
  if (typeof sessionDatabase.withSession !== 'function') {
    throw new Error('AI BGG cache writes require a session-capable database');
  }
  return database as SessionDatabase;
}

async function rollbackWithoutMasking(session: Database): Promise<void> {
  try {
    await session.query('ROLLBACK');
  } catch {
    try {
      await session.close?.();
    } catch {
      // Preserve the original transaction error.
    }
  }
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
