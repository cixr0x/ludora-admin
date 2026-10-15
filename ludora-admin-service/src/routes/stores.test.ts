import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import type { Database } from '../db.js';
import type { StoreProfileDetectionService } from '../storeProfileDetection/storeProfileDetectionService.js';

describe('stores routes', () => {
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
