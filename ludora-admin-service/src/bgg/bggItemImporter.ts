import type { Database } from '../db.js';
import { normalizeTitle } from '../itemMatching/itemMatcher.js';
import type { BggClient } from './bggClient.js';
import type { BggNamedLink, BggThingDetails } from './bggParser.js';

export type BggItemImporter = {
  importBggId(bggId: number): Promise<number | null>;
};

export function createBggItemImporter(database: Database, bggClient?: BggClient): BggItemImporter {
  return {
    async importBggId(bggId: number): Promise<number | null> {
      if (!bggClient) {
        return null;
      }

      const fetched = await bggClient.fetchThing(bggId);
      if (!fetched) {
        return null;
      }

      return importThing(database, fetched.details);
    }
  };
}

async function importThing(database: Database, thing: BggThingDetails): Promise<number> {
  const itemId = await upsertItem(database, thing);
  await upsertAliases(database, itemId, thing.alternateNames);
  await upsertTaxonomyLinks(database, itemId, 'boardgame_categories', 'item_categories', 'category_id', thing.categories);
  await upsertTaxonomyLinks(database, itemId, 'boardgame_mechanics', 'item_mechanics', 'mechanic_id', thing.mechanics);
  await upsertTaxonomyLinks(database, itemId, 'boardgame_families', 'item_families', 'family_id', thing.families);
  await upsertContributors(database, itemId, thing.designers, 'designer');
  await upsertContributors(database, itemId, thing.artists, 'artist');
  await upsertPublishers(database, itemId, thing.publishers);
  return itemId;
}

async function upsertItem(database: Database, thing: BggThingDetails): Promise<number> {
  const existing = await database.query('select id from items where bgg_id = $1', [thing.bggId]);
  const existingId = idFromRows(existing.rows);
  const params = [
    thing.name,
    normalizeTitle(thing.name),
    bggTypeToItemType(thing.type),
    null,
    thing.bggId,
    bggUrl(thing),
    thing.yearPublished,
    thing.description,
    thing.minPlayers,
    thing.maxPlayers,
    thing.minPlaytime ?? thing.playingTime,
    thing.maxPlaytime ?? thing.playingTime,
    thing.minAge,
    thing.image || thing.thumbnail
  ];

  if (existingId !== null) {
    const result = await database.query(
      `
      update items
      set canonical_name = $1,
          normalized_name = $2,
          item_type = $3,
          parent_item_id = coalesce(parent_item_id, $4),
          bgg_id = $5,
          bgg_url = $6,
          bgg_last_sync_at = now(),
          year_published = $7,
          description = $8,
          min_players = $9,
          max_players = $10,
          min_minutes = $11,
          max_minutes = $12,
          min_age = $13,
          image_url = $14,
          status = 'active',
          updated_at = now()
      where id = $15
      returning id
      `,
      [...params, existingId]
    );
    return idFromRows(result.rows) ?? existingId;
  }

  const result = await database.query(
    `
    insert into items (
      canonical_name,
      normalized_name,
      item_type,
      parent_item_id,
      bgg_id,
      bgg_url,
      bgg_last_sync_at,
      year_published,
      description,
      min_players,
      max_players,
      min_minutes,
      max_minutes,
      min_age,
      image_url,
      status,
      updated_at
    )
    values ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10, $11, $12, $13, $14, 'active', now())
    returning id
    `,
    params
  );
  const itemId = idFromRows(result.rows);
  if (itemId === null) {
    throw new Error('Failed to import BGG item');
  }
  return itemId;
}

async function upsertAliases(database: Database, itemId: number, aliases: string[]) {
  for (const alias of dedupeByNormalizedName(aliases)) {
    await database.query(
      `
      insert into item_aliases (item_id, alias, normalized_alias, source)
      values ($1, $2, $3, 'BGG')
      on conflict (item_id, normalized_alias) do update set
        alias = excluded.alias,
        source = excluded.source
      `,
      [itemId, alias, normalizeTitle(alias)]
    );
  }
}

async function upsertTaxonomyLinks(
  database: Database,
  itemId: number,
  lookupTable: 'boardgame_categories' | 'boardgame_families' | 'boardgame_mechanics',
  relationTable: 'item_categories' | 'item_families' | 'item_mechanics',
  relationIdColumn: 'category_id' | 'family_id' | 'mechanic_id',
  links: BggNamedLink[]
) {
  for (const link of links) {
    const lookupId = await upsertLookup(database, lookupTable, link);
    await database.query(
      `
      insert into ${relationTable} (item_id, ${relationIdColumn})
      values ($1, $2)
      on conflict do nothing
      `,
      [itemId, lookupId]
    );
  }
}

async function upsertLookup(
  database: Database,
  table: 'boardgame_categories' | 'boardgame_families' | 'boardgame_mechanics' | 'contributors',
  link: BggNamedLink
): Promise<number> {
  const result = await database.query(
    `
    insert into ${table} (bgg_id, name, updated_at)
    values ($1, $2, now())
    on conflict (bgg_id) do update set
      name = excluded.name,
      updated_at = now()
    returning id
    `,
    [link.bggId, link.name]
  );
  const lookupId = idFromRows(result.rows);
  if (lookupId === null) {
    throw new Error(`Failed to upsert ${table}`);
  }
  return lookupId;
}

async function upsertContributors(database: Database, itemId: number, links: BggNamedLink[], role: 'artist' | 'designer') {
  for (const link of links) {
    const contributorId = await upsertLookup(database, 'contributors', link);
    await database.query(
      `
      insert into item_contributors (item_id, contributor_id, contribution_role)
      values ($1, $2, $3)
      on conflict do nothing
      `,
      [itemId, contributorId, role]
    );
  }
}

async function upsertPublishers(database: Database, itemId: number, links: BggNamedLink[]) {
  for (const link of links) {
    const publisherId = await upsertPublisher(database, link);
    await database.query(
      `
      insert into item_publishers (item_id, publisher_id)
      values ($1, $2)
      on conflict do nothing
      `,
      [itemId, publisherId]
    );
  }
}

async function upsertPublisher(database: Database, link: BggNamedLink): Promise<number> {
  const byBggId = await database.query('select id from publishers where bgg_id = $1', [link.bggId]);
  const byBggIdValue = idFromRows(byBggId.rows);
  const normalizedName = normalizeTitle(link.name);

  if (byBggIdValue !== null) {
    await database.query(
      `
      update publishers
      set name = $1,
          normalized_name = $2,
          bgg_id = coalesce(bgg_id, $3),
          updated_at = now()
      where id = $4
      `,
      [link.name, normalizedName, link.bggId, byBggIdValue]
    );
    return byBggIdValue;
  }

  const byName = await database.query('select id from publishers where name = $1', [link.name]);
  const byNameValue = idFromRows(byName.rows);
  if (byNameValue !== null) {
    await database.query(
      `
      update publishers
      set normalized_name = $1,
          bgg_id = coalesce(bgg_id, $2),
          updated_at = now()
      where id = $3
      `,
      [normalizedName, link.bggId, byNameValue]
    );
    return byNameValue;
  }

  const result = await database.query(
    `
    insert into publishers (name, normalized_name, bgg_id, updated_at)
    values ($1, $2, $3, now())
    returning id
    `,
    [link.name, normalizedName, link.bggId]
  );
  const publisherId = idFromRows(result.rows);
  if (publisherId === null) {
    throw new Error('Failed to upsert publisher');
  }
  return publisherId;
}

function bggTypeToItemType(value: string) {
  return value === 'boardgameexpansion' ? 'expansion' : 'base_game';
}

function bggUrl(thing: BggThingDetails) {
  const path = thing.type === 'boardgameexpansion' ? 'boardgameexpansion' : 'boardgame';
  return `https://boardgamegeek.com/${path}/${thing.bggId}`;
}

function dedupeByNormalizedName(values: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    const normalized = normalizeTitle(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(value);
  }
  return deduped;
}

function idFromRows(rows: unknown[]): number | null {
  const row = rows[0] as Record<string, unknown> | undefined;
  const value = row?.id;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
