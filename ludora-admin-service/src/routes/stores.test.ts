import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import type { Database } from '../db.js';
import type { StoreProfileDetectionService } from '../storeProfileDetection/storeProfileDetectionService.js';

const statisticsFields = [
  'total_items',
  'boardgame_true_confirmed_true',
  'boardgame_true_confirmed_false',
  'boardgame_false_confirmed_true',
  'boardgame_false_confirmed_false',
  'confirmed_boardgame_listed',
  'confirmed_boardgame_pending',
  'confirmed_boardgame_rejected'
];

describe('stores routes', () => {
  it('includes all item statistics in paginated stores without per-store queries', async () => {
    const rows = [{ id: 42, name: 'Example', total_items: 31 }, { id: 43, name: 'Empty', total_items: 0 }];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: normalizeSql(sql).startsWith('select count(*)') ? [{ total: 2 }] : rows };
      }
    };

    const response = await request(createApp({ database })).get('/stores?page=1&page_size=25');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows, meta: { page: 1, page_size: 25, total: 2 } });
    expect(queries).toHaveLength(2);
    const sql = normalizeSql(queries[0]?.sql ?? '');
    expect(sql).toContain('left join lateral (select count(si.id)::integer as total_items');
    expect(sql).toContain('from store_items si where si.store_id = stores.id) store_item_statistics on true');
    for (const field of statisticsFields) {
      expect(sql).toContain(`store_item_statistics.${field}`);
    }
    for (const [boardgame, confirmed, field] of [
      ['true', 'true', 'boardgame_true_confirmed_true'],
      ['true', 'false', 'boardgame_true_confirmed_false'],
      ['false', 'true', 'boardgame_false_confirmed_true'],
      ['false', 'false', 'boardgame_false_confirmed_false']
    ]) {
      expect(sql).toContain(
        `count(si.id) filter (where si.is_boardgame = ${boardgame} and si.is_boardgame_confirmed = ${confirmed})::integer as ${field}`
      );
    }
    for (const status of ['listed', 'pending', 'rejected']) {
      expect(sql).toContain(
        `count(si.id) filter (where si.is_boardgame = true and si.is_boardgame_confirmed = true and si.listing_status = '${status}')::integer as confirmed_boardgame_${status}`
      );
    }
    expect(sql).not.toContain('store_active');
    expect(sql).not.toContain('unlisted');
    expect(queries[0]?.params).toEqual([25, 25]);
  });

  it.each(statisticsFields)('sorts %s numerically and retains text-filter semantics', async (field) => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: normalizeSql(sql).startsWith('select count(*)') ? [{ total: 0 }] : [] };
      }
    };

    const response = await request(createApp({ database })).get('/stores').query({
      page: 0,
      page_size: 25,
      sort: field,
      sort_direction: 'desc',
      [`filter_${field}`]: '1%_'
    });

    expect(response.status).toBe(200);
    expect(normalizeSql(queries[0]?.sql ?? '')).toContain(`order by (store_item_statistics.${field}, stores.id) desc`);
    for (const query of queries) {
      expect(normalizeSql(query.sql)).toContain(`where coalesce((store_item_statistics.${field})::text, '') ilike $1 escape '\\'`);
    }
    expect(queries[0]?.params).toEqual(['%1\\%\\_%', 25, 0]);
    expect(queries[1]?.params).toEqual(['%1\\%\\_%']);
  });

  it('orders ascending metric pages by the unique store ID when counts are tied', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: normalizeSql(sql).startsWith('select count(*)') ? [{ total: 20 }] : [] };
      }
    };

    for (const page of [0, 1]) {
      const response = await request(createApp({ database })).get('/stores').query({
        page, page_size: 3, sort: 'total_items', sort_direction: 'asc'
      });
      expect(response.status).toBe(200);
    }

    const rowQueries = queries.filter(({ sql }) => !normalizeSql(sql).startsWith('select count(*)'));
    expect(rowQueries).toHaveLength(2);
    for (const query of rowQueries) {
      expect(normalizeSql(query.sql)).toContain('order by (store_item_statistics.total_items, stores.id) asc');
    }
    expect(rowQueries.map(({ params }) => params)).toEqual([[3, 0], [3, 3]]);
  });

  it('keeps the unpaginated store-options response free of item aggregation', async () => {
    const queries: string[] = [];
    const row = { id: 42, name: 'Example' };
    const database: Database = { query: async (sql) => { queries.push(sql); return { rows: [row] }; } };

    const response = await request(createApp({ database })).get('/stores');

    expect(response.body).toEqual({ data: [row] });
    expect(queries).toHaveLength(1);
    expect(normalizeSql(queries[0])).not.toContain('store_items');
    expect(normalizeSql(queries[0])).not.toContain('total_items');
  });

  it('returns all item statistics for one store with a single read-only aggregate', async () => {
    const statistics = {
      total_items: 31,
      boardgame_true_confirmed_true: 17,
      boardgame_true_confirmed_false: 7,
      boardgame_false_confirmed_true: 2,
      boardgame_false_confirmed_false: 5,
      confirmed_boardgame_listed: 11,
      confirmed_boardgame_pending: 3,
      confirmed_boardgame_rejected: 2
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [statistics] };
      }
    };

    const response = await request(createApp({ database })).get('/stores/42/item-statistics');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: statistics });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.params).toEqual(['42']);
    const sql = normalizeSql(queries[0]?.sql ?? '');
    expect(sql).toMatch(/^select /);
    expect(sql).toContain('count(si.id)::integer as total_items');
    expect(sql).toContain('from stores s left join store_items si on si.store_id = s.id where s.id = $1 group by s.id');
    for (const [boardgame, confirmed, field] of [
      ['true', 'true', 'boardgame_true_confirmed_true'],
      ['true', 'false', 'boardgame_true_confirmed_false'],
      ['false', 'true', 'boardgame_false_confirmed_true'],
      ['false', 'false', 'boardgame_false_confirmed_false']
    ]) {
      expect(sql).toContain(
        `count(si.id) filter (where si.is_boardgame = ${boardgame} and si.is_boardgame_confirmed = ${confirmed})::integer as ${field}`
      );
    }
    for (const status of ['listed', 'pending', 'rejected']) {
      expect(sql).toContain(
        `count(si.id) filter (where si.is_boardgame = true and si.is_boardgame_confirmed = true and si.listing_status = '${status}')::integer as confirmed_boardgame_${status}`
      );
    }
    expect(sql).not.toContain('active');
    expect(sql).not.toContain('unlisted');
  });

  it('returns zero item statistics for an existing store without items', async () => {
    const statistics = {
      total_items: 0,
      boardgame_true_confirmed_true: 0,
      boardgame_true_confirmed_false: 0,
      boardgame_false_confirmed_true: 0,
      boardgame_false_confirmed_false: 0,
      confirmed_boardgame_listed: 0,
      confirmed_boardgame_pending: 0,
      confirmed_boardgame_rejected: 0
    };
    const database: Database = { query: async () => ({ rows: [statistics] }) };

    const response = await request(createApp({ database })).get('/stores/42/item-statistics');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: statistics });
  });

  it('returns 404 instead of zero statistics when the store is missing', async () => {
    const response = await request(createApp({ database: idleDatabase() })).get('/stores/42/item-statistics');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { message: 'Store not found' } });
  });

  it.each(['0', '-1', '1.5', 'abc', '42or1=1', '9223372036854775808'])(
    'rejects invalid statistics store ID %s before querying',
    async (id) => {
      let queried = false;
      const database: Database = { query: async () => { queried = true; return { rows: [] }; } };

      const response = await request(createApp({ database })).get(`/stores/${id}/item-statistics`);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: { message: 'id must be a positive integer' } });
      expect(queried).toBe(false);
    }
  );

  it('reports statistics query failures instead of returning zeros', async () => {
    const database: Database = { query: async () => { throw new Error('unavailable'); } };

    const response = await request(createApp({ database })).get('/stores/42/item-statistics');

    expect(response.status).toBe(500);
    expect(response.body).toHaveProperty('error');
    expect(response.body).not.toHaveProperty('data');
  });

  it('creates a clean store record', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const row = { canonical_domain: 'example.mx', id: 42, name: 'Example Juegos', website_url: 'https://example.mx/' };
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database })).post('/stores').send({
      active: false,
      canonical_domain: 'www.example.mx',
      city: 'Guadalajara',
      country: 'Mexico',
      facebook_url: 'https://facebook.com/example',
      instagram_url: 'https://instagram.com/example',
      logo_url: 'https://example.mx/logo.png',
      name: 'Example Juegos',
      platform: 'shopify',
      state: 'Jalisco',
      status: 'active',
      website_url: 'https://example.mx/'
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: row });
    expect(normalizeSql(queries[0]?.sql ?? '')).toContain('insert into stores');
    expect(queries[0]?.params).toEqual([
      'Example Juegos',
      'example.mx',
      'https://example.mx/',
      'shopify',
      'https://instagram.com/example',
      'https://facebook.com/example',
      'Guadalajara',
      'Jalisco',
      'Mexico',
      'https://example.mx/logo.png',
      'active',
      false
    ]);
  });

  it('returns detected website details from the injected service', async () => {
    const detected = {
      ai_used: true,
      profile: {
        canonical_domain: 'example.mx',
        city: 'Guadalajara',
        country: 'Mexico',
        facebook_url: '',
        instagram_url: '',
        logo_url: '',
        name: 'Example',
        platform: 'shopify',
        state: 'Jalisco',
        website_url: 'https://example.mx/'
      },
      unresolved_fields: ['facebook_url', 'instagram_url', 'logo_url']
    };
    const storeProfileDetectionService: StoreProfileDetectionService = {
      detect: vi.fn(async () => detected)
    };

    const response = await request(createApp({ database: idleDatabase(), storeProfileDetectionService }))
      .post('/admin/store-profile-detections')
      .send({ website_url: 'example.mx' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: detected });
    expect(storeProfileDetectionService.detect).toHaveBeenCalledWith('example.mx');
  });

  it('returns 409 when the canonical domain already exists', async () => {
    const database: Database = {
      query: async () => {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      }
    };

    const response = await request(createApp({ database })).post('/stores').send({
      canonical_domain: 'example.mx',
      name: 'Example',
      website_url: 'https://example.mx/'
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { message: 'A store with this canonical domain already exists' } });
  });
});

function idleDatabase(): Database {
  return { query: async () => ({ rows: [] }) };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim().toLowerCase();
}
