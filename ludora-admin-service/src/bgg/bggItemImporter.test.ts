import { describe, expect, it } from 'vitest';

import type { BggClient } from './bggClient.js';
import { createBggItemImporter } from './bggItemImporter.js';
import type { Database } from '../db.js';

describe('BGG item importer', () => {
  it('imports BGG item metadata into catalog tables', async () => {
    const fetchedBggIds: number[] = [];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        const normalized = normalizeSql(sql);

        if (normalized.startsWith('select id from items where bgg_id')) {
          return { rows: [] };
        }
        if (normalized.startsWith('insert into items')) {
          return { rows: [{ id: 77 }] };
        }
        if (normalized.startsWith('insert into item_aliases')) {
          return { rows: [] };
        }
        if (normalized.startsWith('insert into boardgame_categories')) {
          return { rows: [{ id: 10 }] };
        }
        if (normalized.startsWith('insert into boardgame_mechanics')) {
          return { rows: [{ id: 20 }] };
        }
        if (normalized.startsWith('insert into boardgame_families')) {
          return { rows: [{ id: 30 }] };
        }
        if (normalized.startsWith('insert into contributors')) {
          return { rows: [{ id: String(params?.[0]) === '150113' ? 40 : 41 }] };
        }
        if (normalized.startsWith('select id from publishers where bgg_id')) {
          return { rows: [] };
        }
        if (normalized.startsWith('select id from publishers where name')) {
          return { rows: [] };
        }
        if (normalized.startsWith('insert into publishers')) {
          return { rows: [{ id: 50 }] };
        }
        return { rows: [] };
      }
    };
    const bggClient: BggClient = {
      fetchThing: async (bggId) => {
        fetchedBggIds.push(bggId);
        return {
          details: {
            alternateNames: ['Cafe Barista'],
            artists: [{ bggId: 157654, name: 'Siwon Hwang' }],
            bggId,
            categories: [{ bggId: 1021, name: 'Economic' }],
            description: 'A coffee shop game.',
            designers: [{ bggId: 150113, name: 'Euijin Han' }],
            families: [{ bggId: 46953, name: 'Food & Drink: Coffee' }],
            image: 'https://example.com/original.jpg',
            maxPlayers: 4,
            maxPlaytime: 40,
            mechanics: [{ bggId: 2912, name: 'Contracts' }],
            minAge: 8,
            minPlayers: 2,
            minPlaytime: 20,
            name: 'Coffee Rush',
            parentLinks: [],
            playingTime: 30,
            publishers: [{ bggId: 8291, name: 'Korea Boardgames' }],
            rating: 7.48231,
            thumbnail: 'https://example.com/small.jpg',
            type: 'boardgame',
            implementationLinks: [],
            weight: 1.9234,
            yearPublished: 2023
          },
          rawXml: '<items />'
        };
      },
      search: async () => []
    };

    const itemId = await createBggItemImporter(database, bggClient).importBggId(377061);

    expect(itemId).toBe(77);
    expect(fetchedBggIds).toEqual([377061]);
    const insertItemQuery = queries.find((query) => normalizeSql(query.sql).startsWith('insert into items'));
    expect(insertItemQuery).toBeDefined();
    expect(normalizeSql(insertItemQuery?.sql ?? '')).toContain('rating');
    expect(normalizeSql(insertItemQuery?.sql ?? '')).toContain('weight');
    expect(insertItemQuery?.params?.slice(6, 10)).toEqual([2023, 7.48231, 1.9234, 'A coffee shop game.']);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into item_aliases'))).toBe(true);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into boardgame_categories'))).toBe(true);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into item_categories'))).toBe(true);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into boardgame_mechanics'))).toBe(true);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into item_mechanics'))).toBe(true);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into boardgame_families'))).toBe(true);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into item_families'))).toBe(true);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into contributors'))).toBe(true);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into item_contributors'))).toBe(true);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into publishers'))).toBe(true);
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into item_publishers'))).toBe(true);
  });

  it('imports BGG parent and implementation relationships for related items', async () => {
    const fetchedBggIds: number[] = [];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const itemIdsByBggId = new Map<number, number>([
      [34691, 77],
      [13, 78],
      [999001, 79]
    ]);
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        const normalized = normalizeSql(sql);

        if (normalized.startsWith('select id from items where bgg_id')) {
          return { rows: [] };
        }
        if (normalized.startsWith('insert into items')) {
          return { rows: [{ id: itemIdsByBggId.get(Number(params?.[4])) }] };
        }
        if (normalized.startsWith('insert into item_aliases')) {
          return { rows: [] };
        }
        if (normalized.startsWith('insert into item_relationships')) {
          return { rows: [] };
        }
        if (normalized.startsWith('update items set parent_item_id')) {
          return { rows: [] };
        }
        if (normalized.startsWith('select id from publishers where bgg_id')) {
          return { rows: [] };
        }
        if (normalized.startsWith('select id from publishers where name')) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };
    const bggClient: BggClient = {
      fetchThing: async (bggId) => {
        fetchedBggIds.push(bggId);
        const details = {
          alternateNames: [],
          artists: [],
          bggId,
          categories: [],
          description: `${bggId} description`,
          designers: [],
          families: [],
          image: '',
          maxPlayers: null,
          maxPlaytime: null,
          mechanics: [],
          minAge: null,
          minPlayers: null,
          minPlaytime: null,
          name: String(
            {
              13: 'Catan',
              34691: 'Catan: 5-6 Player Extension',
              999001: 'Catan Dice Game'
            }[bggId] ?? `BGG ${bggId}`
          ),
          parentLinks:
            bggId === 34691 ? [{ bggId: 13, inbound: true, name: 'Catan' }] : [],
          playingTime: null,
          publishers: [],
          rating: null,
          thumbnail: '',
          type: bggId === 34691 ? 'boardgameexpansion' : 'boardgame',
          implementationLinks:
            bggId === 34691 ? [{ bggId: 999001, inbound: false, name: 'Catan Dice Game' }] : [],
          weight: null,
          yearPublished: null
        };
        return { details, rawXml: '<items />' };
      },
      search: async () => []
    };

    const itemId = await createBggItemImporter(database, bggClient).importBggId(34691);

    expect(itemId).toBe(77);
    expect(fetchedBggIds).toEqual([34691, 13, 999001]);
    const relationshipQueries = queries.filter((query) => normalizeSql(query.sql).includes('insert into item_relationships'));
    expect(relationshipQueries.map((query) => query.params)).toEqual([
      [77, 'extension', 78, '13'],
      [77, 'implementation', 79, '999001']
    ]);
    const extensionRelationshipQuery = relationshipQueries.find((query) => query.params?.[1] === 'extension');
    expect(normalizeSql(extensionRelationshipQuery?.sql ?? '')).toContain("relationship_input.link_type in ('extension', 'implementation')");
    const parentUpdate = queries.find((query) => normalizeSql(query.sql).startsWith('update items set parent_item_id'));
    expect(parentUpdate?.params).toEqual([78, 77]);
  });

  it('cleans up reciprocal implementation relationships during recursive BGG imports', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const insertedItemIdsByBggId = new Map<number, number>();
    const itemIdsByBggId = new Map<number, number>([
      [100, 77],
      [200, 88]
    ]);
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        const normalized = normalizeSql(sql);

        if (normalized.startsWith('select id from items where bgg_id')) {
          const itemId = insertedItemIdsByBggId.get(Number(params?.[0]));
          return { rows: itemId ? [{ id: itemId }] : [] };
        }
        if (normalized.startsWith('insert into items')) {
          const bggId = Number(params?.[4]);
          const itemId = itemIdsByBggId.get(bggId);
          if (itemId) {
            insertedItemIdsByBggId.set(bggId, itemId);
          }
          return { rows: [{ id: itemId }] };
        }
        if (normalized.startsWith('insert into item_aliases')) {
          return { rows: [] };
        }
        if (normalized.startsWith('select id from publishers where bgg_id')) {
          return { rows: [] };
        }
        if (normalized.startsWith('select id from publishers where name')) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };
    const bggClient: BggClient = {
      fetchThing: async (bggId) => ({
        details: {
          alternateNames: [],
          artists: [],
          bggId,
          categories: [],
          description: `${bggId} description`,
          designers: [],
          families: [],
          image: '',
          maxPlayers: null,
          maxPlaytime: null,
          mechanics: [],
          minAge: null,
          minPlayers: null,
          minPlaytime: null,
          name: bggId === 100 ? 'Coffee Rush Dice' : 'Coffee Rush',
          parentLinks: [],
          playingTime: null,
          publishers: [],
          rating: null,
          thumbnail: '',
          type: 'boardgame',
          implementationLinks:
            bggId === 100
              ? [{ bggId: 200, inbound: false, name: 'Coffee Rush' }]
              : [{ bggId: 100, inbound: true, name: 'Coffee Rush Dice' }],
          weight: null,
          yearPublished: null
        },
        rawXml: '<items />'
      }),
      search: async () => []
    };

    const itemId = await createBggItemImporter(database, bggClient).importBggId(100);

    expect(itemId).toBe(77);
    const relationshipQueries = queries.filter(
      (query) => normalizeSql(query.sql).includes('insert into item_relationships') && query.params?.[1] === 'implementation'
    );
    expect(relationshipQueries.map((query) => query.params)).toEqual([
      [88, 'implementation', 77, '100'],
      [77, 'implementation', 88, '200']
    ]);
    expect(relationshipQueries.every((query) => normalizeSql(query.sql).includes('removed_inverse_relationship as'))).toBe(true);
    expect(relationshipQueries.every((query) => normalizeSql(query.sql).includes('delete from item_relationships inverse_relationship'))).toBe(
      true
    );
  });
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
