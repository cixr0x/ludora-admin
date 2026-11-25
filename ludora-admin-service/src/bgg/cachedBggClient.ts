import type { Database } from '../db.js';
import { normalizeTitle } from '../itemMatching/itemMatcher.js';
import { parseBggThingResponse } from './bggParser.js';
import type { BggClient, BggThingResult, BggThingXmlClient } from './bggClient.js';
import { createBggMatchCache, type BggMatchCache } from './bggMatchCache.js';
import { BGG_CACHE_REQUEST_TYPES, BGG_REQUEST_TYPE } from './bggTypes.js';

type CachedThingRow = {
  raw_xml?: unknown;
  request_type?: unknown;
};

export function createCachedBggClient(
  database: Database,
  upstreamClient: BggThingXmlClient,
  matchCache: BggMatchCache = createBggMatchCache(database)
): BggClient {
  return {
    async fetchThing(bggId: number): Promise<BggThingResult | null> {
      const cached = await cachedThingResult(database, bggId);
      if (cached !== undefined) {
        return cached;
      }

      const rawXml = await upstreamClient.fetchThingXml(bggId);
      await writeThingCache(database, bggId, rawXml);
      const details = parseBggThingResponse(rawXml);
      return details ? { details, rawXml } : null;
    },

    fetchVersions: upstreamClient.fetchVersions?.bind(upstreamClient),
    search: (query) => cachedSearch(matchCache, upstreamClient, query),
    searchFresh: (query) => freshSearch(matchCache, upstreamClient, query)
  };
}

async function freshSearch(matchCache: BggMatchCache, upstreamClient: BggThingXmlClient, query: string) {
  if (!normalizeTitle(query)) {
    return [];
  }
  const results = await upstreamClient.search(query);
  await matchCache.recordSearch(query, results);
  return results;
}

async function cachedSearch(matchCache: BggMatchCache, upstreamClient: BggThingXmlClient, query: string) {
  if (!normalizeTitle(query)) {
    return [];
  }
  const cached = await matchCache.lookup(query);
  if (cached.cacheHit) {
    return cached.matches.map((match) => match.item);
  }

  const results = await upstreamClient.search(query);
  await matchCache.recordSearch(query, results);
  return results;
}

async function cachedThingResult(
  database: Database,
  bggId: number
): Promise<BggThingResult | null | undefined> {
  const cached = await database.query(
    `
    select raw_xml, request_type
    from bgg_thing_cache
    where bgg_id = $1
      and request_type = any($2::text[])
    order by array_position($2::text[], request_type)
    `,
    [bggId, BGG_CACHE_REQUEST_TYPES]
  );
  for (const { raw_xml: rawXml, request_type: requestType } of cached.rows as CachedThingRow[]) {
    if (typeof rawXml !== 'string' || !rawXml) {
      continue;
    }
    try {
      const details = parseBggThingResponse(rawXml);
      if (details) {
        return { details, rawXml };
      }
      if (requestType === BGG_REQUEST_TYPE) {
        return null;
      }
    } catch {
      // Try another compatible cache row before fetching from BGG.
    }
  }
  return undefined;
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
      BGG_REQUEST_TYPE,
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
        alternateNames: details.alternateNames,
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

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
