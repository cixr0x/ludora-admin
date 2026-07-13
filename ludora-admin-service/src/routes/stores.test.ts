import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import type { Database } from '../db.js';
import type { StoreProfileDetectionService } from '../storeProfileDetection/storeProfileDetectionService.js';

describe('stores routes', () => {
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
      'active'
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
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
