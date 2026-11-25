import { setTimeout as delay } from 'node:timers/promises';

import type { Database, SessionDatabase } from '../db.js';
import { prepareCatalogImageHash, type CatalogImageHasher } from '../catalogImageHash.js';
import { normalizeTitle } from '../itemMatching/itemMatcher.js';
import type { BggClient } from './bggClient.js';
import type { BggNamedLink, BggRelatedLink, BggThingDetails } from './bggParser.js';
import { bggTypeToItemType, isBggAccessory } from './bggTypes.js';
import { createBggVersionImports, type BggVersionImports } from './bggVersionImporter.js';

const BGG_IMPORT_REFRESH_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

export type BggItemImporter = {
  importBggId(bggId: number): Promise<number | null>;
} & Partial<BggVersionImports>;

export function createBggItemImporter(database: Database, bggClient?: BggClient, catalogImageHasher?: CatalogImageHasher): BggItemImporter {
  const pendingImports = new Map<number, Promise<number | null>>();

  function importBggId(bggId: number): Promise<number | null> {
    const pending = pendingImports.get(bggId);
    if (pending) return pending;

    const operation = importRegularItem(bggId).finally(() => pendingImports.delete(bggId));
    pendingImports.set(bggId, operation);
    return operation;
  }

  async function importRegularItem(bggId: number): Promise<number | null> {
    const cachedItemId = await freshExistingItemId(database, bggId);
    if (cachedItemId !== null) return cachedItemId;
    if (!bggClient) return null;

    const fetched = await bggClient.fetchThing(bggId);
    return fetched ? importThing(database, bggClient, fetched.details, new Set(), catalogImageHasher) : null;
  }

  return {
    importBggId,
    ...createBggVersionImports(database, bggClient, importBggId, pendingImports, catalogImageHasher)
  };
}

async function importThing(
  database: Database,
  bggClient: BggClient,
  thing: BggThingDetails,
  visited: Set<number>,
  catalogImageHasher?: CatalogImageHasher
): Promise<number> {
  if (visited.has(thing.bggId)) {
    return (await existingItemId(database, thing.bggId)) ?? 0;
  }
  visited.add(thing.bggId);

  const imageHash = await prepareCatalogImageHash(catalogImageHasher, thing.image || thing.thumbnail);
  const itemId = await persistItemMetadata(database, thing, imageHash);
  await upsertRelatedItems(database, bggClient, itemId, thing, visited, catalogImageHasher);
  return itemId;
}

async function persistItemMetadata(database: Database, thing: BggThingDetails, imageHash: string | null): Promise<number> {
  const persist = async (session: Database) => {
    const itemId = await upsertItem(session, thing, imageHash);
    await upsertAliases(session, itemId, thing.alternateNames);
    await upsertTaxonomyLinks(session, itemId, 'boardgame_categories', 'item_categories', 'category_id', thing.categories);
    await upsertTaxonomyLinks(session, itemId, 'boardgame_mechanics', 'item_mechanics', 'mechanic_id', thing.mechanics);
    await upsertTaxonomyLinks(session, itemId, 'boardgame_families', 'item_families', 'family_id', thing.families);
    await upsertContributors(session, itemId, thing.designers, 'designer');
    await upsertContributors(session, itemId, thing.artists, 'artist');
    await upsertPublishers(session, itemId, thing.publishers);
    return itemId;
  };

  const sessionDatabase = database as Partial<SessionDatabase>;
  if (!sessionDatabase.withSession) return persist(database);

  // An edition can copy this row and its taxonomy as soon as another session sees the parent.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await sessionDatabase.withSession(async (session) => {
        await session.query('begin');
        try {
          const itemId = await persist(session);
          await session.query('commit');
          return itemId;
        } catch (error) {
          try {
            await session.query('rollback');
          } catch {
            await session.close?.();
          }
          throw error;
        }
      });
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (attempt === 3 || (code !== '55P03' && code !== '40P01')) throw error;
      await delay(attempt * 50);
    }
  }
}

async function upsertItem(database: Database, thing: BggThingDetails, imageHash: string | null): Promise<number> {
  const existingId = await existingItemId(database, thing.bggId);
  const imageUrl = thing.image || thing.thumbnail;
  const params = [
    thing.name,
    normalizeTitle(thing.name),
    bggTypeToItemType(thing.type),
    isBggAccessory(thing.type),
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
    imageUrl,
    imageHash,
    thing.type === 'rpgitem'
  ];

  if (existingId !== null) {
    const result = await database.query(
      `
      update items
      set canonical_name = $1,
          normalized_name = $2,
          item_type = $3,
          is_accessory = $4,
          parent_item_id = coalesce(parent_item_id, $5),
          bgg_id = $6,
          bgg_url = $7,
          bgg_last_sync_at = now(),
          year_published = $8,
          rating = $9,
          weight = $10,
          description = $11,
          min_players = $12,
          max_players = $13,
          min_minutes = $14,
          max_minutes = $15,
          min_age = $16,
          image_url = $17,
          image_phash = $18,
          is_rpg = $19,
          status = 'active',
          updated_at = now()
      where id = $20
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
      is_accessory,
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
      image_phash,
      is_rpg,
      status,
      updated_at
    )
    values ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'active', now())
    on conflict (is_version, bgg_id) where bgg_id is not null do nothing
    returning id
    `,
    params
  );
  const itemId = idFromRows(result.rows) ?? await existingItemId(database, thing.bggId);
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
  visited: Set<number>,
  catalogImageHasher?: CatalogImageHasher
) {
  let lastParentId: number | null = null;
  for (const parentLink of thing.parentLinks) {
    const parentId = await importLinkedThing(database, bggClient, parentLink, visited, catalogImageHasher);
    if (!parentId) {
      continue;
    }
    const [itemAId, itemBId] = bggRelationshipItemIds(itemId, parentId, parentLink);
    await upsertItemRelationship(database, itemAId, 'extension', itemBId, String(parentLink.bggId));
    lastParentId = parentId;
  }
  if (lastParentId !== null) {
    await updateParentItem(database, itemId, lastParentId);
  }

  for (const implementationLink of thing.implementationLinks) {
    const implementationId = await importLinkedThing(database, bggClient, implementationLink, visited, catalogImageHasher);
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
  visited: Set<number>,
  catalogImageHasher?: CatalogImageHasher
): Promise<number | null> {
  const cachedItemId = await freshExistingItemId(database, link.bggId);
  if (cachedItemId !== null) {
    return cachedItemId;
  }

  const fetched = await bggClient.fetchThing(link.bggId);
  if (!fetched) {
    return null;
  }
  const linkedId = await importThing(database, bggClient, fetched.details, visited, catalogImageHasher);
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

function bggUrl(thing: BggThingDetails) {
  if (thing.type === 'rpgitem') {
    return `https://rpggeek.com/rpgitem/${thing.bggId}`;
  }
  const path = thing.type === 'boardgameaccessory' ? 'boardgameaccessory' : thing.type === 'boardgameexpansion' ? 'boardgameexpansion' : 'boardgame';
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
  const existing = await database.query('select id from items where bgg_id = $1 and not is_version', [bggId]);
  return idFromRows(existing.rows);
}

async function freshExistingItemId(database: Database, bggId: number): Promise<number | null> {
  const existing = await database.query('select id, bgg_last_sync_at from items where bgg_id = $1 and not is_version', [bggId]);
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
