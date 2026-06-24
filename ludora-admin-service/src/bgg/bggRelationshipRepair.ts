import type { Database } from '../db.js';
import { parseBggThingResponse } from './bggParser.js';

const BGG_THING_REQUEST_TYPE = 'boardgame,boardgameexpansion';

export type BggRelationshipRepairInput = {
  cachedThings: CachedThingRow[];
  items: ItemRow[];
  relationships: RelationshipRow[];
};

export type CachedThingRow = {
  bgg_id: number | string;
  raw_xml: string;
};

export type ItemRow = {
  bgg_id: number | string;
  id: number | string;
  parent_item_id?: number | string | null;
};

export type RelationshipRow = {
  id: number | string;
  item_a_id: number | string;
  item_b_id: number | string;
  link_type: string;
  source: string;
  source_ref?: string | null;
};

export type ExpectedBggRelationship = {
  itemAId: number;
  itemABggId: number;
  itemBId: number;
  itemBBggId: number;
  linkType: 'extension' | 'implementation';
  sourceRef: string;
};

export type BggParentUpdate = {
  itemId: number;
  parentItemId: number;
  previousParentItemId: number | null;
};

export type MissingBggRelationshipTarget = {
  currentBggId: number;
  linkType: 'extension' | 'implementation';
  linkedBggId: number;
  linkedName: string;
};

export type BggRelationshipRepairPlan = {
  expectedRelationships: ExpectedBggRelationship[];
  existingCanonicalRelationshipCount: number;
  malformedCacheBggIds: number[];
  missingRelationships: ExpectedBggRelationship[];
  missingTargets: MissingBggRelationshipTarget[];
  parentUpdates: BggParentUpdate[];
  preservedNonBggRelationshipIds: number[];
  relationshipIdsToDelete: number[];
  staleBggRelationships: ExistingRelationshipSummary[];
  summary: BggRelationshipRepairSummary;
};

export type ExistingRelationshipSummary = {
  id: number;
  itemAId: number;
  itemBId: number;
  linkType: string;
  source: string;
};

export type BggRelationshipRepairSummary = {
  cachedThings: number;
  expectedExtensionRelationships: number;
  expectedImplementationRelationships: number;
  existingCanonicalRelationships: number;
  itemsWithBggId: number;
  malformedCacheRows: number;
  missingRelationships: number;
  missingTargets: number;
  parentUpdates: number;
  preservedNonBggRelationships: number;
  relationshipRowsToDelete: number;
};

export type AppliedBggRelationshipRepair = {
  deletedRelationshipRows: number;
  parentRowsUpdated: number;
  plan: BggRelationshipRepairPlan;
  upsertedRelationshipRows: number;
};

type ItemByBggId = Map<number, { bggId: number; id: number; parentItemId: number | null }>;
type RelationshipKey = `${number}|${'extension' | 'implementation'}|${number}`;
type ParentCandidate = BggParentUpdate & {
  priority: number;
};

export async function loadBggRelationshipRepairPlan(database: Database): Promise<BggRelationshipRepairPlan> {
  const [items, cachedThings, relationships] = await Promise.all([
    database.query(
      `
      select id, bgg_id, parent_item_id
      from items
      where bgg_id is not null
      `
    ),
    database.query(
      `
      select bgg_id, raw_xml
      from bgg_thing_cache
      where request_type = $1
      order by bgg_id asc
      `,
      [BGG_THING_REQUEST_TYPE]
    ),
    database.query(
      `
      select id, item_a_id, link_type, item_b_id, source, source_ref
      from item_relationships
      where link_type in ('extension', 'expansion', 'implementation')
      `
    )
  ]);

  return buildBggRelationshipRepairPlan({
    cachedThings: cachedThings.rows as CachedThingRow[],
    items: items.rows as ItemRow[],
    relationships: relationships.rows as RelationshipRow[]
  });
}

export function buildBggRelationshipRepairPlan(input: BggRelationshipRepairInput): BggRelationshipRepairPlan {
  const itemsByBggId = itemMapByBggId(input.items);
  const itemsById = new Map(Array.from(itemsByBggId.values()).map((item) => [item.id, item]));
  const expectedByKey = new Map<RelationshipKey, ExpectedBggRelationship>();
  const parentByItemId = new Map<number, ParentCandidate>();
  const missingTargets: MissingBggRelationshipTarget[] = [];
  const malformedCacheBggIds: number[] = [];

  for (const cachedThing of input.cachedThings) {
    const cachedBggId = numberOrNull(cachedThing.bgg_id);
    try {
      const thing = parseBggThingResponse(cachedThing.raw_xml);
      if (!thing) {
        continue;
      }

      const currentItem = itemsByBggId.get(thing.bggId);
      if (!currentItem) {
        continue;
      }

      for (const expansionLink of thing.expansionLinks) {
        const linkedItem = itemsByBggId.get(expansionLink.bggId);
        if (!linkedItem) {
          missingTargets.push({
            currentBggId: thing.bggId,
            linkedBggId: expansionLink.bggId,
            linkedName: expansionLink.name,
            linkType: 'extension'
          });
          continue;
        }

        const childItem = expansionLink.inbound ? currentItem : linkedItem;
        const parentItem = expansionLink.inbound ? linkedItem : currentItem;
        addExpectedRelationship(expectedByKey, {
          itemAId: childItem.id,
          itemABggId: childItem.bggId,
          itemBId: parentItem.id,
          itemBBggId: parentItem.bggId,
          linkType: 'extension',
          sourceRef: String(expansionLink.bggId)
        });
        setParentCandidate(parentByItemId, {
          itemId: childItem.id,
          parentItemId: parentItem.id,
          previousParentItemId: childItem.parentItemId,
          priority: expansionLink.inbound ? 2 : 1
        });
      }

      for (const implementationLink of thing.implementationLinks) {
        const linkedItem = itemsByBggId.get(implementationLink.bggId);
        if (!linkedItem) {
          missingTargets.push({
            currentBggId: thing.bggId,
            linkedBggId: implementationLink.bggId,
            linkedName: implementationLink.name,
            linkType: 'implementation'
          });
          continue;
        }

        const itemA = implementationLink.inbound ? currentItem : linkedItem;
        const itemB = implementationLink.inbound ? linkedItem : currentItem;
        addExpectedRelationship(expectedByKey, {
          itemAId: itemA.id,
          itemABggId: itemA.bggId,
          itemBId: itemB.id,
          itemBBggId: itemB.bggId,
          linkType: 'implementation',
          sourceRef: String(implementationLink.bggId)
        });
      }
    } catch {
      if (cachedBggId !== null) {
        malformedCacheBggIds.push(cachedBggId);
      }
    }
  }

  const existingCanonicalKeys = new Set<RelationshipKey>();
  const relationshipIdsToDelete: number[] = [];
  const staleBggRelationships: ExistingRelationshipSummary[] = [];
  const preservedNonBggRelationshipIds: number[] = [];

  for (const relationship of input.relationships) {
    const normalized = normalizeRelationshipRow(relationship);
    if (!normalized) {
      continue;
    }

    const isBggRelationship = normalized.source.toLowerCase() === 'bgg';
    if (normalized.linkType === 'extension' || normalized.linkType === 'implementation') {
      const key = relationshipKey(normalized.itemAId, normalized.linkType, normalized.itemBId);
      if (expectedByKey.has(key)) {
        existingCanonicalKeys.add(key);
        continue;
      }

      if (isBggRelationship) {
        relationshipIdsToDelete.push(normalized.id);
        staleBggRelationships.push(normalized);
      } else {
        preservedNonBggRelationshipIds.push(normalized.id);
      }
      continue;
    }

    if (normalized.linkType === 'expansion') {
      if (isBggRelationship) {
        relationshipIdsToDelete.push(normalized.id);
        staleBggRelationships.push(normalized);
      } else {
        preservedNonBggRelationshipIds.push(normalized.id);
      }
    }
  }

  const expectedRelationships = Array.from(expectedByKey.values()).sort(compareExpectedRelationship);
  const missingRelationships = expectedRelationships.filter(
    (relationship) => !existingCanonicalKeys.has(relationshipKey(relationship.itemAId, relationship.linkType, relationship.itemBId))
  );
  const parentUpdates = Array.from(parentByItemId.values())
    .map(({ itemId, parentItemId, previousParentItemId }) => ({ itemId, parentItemId, previousParentItemId }))
    .filter((update) => update.previousParentItemId !== update.parentItemId)
    .sort((left, right) => left.itemId - right.itemId);

  return {
    expectedRelationships,
    existingCanonicalRelationshipCount: existingCanonicalKeys.size,
    malformedCacheBggIds: malformedCacheBggIds.sort((left, right) => left - right),
    missingRelationships,
    missingTargets,
    parentUpdates,
    preservedNonBggRelationshipIds: uniqueNumbers(preservedNonBggRelationshipIds).sort((left, right) => left - right),
    relationshipIdsToDelete: uniqueNumbers(relationshipIdsToDelete).sort((left, right) => left - right),
    staleBggRelationships,
    summary: {
      cachedThings: input.cachedThings.length,
      expectedExtensionRelationships: expectedRelationships.filter((relationship) => relationship.linkType === 'extension').length,
      expectedImplementationRelationships: expectedRelationships.filter((relationship) => relationship.linkType === 'implementation').length,
      existingCanonicalRelationships: existingCanonicalKeys.size,
      itemsWithBggId: itemsByBggId.size,
      malformedCacheRows: malformedCacheBggIds.length,
      missingRelationships: missingRelationships.length,
      missingTargets: missingTargets.length,
      parentUpdates: parentUpdates.length,
      preservedNonBggRelationships: preservedNonBggRelationshipIds.length,
      relationshipRowsToDelete: relationshipIdsToDelete.length
    }
  };
}

export async function applyBggRelationshipRepair(database: Database): Promise<AppliedBggRelationshipRepair> {
  const plan = await loadBggRelationshipRepairPlan(database);
  const expectedRelationships = plan.expectedRelationships.map((relationship) => ({
    item_a_id: relationship.itemAId,
    item_b_id: relationship.itemBId,
    link_type: relationship.linkType,
    source_ref: relationship.sourceRef
  }));
  const parentUpdates = plan.parentUpdates.map((update) => ({
    item_id: update.itemId,
    parent_item_id: update.parentItemId
  }));

  const result = await database.query(
    `
    with expected_relationships as (
      select *
      from jsonb_to_recordset($1::jsonb) as expected(
        item_a_id bigint,
        link_type text,
        item_b_id bigint,
        source_ref text
      )
    ),
    relationship_deletes as (
      delete from item_relationships
      where id = any($2::bigint[])
      returning id
    ),
    relationship_upserts as (
      insert into item_relationships (item_a_id, link_type, item_b_id, source, source_ref)
      select item_a_id, link_type, item_b_id, 'BGG', source_ref
      from expected_relationships
      on conflict (item_a_id, link_type, item_b_id) do update set
        source = excluded.source,
        source_ref = excluded.source_ref
      returning id
    ),
    parent_updates_input as (
      select *
      from jsonb_to_recordset($3::jsonb) as parent_update(
        item_id bigint,
        parent_item_id bigint
      )
    ),
    parent_updates as (
      update items
      set parent_item_id = parent_updates_input.parent_item_id,
          updated_at = now()
      from parent_updates_input
      where items.id = parent_updates_input.item_id
        and items.parent_item_id is distinct from parent_updates_input.parent_item_id
      returning items.id
    )
    select
      (select count(*) from relationship_deletes)::int as deleted_relationship_rows,
      (select count(*) from relationship_upserts)::int as upserted_relationship_rows,
      (select count(*) from parent_updates)::int as parent_rows_updated
    `,
    [JSON.stringify(expectedRelationships), plan.relationshipIdsToDelete, JSON.stringify(parentUpdates)]
  );
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return {
    deletedRelationshipRows: numberOrNull(row.deleted_relationship_rows) ?? 0,
    parentRowsUpdated: numberOrNull(row.parent_rows_updated) ?? 0,
    plan,
    upsertedRelationshipRows: numberOrNull(row.upserted_relationship_rows) ?? 0
  };
}

function addExpectedRelationship(
  expectedByKey: Map<RelationshipKey, ExpectedBggRelationship>,
  relationship: ExpectedBggRelationship
): void {
  expectedByKey.set(relationshipKey(relationship.itemAId, relationship.linkType, relationship.itemBId), relationship);
}

function setParentCandidate(parentByItemId: Map<number, ParentCandidate>, candidate: ParentCandidate): void {
  const existing = parentByItemId.get(candidate.itemId);
  if (!existing || candidate.priority >= existing.priority) {
    parentByItemId.set(candidate.itemId, candidate);
  }
}

function itemMapByBggId(items: ItemRow[]): ItemByBggId {
  const map: ItemByBggId = new Map();
  for (const item of items) {
    const id = numberOrNull(item.id);
    const bggId = numberOrNull(item.bgg_id);
    if (id === null || bggId === null) {
      continue;
    }
    map.set(bggId, {
      bggId,
      id,
      parentItemId: numberOrNull(item.parent_item_id)
    });
  }
  return map;
}

function normalizeRelationshipRow(relationship: RelationshipRow): ExistingRelationshipSummary | null {
  const id = numberOrNull(relationship.id);
  const itemAId = numberOrNull(relationship.item_a_id);
  const itemBId = numberOrNull(relationship.item_b_id);
  if (id === null || itemAId === null || itemBId === null) {
    return null;
  }

  return {
    id,
    itemAId,
    itemBId,
    linkType: relationship.link_type,
    source: relationship.source
  };
}

function compareExpectedRelationship(left: ExpectedBggRelationship, right: ExpectedBggRelationship): number {
  return (
    left.itemAId - right.itemAId ||
    left.linkType.localeCompare(right.linkType) ||
    left.itemBId - right.itemBId ||
    left.itemABggId - right.itemABggId ||
    left.itemBBggId - right.itemBBggId
  );
}

function relationshipKey(itemAId: number, linkType: 'extension' | 'implementation', itemBId: number): RelationshipKey {
  return `${itemAId}|${linkType}|${itemBId}`;
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values));
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
