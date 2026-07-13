import type { Database } from '../db.js';
import { normalizeTitle } from '../itemMatching/itemMatcher.js';
import type { BggSearchItem } from './bggParser.js';
import { parseBggThingResponse } from './bggParser.js';
import type { BggClient, BggThingResult, BggThingXmlClient } from './bggClient.js';

const BGG_THING_REQUEST_TYPE = 'boardgame,boardgameexpansion';

type CachedThingRow = {
  raw_xml?: unknown;
};

export function createCachedBggClient(database: Database, upstreamClient: BggThingXmlClient): BggClient {
  return {
    async fetchThing(bggId: number): Promise<BggThingResult | null> {
      const cached = await cachedThingResult(database, bggId);
      if (cached.found && cached.usable) {
        return cached.result;
      }

      const rawXml = await upstreamClient.fetchThingXml(bggId);
      await writeThingCache(database, bggId, rawXml);
      const details = parseBggThingResponse(rawXml);
      return details ? { details, rawXml } : null;
    },

    search: (query) => cachedSearch(database, upstreamClient, query),
    searchFresh: (query) => freshSearch(database, upstreamClient, query)
  };
}

async function freshSearch(database: Database, upstreamClient: BggThingXmlClient, query: string): Promise<BggSearchItem[]> {
  const normalizedQuery = normalizeTitle(query);
  if (!normalizedQuery) {
    return [];
  }

  const results = await upstreamClient.search(query);
  await writeSearchCache(database, query, normalizedQuery, results);
  return results;
}

async function cachedSearch(database: Database, upstreamClient: BggThingXmlClient, query: string): Promise<BggSearchItem[]> {
  const normalizedQuery = normalizeTitle(query);
  if (!normalizedQuery) {
    return [];
  }

  const cachedResults = await cachedSearchQueryResults(database, normalizedQuery);
  if (cachedResults !== null) {
    return cachedResults;
  }

  const thingCacheResults = await searchThingCache(database, query);
  if (thingCacheResults.length > 0) {
    await writeSearchCache(database, query, normalizedQuery, thingCacheResults);
    return thingCacheResults;
  }

  const results = await upstreamClient.search(query);
  await writeSearchCache(database, query, normalizedQuery, results);
  return results;
}

async function cachedSearchQueryResults(database: Database, normalizedQuery: string): Promise<BggSearchItem[] | null> {
  const cachedQuery = await database.query(
    `
    select id
    from bgg_search_queries
    where normalized_query = $1
      and search_type = $2
    limit 1
    `,
    [normalizedQuery, BGG_THING_REQUEST_TYPE]
  );
  const cachedQueryId = numberOrNull((cachedQuery.rows[0] as Record<string, unknown> | undefined)?.id);
  if (cachedQueryId === null) {
    return null;
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
    [cachedQueryId]
  );
  return bggSearchItems(cachedResults.rows);
}

async function searchThingCache(database: Database, query: string): Promise<BggSearchItem[]> {
  const pattern = `%${normalizeTitle(query).split(' ').map(escapeLikePattern).join('%')}%`;
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
    [BGG_THING_REQUEST_TYPE, pattern, query.trim()]
  );
  return bggSearchItems(results.rows);
}

async function writeSearchCache(
  database: Database,
  query: string,
  normalizedQuery: string,
  results: BggSearchItem[]
): Promise<void> {
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
    [query, normalizedQuery, BGG_THING_REQUEST_TYPE, results.length]
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
}

async function cachedThingResult(
  database: Database,
  bggId: number
): Promise<{ found: false; usable: false } | { found: true; result: BggThingResult | null; usable: boolean }> {
  const cached = await database.query(
    `
    select raw_xml
    from bgg_thing_cache
    where bgg_id = $1
      and request_type = $2
    limit 1
    `,
    [bggId, BGG_THING_REQUEST_TYPE]
  );
  const row = cached.rows[0] as CachedThingRow | undefined;
  const rawXml = typeof row?.raw_xml === 'string' ? row.raw_xml : '';
  if (!rawXml) {
    return { found: false, usable: false };
  }

  try {
    const details = parseBggThingResponse(rawXml);
    return { found: true, result: details ? { details, rawXml } : null, usable: true };
  } catch {
    return { found: true, result: null, usable: false };
  }
}

async function writeThingCache(database: Database, bggId: number, rawXml: string): Promise<void> {
  const summary = thingCacheSummary(rawXml);
  await database.query(
    `
    insert into bgg_thing_cache (
      bgg_id,
      request_type,
      raw_xml,
      name,
      item_type,
      year_published,
      parsed_json,
      fetched_at,
      updated_at
    )
    values ($1, $2, $3, $4, $5, $6, $7, now(), now())
    on conflict (bgg_id, request_type) do update set
      raw_xml = excluded.raw_xml,
      name = excluded.name,
      item_type = excluded.item_type,
      year_published = excluded.year_published,
      parsed_json = excluded.parsed_json,
      fetched_at = excluded.fetched_at,
      updated_at = excluded.updated_at
    `,
    [
      bggId,
      BGG_THING_REQUEST_TYPE,
      rawXml,
      summary.name,
      summary.itemType,
      summary.yearPublished,
      summary.parsedJson
    ]
  );
}

function thingCacheSummary(rawXml: string): {
  itemType: string;
  name: string;
  parsedJson: Record<string, unknown>;
  yearPublished: number | null;
} {
  try {
    const details = parseBggThingResponse(rawXml);
    if (!details) {
      return {
        itemType: '',
        name: '',
        parsedJson: {},
        yearPublished: null
      };
    }

    return {
      itemType: details.type,
      name: details.name,
      parsedJson: {
        bggId: details.bggId,
        implementationLinks: details.implementationLinks,
        name: details.name,
        parentLinks: details.parentLinks,
        type: details.type,
        yearPublished: details.yearPublished
      },
      yearPublished: details.yearPublished
    };
  } catch {
    return {
      itemType: '',
      name: '',
      parsedJson: {},
      yearPublished: null
    };
  }
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
