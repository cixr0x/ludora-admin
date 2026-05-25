import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { Database } from './db.js';

describe('ludora admin service', () => {
  const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase();

  it('returns health status', async () => {
    const database: Database = {
      query: async () => ({ rows: [] })
    };

    const response = await request(createApp({ database })).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'ludora-admin-service'
    });
  });

  it('returns discovery stores from the injected database query', async () => {
    const rows = [
      { id: 'store-1', name: 'Downtown Games' },
      { id: 'store-2', name: 'Tabletop Hub' }
    ];
    const queries: string[] = [];
    const database: Database = {
      query: async (sql) => {
        queries.push(sql);
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get('/discovery/stores');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows });
    const sql = normalizeSql(queries[0] ?? '');
    expect(sql).toContain('from discovery_store_candidates');
    expect(sql).toContain('order by last_seen_at desc');
    expect(sql).toContain('limit 200');
  });

  it('queries discovery listing candidates by recency', async () => {
    const queries: string[] = [];
    const database: Database = {
      query: async (sql) => {
        queries.push(sql);
        return { rows: [] };
      }
    };

    const response = await request(createApp({ database })).get('/discovery/listings');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [] });
    const sql = normalizeSql(queries[0] ?? '');
    expect(sql).toContain('from discovery_listing_candidates');
    expect(sql).toContain('order by last_seen_at desc');
    expect(sql).toContain('limit 200');
  });

  it('queries admin review tasks by latest update', async () => {
    const queries: string[] = [];
    const database: Database = {
      query: async (sql) => {
        queries.push(sql);
        return { rows: [] };
      }
    };

    const response = await request(createApp({ database })).get('/admin/review-tasks');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [] });
    const sql = normalizeSql(queries[0] ?? '');
    expect(sql).toContain('from admin_review_tasks');
    expect(sql).toContain('order by updated_at desc');
    expect(sql).toContain('limit 200');
  });

  it('returns JSON errors when database queries fail', async () => {
    const database: Database = {
      query: async () => {
        throw new Error('database unavailable');
      }
    };

    const response = await request(createApp({ database })).get('/discovery/stores');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        message: 'database unavailable'
      }
    });
  });

  it('returns a stable 400 response for malformed JSON bodies', async () => {
    const database: Database = {
      query: async () => ({ rows: [] })
    };

    const response = await request(createApp({ database }))
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        message: 'Invalid JSON body'
      }
    });
  });
});
