import type { Database } from '../db.js';
import { normalizeTitle } from '../itemMatching/itemMatcher.js';
import { parseBggThingResponse } from './bggParser.js';
import type { BggClient, BggThingResult, BggThingXmlClient } from './bggClient.js';
import { createBggMatchCache, type BggMatchCache } from './bggMatchCache.js';
import { BGG_LEGACY_REQUEST_TYPE, BGG_REQUEST_TYPE } from './bggTypes.js';

const BGG_THING_REQUEST_TYPE = BGG_REQUEST_TYPE;

type CachedThingRow = {
  raw_xml?: unknown;
};

export function createCachedBggClient(
  database: Database,
  upstreamClient: BggThingXmlClient,
  matchCache: BggMatchCache = createBggMatchCache(database)
): BggClient {
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
): Promise<{ found: false; usable: false } | { found: true; result: BggThingResult | null; usable: boolean }> {
  const cached = await database.query(
    `
    select raw_xml
    from bgg_thing_cache
    where bgg_id = $1
      and request_type in ($2, $3)
    order by case when request_type = $2 then 0 else 1 end
    limit 1
    `,
    [bggId, BGG_THING_REQUEST_TYPE, BGG_LEGACY_REQUEST_TYPE]
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
