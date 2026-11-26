import { prepareCatalogImageHash, type CatalogImageHasher } from '../catalogImageHash.js';
import type { Database } from '../db.js';
import { normalizeTitle } from '../itemMatching/itemMatcher.js';
import type { BggClient } from './bggClient.js';
import type { BggVersion } from './bggParser.js';

type ImportedVersion = {
  bgg_id: string | number;
  id: string | number;
  version_of: string | number;
};

type RegularItem = {
  id: number;
  itemType: string;
  parentItemId: number | null;
};

type ListedVersion = {
  bgg_id: number;
  bgg_type: BggVersion['type'];
  name: string;
  nickname: string;
  image_url: string;
  thumbnail_url: string;
  item_id: string | number | null;
};

export type BggVersionImports = {
  importBggVersion(parentBggId: number, versionBggId: number, description?: string, nickname?: string): Promise<number | null>;
  listBggVersions(itemId: number): Promise<ListedVersion[] | null>;
};

export function createBggVersionImports(
  database: Database,
  bggClient: BggClient | undefined,
  importBggId: (bggId: number) => Promise<number | null>,
  pendingImports: ReadonlyMap<number, Promise<number | null>>,
  catalogImageHasher?: CatalogImageHasher
): BggVersionImports {
  return {
    async importBggVersion(parentBggId, versionBggId, description = '', nickname = '') {
      const existing = await existingVersion(database, parentBggId, versionBggId);
      if (existing !== null) return existing;

      const versions = await fetchVersions(bggClient, parentBggId);
      const edition = versions?.find((version) => version.bggId === versionBggId);
      if (!edition) return null;

      let parent = await existingRegularItem(database, parentBggId);
      const pendingParent = pendingImports.get(parentBggId);
      if (pendingParent || !parent) {
        const importedParentId = await (pendingParent ?? importBggId(parentBggId));
        if (importedParentId === null) return null;
        parent = await existingRegularItem(database, parentBggId);
      }
      if (!parent) return null;

      const baseItemId = parent.itemType === 'expansion' && parent.parentItemId === null
        ? await resolveExpansionBase(database, bggClient, importBggId, parentBggId)
        : null;
      const importEdition = { ...edition, nickname: edition.nickname || nickname.trim() };
      const image = edition.image || edition.thumbnail;
      const imageHash = await prepareCatalogImageHash(catalogImageHasher, image);
      const inserted = await createVersion(database, parent.id, parentBggId, importEdition, image, imageHash, description.trim(), baseItemId);
      return inserted ?? await existingVersion(database, parentBggId, versionBggId);
    },

    async listBggVersions(itemId) {
      const parent = await database.query(
        'select bgg_id from items where id = $1 and not is_version and not is_rpg and bgg_id > 0',
        [itemId]
      );
      const parentBggId = Number((parent.rows[0] as { bgg_id?: unknown } | undefined)?.bgg_id);
      if (!Number.isSafeInteger(parentBggId) || parentBggId <= 0) return null;

      const versions = await fetchVersions(bggClient, parentBggId);
      if (versions === null) return null;
      if (versions.length === 0) return [];
      const imported = await database.query(
        'select id, bgg_id from items where is_version and version_of = $1 and bgg_id = any($2::bigint[])',
        [parentBggId, versions.map((edition) => edition.bggId)]
      );
      const itemIds = new Map((imported.rows as ImportedVersion[]).map((item) => [Number(item.bgg_id), item.id]));
      return versions.map((edition) => ({
        bgg_id: edition.bggId,
        bgg_type: edition.type,
        name: edition.name,
        nickname: edition.nickname,
        image_url: edition.image || edition.thumbnail,
        thumbnail_url: edition.thumbnail || edition.image,
        item_id: itemIds.get(edition.bggId) ?? null
      }));
    }
  };
}

async function fetchVersions(bggClient: BggClient | undefined, parentBggId: number): Promise<BggVersion[] | null> {
  if (!bggClient?.fetchVersions) {
    throw Object.assign(new Error('BGG editions are unavailable'), { status: 503 });
  }
  try {
    return await bggClient.fetchVersions(parentBggId);
  } catch (error) {
    throw Object.assign(new Error('BGG editions could not be loaded', { cause: error }), { status: 502 });
  }
}

async function existingRegularItem(database: Database, bggId: number): Promise<RegularItem | null> {
  const result = await database.query(
    'select id, item_type, parent_item_id from items where bgg_id = $1 and not is_version',
    [bggId]
  );
  const row = result.rows[0] as { id: unknown; item_type: string; parent_item_id: unknown } | undefined;
  const id = rowId(row);
  return row && id !== null
    ? { id, itemType: row.item_type, parentItemId: rowId({ id: row.parent_item_id }) }
    : null;
}

async function resolveExpansionBase(
  database: Database,
  bggClient: BggClient | undefined,
  importBggId: (bggId: number) => Promise<number | null>,
  parentBggId: number
): Promise<number | null> {
  let parent;
  try {
    parent = await bggClient?.fetchThing(parentBggId);
  } catch (error) {
    throw Object.assign(new Error('The BGG expansion could not be loaded'), { status: 502, cause: error });
  }
  if (parent?.details.bggId !== parentBggId) {
    throw Object.assign(new Error('The BGG expansion could not be loaded'), { status: 502 });
  }

  // The regular importer retains the last resolvable inbound link for expansions with several bases.
  const baseLinks = parent.details.parentLinks.filter((link) => link.bggId !== parentBggId);
  for (const { bggId } of baseLinks.reverse()) {
    const existingBase = await existingRegularItem(database, bggId);
    const baseItemId = existingBase?.id ?? await importBggId(bggId);
    if (baseItemId !== null) return baseItemId;
  }
  if (baseLinks.length) {
    throw Object.assign(new Error('The base item for the BGG expansion could not be loaded'), { status: 502 });
  }
  return null;
}

async function existingVersion(database: Database, parentBggId: number, versionBggId: number): Promise<number | null> {
  const result = await database.query('select id, version_of from items where bgg_id = $1 and is_version', [versionBggId]);
  const existing = result.rows[0] as ImportedVersion | undefined;
  if (existing && Number(existing.version_of) !== parentBggId) {
    throw Object.assign(new Error('BGG edition is already linked to another parent'), { status: 409 });
  }
  return rowId(existing);
}

async function createVersion(
  database: Database,
  parentId: number,
  parentBggId: number,
  version: BggVersion,
  image: string,
  imageHash: string | null,
  description: string,
  baseItemId: number | null
): Promise<number | null> {
  const name = importedVersionName(version);
  const result = await database.query(
    `
    with parent as (
      select * from items
      where id = $1 and bgg_id = $9 and not is_version and not is_rpg
    ), edition as (
      insert into items (
        canonical_name, normalized_name, item_type, is_accessory, is_rpg, parent_item_id,
        bgg_id, bgg_url, is_version, version_of, bgg_last_sync_at,
        year_published, rating, weight, description, description_es,
        min_players, max_players, min_minutes, max_minutes, complexity, min_age,
        image_url, image_phash, status
      )
      select
        $3, $4, parent.item_type, parent.is_accessory, parent.is_rpg, coalesce(parent.parent_item_id, $10),
        $2, $5, true, parent.bgg_id, now(),
        parent.year_published, parent.rating, parent.weight,
        coalesce(nullif($7, ''), parent.description),
        case when $7 = '' then parent.description_es else '' end,
        parent.min_players, parent.max_players, parent.min_minutes, parent.max_minutes, parent.complexity, parent.min_age,
        $6, $8, 'active'
      from parent
      on conflict (is_version, bgg_id) where bgg_id is not null do nothing
      returning id
    ), categories as (
      insert into item_categories (item_id, category_id)
      select edition.id, category_id from edition cross join item_categories where item_id = $1
    ), mechanics as (
      insert into item_mechanics (item_id, mechanic_id)
      select edition.id, mechanic_id from edition cross join item_mechanics where item_id = $1
    ), families as (
      insert into item_families (item_id, family_id)
      select edition.id, family_id from edition cross join item_families where item_id = $1
    ), contributors as (
      insert into item_contributors (item_id, contributor_id, contribution_role)
      select edition.id, contributor_id, contribution_role
      from edition cross join item_contributors where item_id = $1
    ), publishers as (
      insert into item_publishers (item_id, publisher_id)
      select edition.id, publisher_id from edition cross join item_publishers where item_id = $1
    )
    select id from edition
    `,
    [parentId, version.bggId, name, normalizeTitle(name),
     `https://boardgamegeek.com/${version.type}/${version.bggId}`, image, description, imageHash, parentBggId, baseItemId]
  );
  return rowId(result.rows[0]);
}

function importedVersionName(version: BggVersion): string {
  const name = version.name.trim();
  const nickname = version.nickname.trim();
  const comparableName = name.toLowerCase();
  const comparableNickname = nickname.toLowerCase();
  if (!nickname || comparableName === comparableNickname || comparableName.includes(`(${comparableNickname})`)) {
    return name;
  }
  return `${name} (${nickname})`;
}

function rowId(row: unknown): number | null {
  const id = Number((row as { id?: unknown } | undefined)?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
