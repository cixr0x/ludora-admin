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
            playingTime: 30,
            publishers: [{ bggId: 8291, name: 'Korea Boardgames' }],
            thumbnail: 'https://example.com/small.jpg',
            type: 'boardgame',
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
    expect(queries.some((query) => normalizeSql(query.sql).startsWith('insert into items'))).toBe(true);
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
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
