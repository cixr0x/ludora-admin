import type { Database } from '../db.js';
import { normalizeTitle } from '../itemMatching/itemMatcher.js';
import type { BggClient } from './bggClient.js';
import type { BggNamedLink, BggRelatedLink, BggThingDetails } from './bggParser.js';

const BGG_IMPORT_REFRESH_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

export type BggItemImporter = {
  importBggId(bggId: number): Promise<number | null>;
};

export function createBggItemImporter(database: Database, bggClient?: BggClient): BggItemImporter {
  return {
    async importBggId(bggId: number): Promise<number | null> {
      const cachedItemId = await freshExistingItemId(database, bggId);
      if (cachedItemId !== null) {
        return cachedItemId;
      }

      if (!bggClient) {
        return null;
      }

      const fetched = await bggClient.fetchThing(bggId);
      if (!fetched) {
        return null;
      }

      return importThing(database, bggClient, fetched.details, new Set());
    }
  };
}

async function importThing(
  database: Database,
  bggClient: BggClient,
  thing: BggThingDetails,
  visited: Set<number>
): Promise<number> {
  if (visited.has(thing.bggId)) {
    return (await existingItemId(database, thing.bggId)) ?? 0;
  }
  visited.add(thing.bggId);

  const itemId = await upsertItem(database, thing);
  await upsertAliases(database, itemId, thing.alternateNames);
  await upsertTaxonomyLinks(database, itemId, 'boardgame_categories', 'item_categories', 'category_id', thing.categories);
  await upsertTaxonomyLinks(database, itemId, 'boardgame_mechanics', 'item_mechanics', 'mechanic_id', thing.mechanics);
  await upsertTaxonomyLinks(database, itemId, 'boardgame_families', 'item_families', 'family_id', thing.families);
  await upsertContributors(database, itemId, thing.designers, 'designer');
  await upsertContributors(database, itemId, thing.artists, 'artist');
  await upsertPublishers(database, itemId, thing.publishers);
  await upsertRelatedItems(database, bggClient, itemId, thing, visited);
  return itemId;
}

async function upsertItem(database: Database, thing: BggThingDetails): Promise<number> {
  const existingId = await existingItemId(database, thing.bggId);
  const params = [
    thing.name,
    normalizeTitle(thing.name),
    bggTypeToItemType(thing.type),
    null,
    thing.bggId,
    bggUrl(thing),
    thing.yearPublished,
    thing.rating,
    thing.weight,
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
          rating = $8,
          weight = $9,
          description = $10,
          min_players = $11,
          max_players = $12,
          min_minutes = $13,
          max_minutes = $14,
          min_age = $15,
          image_url = $16,
          status = 'active',
          updated_at = now()
      where id = $17
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
      rating,
      weight,
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
    values ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'active', now())
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

async function upsertRelatedItems(
  database: Database,
  bggClient: BggClient,
  itemId: number,
  thing: BggThingDetails,
  visited: Set<number>
) {
  for (const parentLink of thing.parentLinks) {
    const parentId = await importLinkedThing(database, bggClient, parentLink, visited);
    if (!parentId) {
      continue;
    }
    const [itemAId, itemBId] = bggRelationshipItemIds(itemId, parentId, parentLink);
    await upsertItemRelationship(database, itemAId, 'extension', itemBId, String(parentLink.bggId));
    await updateParentItem(database, itemId, parentId);
  }

  for (const implementationLink of thing.implementationLinks) {
    const implementationId = await importLinkedThing(database, bggClient, implementationLink, visited);
    if (!implementationId) {
      continue;
    }
    const [itemAId, itemBId] = bggRelationshipItemIds(itemId, implementationId, implementationLink);
    await upsertItemRelationship(database, itemAId, 'implementation', itemBId, String(implementationLink.bggId));
  }
}

function bggRelationshipItemIds(currentItemId: number, linkedItemId: number, link: BggRelatedLink): [number, number] {
  return link.inbound ? [currentItemId, linkedItemId] : [linkedItemId, currentItemId];
}

async function importLinkedThing(
  database: Database,
  bggClient: BggClient,
  link: BggRelatedLink,
  visited: Set<number>
): Promise<number | null> {
  const cachedItemId = await freshExistingItemId(database, link.bggId);
  if (cachedItemId !== null) {
    return cachedItemId;
  }

  const fetched = await bggClient.fetchThing(link.bggId);
  if (!fetched) {
    return null;
  }
  const linkedId = await importThing(database, bggClient, fetched.details, visited);
  return linkedId || null;
}

async function upsertItemRelationship(
  database: Database,
  itemAId: number,
  linkType: 'extension' | 'implementation',
  itemBId: number,
  sourceRef: string
) {
  await database.query(
    `
    with relationship_input as (
      select
        $1::bigint as item_a_id,
        $2::text as link_type,
        $3::bigint as item_b_id,
        $4::text as source_ref
    ),
    removed_inverse_relationship as (
      delete from item_relationships inverse_relationship
      using relationship_input
      where relationship_input.link_type in ('extension', 'implementation')
        and inverse_relationship.link_type = relationship_input.link_type
        and inverse_relationship.item_a_id = relationship_input.item_b_id
        and inverse_relationship.item_b_id = relationship_input.item_a_id
      returning inverse_relationship.id
    )
    insert into item_relationships (item_a_id, link_type, item_b_id, source, source_ref)
    select relationship_input.item_a_id, relationship_input.link_type, relationship_input.item_b_id, 'BGG', relationship_input.source_ref
    from relationship_input
    cross join (select count(*) as deleted_count from removed_inverse_relationship) inverse_cleanup
    on conflict (item_a_id, link_type, item_b_id) do update set
      source = excluded.source,
      source_ref = excluded.source_ref
    `,
    [itemAId, linkType, itemBId, sourceRef]
  );
}

async function updateParentItem(database: Database, itemId: number, parentItemId: number) {
  await database.query(
    `
    update items
    set parent_item_id = $1,
        updated_at = now()
    where id = $2
    `,
    [parentItemId, itemId]
  );
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

async function existingItemId(database: Database, bggId: number): Promise<number | null> {
  const existing = await database.query('select id from items where bgg_id = $1', [bggId]);
  return idFromRows(existing.rows);
}

async function freshExistingItemId(database: Database, bggId: number): Promise<number | null> {
  const existing = await database.query('select id, bgg_last_sync_at from items where bgg_id = $1', [bggId]);
  const row = existing.rows[0] as Record<string, unknown> | undefined;
  if (!row || !isFreshBggSync(row.bgg_last_sync_at)) {
    return null;
  }
  return idFromRows([row]);
}

function isFreshBggSync(value: unknown): boolean {
  if (!value) {
    return false;
  }

  const syncedAt = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(syncedAt) && Date.now() - syncedAt <= BGG_IMPORT_REFRESH_AFTER_MS;
}

function idFromRows(rows: unknown[]): number | null {
  const row = rows[0] as Record<string, unknown> | undefined;
  const value = row?.id;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
