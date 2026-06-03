import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { DescriptionGenerationRequest, DescriptionGenerationService } from './descriptionGeneration/descriptionGenerationService.js';
import type { Database } from './db.js';
import { DiscoveryApiError, type DiscoveryOperationsClient, type StoreDiscoveryRun } from './discoveryOperationsClient.js';
import type { ItemMatchingService } from './itemMatching/itemMatchingService.js';
import type { TranslationRequest, TranslationService } from './translation/translationService.js';

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

  it('returns CORS headers for configured local UI origins', async () => {
    const database: Database = {
      query: async () => ({ rows: [] })
    };
    const app = createApp({
      database,
      corsOrigin: ['http://localhost:5173', 'http://127.0.0.1:5173']
    });

    const localhostResponse = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    const loopbackResponse = await request(app).get('/health').set('Origin', 'http://127.0.0.1:5173');

    expect(localhostResponse.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(loopbackResponse.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
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
    expect(sql).toContain(
      'select id, store_name, canonical_domain, website_url, instagram_url, facebook_url, city, state, country, store_logo, status, confidence, source_queries, evidence, first_seen_at, last_seen_at'
    );
    expect(sql).not.toContain('accepted');
    expect(sql).toContain('from discovery_store_candidates');
    expect(sql).toContain('order by last_seen_at desc');
    expect(sql).toContain('limit 200');
    expect(sql).not.toContain('select *');
  });

  it('returns clean stores from the injected database query', async () => {
    const rows = [
      { canonical_domain: 'example.mx', id: 12, name: 'Example Juegos', website_url: 'https://example.mx/' }
    ];
    const queries: string[] = [];
    const database: Database = {
      query: async (sql) => {
        queries.push(sql);
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get('/stores');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows });
    const sql = normalizeSql(queries[0] ?? '');
    expect(sql).toContain(
      'select id, name, canonical_domain, website_url, instagram_url, facebook_url, city, state, country, logo_url, status, created_at, updated_at'
    );
    expect(sql).toContain('from stores');
    expect(sql).toContain('order by canonical_domain asc');
    expect(sql).toContain('limit 200');
    expect(sql).not.toContain('discovery_store_candidates');
  });

  it('filters and paginates clean stores in the database query', async () => {
    const rows = [{ canonical_domain: 'caravanagameshop.com', id: 12, name: 'Caravana Game Shop' }];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).includes('count(*)')) {
          return { rows: [{ total: 1 }] };
        }
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get(
      '/stores?page=0&page_size=25&sort=canonical_domain&sort_direction=asc&filter_canonical_domain=caravana'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: rows,
      meta: {
        page: 0,
        page_size: 25,
        total: 1
      }
    });
    const rowQuery = queries.find((query) => normalizeSql(query.sql).startsWith('select id, name'));
    const countQuery = queries.find((query) => normalizeSql(query.sql).includes('count(*)'));
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain("where coalesce((canonical_domain)::text, '') ilike $1 escape '\\'");
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('order by canonical_domain asc');
    expect(rowQuery?.params).toEqual(['%caravana%', 25, 0]);
    expect(countQuery?.params).toEqual(['%caravana%']);
  });

  it('updates clean stores', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const row = {
      canonical_domain: 'example.mx',
      id: 12,
      name: 'Example Updated',
      website_url: 'https://example.mx/'
    };
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database })).patch('/stores/12').send({
      canonical_domain: 'example.mx',
      city: 'Ciudad de Mexico',
      country: 'Mexico',
      facebook_url: 'https://facebook.com/example',
      instagram_url: 'https://instagram.com/example',
      logo_url: 'https://example.mx/logo.png',
      name: 'Example Updated',
      state: 'CDMX',
      status: 'active',
      website_url: 'https://example.mx/'
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    const query = queries[0];
    const sql = normalizeSql(query.sql);
    expect(sql).toContain('update stores');
    expect(sql).toContain('where id = $11');
    expect(query.params).toEqual([
      'Example Updated',
      'example.mx',
      'https://example.mx/',
      'https://instagram.com/example',
      'https://facebook.com/example',
      'Ciudad de Mexico',
      'CDMX',
      'Mexico',
      'https://example.mx/logo.png',
      'active',
      '12'
    ]);
  });

  it('filters and paginates catalog items in the database query', async () => {
    const rows = [{ canonical_name: 'Coffee Rush', id: 377061, item_type: 'base_game' }];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).includes('count(*)')) {
          return { rows: [{ total: 1 }] };
        }
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get(
      '/items?page=0&page_size=25&sort=canonical_name&sort_direction=asc&filter_canonical_name=coffee'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: rows,
      meta: {
        page: 0,
        page_size: 25,
        total: 1
      }
    });
    const rowQuery = queries.find((query) => normalizeSql(query.sql).startsWith('select id, canonical_name'));
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('from items');
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain("where coalesce((canonical_name)::text, '') ilike $1 escape '\\'");
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('order by canonical_name asc');
    expect(rowQuery?.params).toEqual(['%coffee%', 25, 0]);
  });

  it('returns a catalog item by id', async () => {
    const row = { canonical_name: 'Coffee Rush', id: 77, item_type: 'base_game' };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database })).get('/items/77');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    const query = queries[0];
    expect(normalizeSql(query.sql)).toContain('from items');
    expect(normalizeSql(query.sql)).toContain('canonical_name_es');
    expect(normalizeSql(query.sql)).toContain('normalized_name_es');
    expect(normalizeSql(query.sql)).toContain('description_es');
    expect(normalizeSql(query.sql)).toContain('image_url_es');
    expect(normalizeSql(query.sql)).toContain('where id = $1');
    expect(query.params).toEqual(['77']);
  });

  it('returns discovery item candidates linked to a catalog item', async () => {
    const rows = [
      {
        availability: 'in_stock',
        id: 3365,
        item_id: 77,
        store_domain: 'caravanagameshop.com',
        store_name: 'Caravana Game Shop',
        title: 'Coffee Rush'
      }
    ];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get('/items/77/candidates');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows });
    const query = queries[0];
    const sql = normalizeSql(query.sql);
    expect(sql).toContain('from store_items dic');
    expect(sql).toContain('left join stores s on s.id = dic.store_id');
    expect(sql).toContain('where dic.item_id = $1');
    expect(sql).toContain('order by dic.last_updated desc');
    expect(query.params).toEqual(['77']);
  });

  it('returns store items linked to a catalog item', async () => {
    const rows = [
      {
        availability: 'in_stock',
        id: 3365,
        item_id: 77,
        price: '799.00',
        title: 'Coffee Rush',
        store_domain: 'caravanagameshop.com',
        store_name: 'Caravana Game Shop'
      }
    ];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get('/items/77/store-items');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows });
    const query = queries[0];
    const sql = normalizeSql(query.sql);
    expect(sql).toContain('from store_items dic');
    expect(sql).toContain('left join stores s on s.id = dic.store_id');
    expect(sql).toContain('where dic.item_id = $1');
    expect(sql).toContain('order by dic.last_seen_at desc');
    expect(query.params).toEqual(['77']);
  });

  it('updates catalog items', async () => {
    const updatedRow = { canonical_name: 'Coffee Rush Updated', id: '377061', item_type: 'base_game' };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [updatedRow] };
      }
    };

    const response = await request(createApp({ database }))
      .patch('/items/377061')
      .send({
        bgg_id: '377061',
        bgg_url: 'https://boardgamegeek.com/boardgame/377061/coffee-rush',
        canonical_name: 'Coffee Rush Updated',
        canonical_name_es: 'Cafe Barista Actualizado',
        complexity: '1.75',
        description: 'Updated description',
        description_es: 'Descripcion actualizada',
        image_url: 'https://cf.geekdo-images.com/coffee.jpg',
        image_url_es: 'https://cf.geekdo-images.com/coffee-es.jpg',
        item_type: 'base_game',
        max_minutes: '45',
        max_players: '4',
        min_age: '8',
        min_minutes: '30',
        min_players: '2',
        normalized_name: '',
        normalized_name_es: '',
        parent_item_id: '',
        status: 'active',
        year_published: '2023'
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: updatedRow });
    const query = queries[0];
    const sql = normalizeSql(query.sql);
    expect(sql).toContain('update items');
    expect(sql).toContain('updated_at = now()');
    expect(sql).toContain('canonical_name_es = $3');
    expect(sql).toContain('normalized_name_es = $4');
    expect(sql).toContain('description_es = $11');
    expect(sql).toContain('image_url_es = $19');
    expect(sql).toContain('where id = $21');
    expect(sql).toContain('returning id, canonical_name, normalized_name, canonical_name_es, normalized_name_es');
    expect(query.params).toEqual([
      'Coffee Rush Updated',
      'coffee rush updated',
      'Cafe Barista Actualizado',
      'cafe barista actualizado',
      'base_game',
      null,
      377061,
      'https://boardgamegeek.com/boardgame/377061/coffee-rush',
      2023,
      'Updated description',
      'Descripcion actualizada',
      2,
      4,
      30,
      45,
      1.75,
      8,
      'https://cf.geekdo-images.com/coffee.jpg',
      'https://cf.geekdo-images.com/coffee-es.jpg',
      'active',
      '377061'
    ]);
  });

  it('creates discovery store candidates', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const row = {
      canonical_domain: 'newstore.mx',
      id: 42,
      store_name: 'New Store',
      website_url: 'https://newstore.mx/'
    };
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database }))
      .post('/discovery/stores')
      .send({
        canonical_domain: 'newstore.mx',
        city: 'Ciudad de Mexico',
        confidence: 0.75,
        country: 'Mexico',
        evidence: ['manual'],
        facebook_url: '',
        instagram_url: '',
        state: 'CDMX',
        store_logo: '',
        store_name: 'New Store',
        website_url: 'https://newstore.mx/'
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: row });
    const query = queries[0];
    expect(normalizeSql(query.sql)).toContain('insert into discovery_store_candidates');
    expect(normalizeSql(query.sql)).toContain('returning');
    expect(query.params).toEqual([
      'New Store',
      'newstore.mx',
      'https://newstore.mx/',
      '',
      '',
      'Ciudad de Mexico',
      'CDMX',
      'Mexico',
      '',
      0.75,
      JSON.stringify(['manual'])
    ]);
  });

  it('updates discovery store candidates', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const row = {
      canonical_domain: 'example.mx',
      id: 7,
      store_name: 'Updated Store',
      website_url: 'https://example.mx/'
    };
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database }))
      .patch('/discovery/stores/7')
      .send({
        canonical_domain: 'example.mx',
        city: 'Guadalajara',
        confidence: 0.8,
        country: 'Mexico',
        evidence: ['manual', 'verified'],
        facebook_url: 'https://facebook.com/example',
        instagram_url: 'https://instagram.com/example',
        state: 'Jalisco',
        store_logo: 'https://example.mx/logo.png',
        store_name: 'Updated Store',
        website_url: 'https://example.mx/'
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    const query = queries[0];
    expect(normalizeSql(query.sql)).toContain('update discovery_store_candidates');
    expect(normalizeSql(query.sql)).toContain('where id = $12');
    expect(query.params).toEqual([
      'Updated Store',
      'example.mx',
      'https://example.mx/',
      'https://instagram.com/example',
      'https://facebook.com/example',
      'Guadalajara',
      'Jalisco',
      'Mexico',
      'https://example.mx/logo.png',
      0.8,
      JSON.stringify(['manual', 'verified']),
      '7'
    ]);
  });

  it('rejects store candidate writes without required fields', async () => {
    const response = await request(createApp({ database: idleDatabase() })).post('/discovery/stores').send({
      store_name: 'Missing fields'
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        message: 'store_name, canonical_domain, and website_url are required'
      }
    });
  });

  it('defaults new store candidates to pending status', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [{ id: 9, status: 'PENDING' }] };
      }
    };

    const response = await request(createApp({ database })).post('/discovery/stores').send({
      canonical_domain: 'pending.mx',
      store_name: 'Pending Store',
      website_url: 'https://pending.mx/'
    });

    expect(response.status).toBe(201);
    expect(queries[0].params).toEqual([
      'Pending Store',
      'pending.mx',
      'https://pending.mx/',
      '',
      '',
      '',
      '',
      'Mexico',
      '',
      0,
      JSON.stringify([])
    ]);
  });

  it('filters and paginates discovery store candidates in the database query', async () => {
    const rows = [{ canonical_domain: 'caravanagameshop.com', id: 7, store_name: 'Caravana Game Shop' }];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).includes('count(*)')) {
          return { rows: [{ total: 1 }] };
        }
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get(
      '/discovery/stores?page=0&page_size=25&sort=canonical_domain&sort_direction=asc&filter_canonical_domain=caravana'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: rows,
      meta: {
        page: 0,
        page_size: 25,
        total: 1
      }
    });
    const rowQuery = queries.find((query) => normalizeSql(query.sql).startsWith('select id, store_name'));
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('from discovery_store_candidates');
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain("where coalesce((canonical_domain)::text, '') ilike $1 escape '\\'");
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('order by canonical_domain asc');
    expect(rowQuery?.params).toEqual(['%caravana%', 25, 0]);
  });

  it('approves pending store candidates into curated stores', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const row = {
      canonical_domain: 'example.mx',
      id: 7,
      status: 'ACCEPTED',
      store_name: 'Example Juegos',
      website_url: 'https://example.mx/'
    };
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database })).post('/discovery/stores/7/approve');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    const query = queries[0];
    const sql = normalizeSql(query.sql);
    expect(sql).toContain('insert into stores');
    expect(sql).toContain('on conflict (canonical_domain) do update');
    expect(sql).toContain("status = 'accepted'");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('update discovery_store_candidates');
    expect(query.params).toEqual(['7']);
  });

  it('rejects pending store candidates without creating curated stores', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const row = {
      canonical_domain: 'example.mx',
      id: 7,
      status: 'REJECTED',
      store_name: 'Example Juegos',
      website_url: 'https://example.mx/'
    };
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database })).post('/discovery/stores/7/reject');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    const query = queries[0];
    const sql = normalizeSql(query.sql);
    expect(sql).toContain("status = 'rejected'");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('update discovery_store_candidates');
    expect(sql).not.toContain('insert into stores');
    expect(query.params).toEqual(['7']);
  });

  it('returns 404 when approving a non-pending store candidate', async () => {
    const database: Database = {
      query: async () => ({ rows: [] })
    };

    const response = await request(createApp({ database })).post('/discovery/stores/7/approve');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        message: 'Pending store candidate not found'
      }
    });
  });

  it('queries discovery item candidates by latest update', async () => {
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
    expect(sql).toContain('from store_items');
    expect(sql).toContain('source_listing_url');
    expect(sql).toContain('image_url');
    expect(sql).toContain('item_type');
    expect(sql).toContain('min_minutes');
    expect(sql).toContain('max_minutes');
    expect(sql).toContain('min_age');
    expect(sql).not.toContain('candidate_category');
    expect(sql).toContain('is_boardgame');
    expect(sql).toContain('is_boardgame_confirmed');
    expect(sql).toContain('category_confidence');
    expect(sql).toContain('classification_reasons');
    expect(sql).toContain('language_source');
    expect(sql).toContain('language_evidence');
    expect(sql).toContain('price_source');
    expect(sql).toContain('currency');
    expect(sql).toContain('availability_source');
    expect(sql).toContain('store_sku');
    expect(sql).toContain('raw_payload');
    expect(sql).not.toContain('offer_id');
    expect(sql).toContain('match_source');
    expect(sql).not.toContain('match_item_id');
    expect(sql).toContain('matched_bgg_id');
    expect(sql).toContain('matched_name');
    expect(sql).toContain('match_score');
    expect(sql).toContain('match_reasons');
    expect(sql).toContain('match_payload');
    expect(sql).toContain('matched_at');
    expect(sql).toContain('processed_at');
    expect(sql).toContain('processing_error');
    expect(sql).toContain('last_seen_at');
    expect(sql).toContain('order by last_updated desc');
    expect(sql).toContain('limit 200');
  });

  it('paginates discovery item candidates', async () => {
    const rows = [{ id: 'item-candidate-51', title: 'Second page item' }];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).includes('count(*)')) {
          return { rows: [{ total: 73 }] };
        }
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get('/discovery/listings?page=2&page_size=25');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: rows,
      meta: {
        page: 2,
        page_size: 25,
        total: 73
      }
    });
    const rowQuery = queries.find((query) => normalizeSql(query.sql).includes('from store_items'));
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('limit $1 offset $2');
    expect(rowQuery?.params).toEqual([25, 50]);
  });

  it('filters and sorts discovery item candidates before pagination', async () => {
    const rows = [{ id: 'item-candidate-3365', title: 'Kitchen Rush' }];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).includes('count(*)')) {
          return { rows: [{ total: 1 }] };
        }
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get(
      '/discovery/listings?page=0&page_size=25&sort=title&sort_direction=asc&filter_title=kitchen'
    );

    expect(response.status).toBe(200);
    expect(response.body.meta).toEqual({
      page: 0,
      page_size: 25,
      total: 1
    });
    const rowQuery = queries.find((query) => normalizeSql(query.sql).startsWith('select id, store_id'));
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain("where coalesce((title)::text, '') ilike $1 escape '\\'");
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('order by title asc');
    expect(rowQuery?.params).toEqual(['%kitchen%', 25, 0]);
  });

  it('returns a discovery item candidate by id', async () => {
    const row = { id: '920', status: 'listed', title: 'Cafe Barista' };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database })).get('/discovery/listings/920');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    const query = queries[0];
    expect(normalizeSql(query.sql)).toContain('from store_items');
    expect(normalizeSql(query.sql)).toContain('where id = $1');
    expect(query.params).toEqual(['920']);
  });

  it('creates a curated item and lists the store item from a discovery item candidate', async () => {
    const candidate = {
      availability: 'available',
      description: 'A local game description.',
      id: '920',
      image_url: 'https://store.mx/cafe-barista.jpg',
      item_id: null,
      item_type: 'unknown',
      language: 'es',
      max_minutes: 45,
      max_players: 4,
      min_age: 8,
      min_minutes: 30,
      min_players: 2,
      price: '899.00',
      publisher: 'Local Publisher',
      source_url: 'https://store.mx/products/cafe-barista',
      status: 'MATCH_NOT_FOUND',
      store_id: 42,
      title: 'Café Barista'
    };
    const updatedCandidate = {
      ...candidate,
      item_id: 77,
      status: 'listed'
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).startsWith('select')) {
          return { rows: [candidate] };
        }
        return { rows: [updatedCandidate] };
      }
    };

    const response = await request(createApp({ database })).post('/discovery/listings/920/create-item');

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: updatedCandidate });
    expect(queries[0].params).toEqual(['920']);
    const mutation = queries[1];
    const sql = normalizeSql(mutation.sql);
    expect(sql).toContain('insert into items');
    expect(sql).toContain('insert into publishers');
    expect(sql).toContain('insert into item_publishers');
    expect(sql).not.toContain('insert into offers');
    expect(sql).toContain('update store_items');
    expect(sql).toContain('set item_id = created_item.id');
    expect(sql).toContain('is_boardgame = true');
    expect(sql).toContain('is_boardgame_confirmed = true');
    expect(sql).not.toContain('offer_id');
    expect(sql).not.toContain('match_item_id');
    expect(sql).toContain("status = 'listed'");
    expect(mutation.params).toEqual([
      '920',
      'cafe barista',
      'base_game',
      'local publisher',
      JSON.stringify(['Manual item creation from admin candidate form']),
      JSON.stringify({ source: 'admin_manual_create_item' }),
      null,
      null
    ]);
  });

  it('creates a curated item with an implementation relationship to a BGG item', async () => {
    const candidate = {
      description: 'A local edition that BGG tracks as an alternate name.',
      id: '920',
      image_url: 'https://store.mx/cafe-barista.jpg',
      item_id: null,
      item_type: 'base_game',
      publisher: 'Local Publisher',
      source_url: 'https://store.mx/products/cafe-barista',
      store_id: 42,
      title: 'Cafe Barista Mexico'
    };
    const updatedCandidate = {
      ...candidate,
      item_id: 77,
      match_source: 'MANUAL',
      status: 'LISTED'
    };
    const importedBggIds: number[] = [];
    const bggItemImporter = {
      importBggId: async (bggId: number) => {
        importedBggIds.push(bggId);
        return 44;
      }
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).startsWith('select')) {
          return { rows: [candidate] };
        }
        return { rows: [updatedCandidate] };
      }
    };

    const response = await request(createApp({ bggItemImporter, database }))
      .post('/discovery/listings/920/create-item')
      .send({ bgg_id: '377061', implements: true });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: updatedCandidate });
    expect(importedBggIds).toEqual([377061]);
    const mutation = queries[1];
    const sql = normalizeSql(mutation.sql);
    expect(sql).toContain('insert into item_relationships');
    expect(sql).toContain("'implementation'");
    expect(sql).toContain("'admin'");
    expect(mutation.params).toEqual([
      '920',
      'cafe barista mexico',
      'base_game',
      'local publisher',
      JSON.stringify(['Manual item creation from admin candidate form']),
      JSON.stringify({ bgg_id: 377061, implements: true, source: 'admin_manual_create_item' }),
      44,
      '377061'
    ]);
  });

  it('imports a BGG item and links it to a discovery item candidate', async () => {
    const candidate = {
      availability: 'available',
      description: 'A local game description.',
      id: '920',
      image_url: 'https://store.mx/cafe-barista.jpg',
      item_id: 12,
      item_type: 'unknown',
      language: 'es',
      price: '899.00',
      publisher: 'Local Publisher',
      source_url: 'https://store.mx/products/cafe-barista',
      status: 'MATCH_NOT_FOUND',
      store_id: 42,
      title: 'CafÃ© Barista'
    };
    const updatedCandidate = {
      ...candidate,
      item_id: 77,
      matched_bgg_id: 377061,
      status: 'listed'
    };
    const importedBggIds: number[] = [];
    const bggItemImporter = {
      importBggId: async (bggId: number) => {
        importedBggIds.push(bggId);
        return 77;
      }
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).startsWith('select')) {
          return { rows: [candidate] };
        }
        return { rows: [updatedCandidate] };
      }
    };

    const response = await request(createApp({ bggItemImporter, database }))
      .post('/discovery/listings/920/create-item-from-bgg')
      .send({ bgg_id: '377061' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: updatedCandidate });
    expect(importedBggIds).toEqual([377061]);
    const mutation = queries[1];
    const sql = normalizeSql(mutation.sql);
    expect(sql).not.toContain('insert into offers');
    expect(sql).toContain('update store_items');
    expect(sql).toContain('set item_id = linked_item.id');
    expect(sql).toContain('is_boardgame = true');
    expect(sql).toContain('is_boardgame_confirmed = true');
    expect(sql).not.toContain('offer_id');
    expect(sql).toContain("status = 'listed'");
    expect(sql).toContain("match_source = 'bgg_manual'");
    expect(mutation.params).toEqual([
      '920',
      77,
      377061,
      JSON.stringify(['Manual BGG ID import from admin candidate form']),
      JSON.stringify({ bgg_id: 377061, source: 'admin_bgg_id_import' })
    ]);
  });

  it('rejects importing a BGG item when the importer is not configured', async () => {
    const database: Database = {
      query: async () => ({ rows: [{ id: '920', item_id: null, store_id: 42, title: 'Cafe Barista' }] })
    };

    const response = await request(createApp({ database }))
      .post('/discovery/listings/920/create-item-from-bgg')
      .send({ bgg_id: '377061' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        message: 'BGG item importer is not configured'
      }
    });
  });

  it('creates a replacement curated item when the candidate already has an item', async () => {
    const candidate = {
      id: '920',
      item_id: 77,
      source_url: 'https://store.mx/products/cafe-barista',
      store_id: 42,
      title: 'Cafe Barista'
    };
    const updatedCandidate = {
      ...candidate,
      item_id: 88,
      match_source: 'MANUAL',
      status: 'LISTED'
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).startsWith('select')) {
          return { rows: [candidate] };
        }
        return { rows: [updatedCandidate] };
      }
    };

    const response = await request(createApp({ database })).post('/discovery/listings/920/create-item');

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: updatedCandidate });
    const mutation = queries[1];
    expect(normalizeSql(mutation.sql)).toContain('set item_id = created_item.id');
  });

  it('updates discovery item candidates', async () => {
    const updatedRow = { id: '3365', status: 'MATCH_NOT_FOUND', title: 'Kitchen Rush Updated' };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [updatedRow] };
      }
    };

    const response = await request(createApp({ database }))
      .patch('/discovery/listings/3365')
      .send({
        availability: 'available',
        availability_source: 'manual',
        category_confidence: '0.92',
        classification_reasons: '["manual review"]',
        currency: 'MXN',
        description: 'Updated description',
        image_url: 'https://store.mx/kitchen-rush.jpg',
        is_boardgame: true,
        is_boardgame_confirmed: false,
        item_id: '',
        item_type: 'base_game',
        language: 'es',
        language_evidence: 'Manual review',
        language_source: 'manual',
        match_payload: '{"reviewed":true}',
        match_reasons: '["admin checked"]',
        match_score: '',
        match_source: 'MANUAL',
        matched_bgg_id: '223953',
        matched_name: 'Kitchen Rush',
        max_minutes: '45',
        max_players: '4',
        min_age: '8',
        min_minutes: '30',
        min_players: '2',
        price: '899.00',
        price_source: 'manual',
        processing_error: '',
        publisher: 'Artipia Games',
        raw_payload: '{"sku":"KR-EN"}',
        raw_price: '$899.00',
        source_listing_url: 'https://store.mx/collections/boardgames',
        source_url: 'https://store.mx/products/kitchen-rush',
        status: 'MATCH_NOT_FOUND',
        store_id: '42',
        store_sku: 'KR-EN',
        title: 'Kitchen Rush Updated'
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: updatedRow });
    const query = queries[0];
    const sql = normalizeSql(query.sql);
    expect(sql).toContain('update store_items');
    expect(sql).toContain('last_updated = now()');
    expect(sql).toContain('where id = $38');
    expect(sql).toContain('returning id, store_id, source_url, source_listing_url');
    expect(query.params).toEqual([
      42,
      'https://store.mx/products/kitchen-rush',
      'https://store.mx/collections/boardgames',
      'Kitchen Rush Updated',
      'Artipia Games',
      'Updated description',
      null,
      'base_game',
      2,
      4,
      30,
      45,
      8,
      'es',
      'manual',
      'Manual review',
      'https://store.mx/kitchen-rush.jpg',
      'MATCH_NOT_FOUND',
      '$899.00',
      899,
      'manual',
      'MXN',
      'available',
      'manual',
      'KR-EN',
      JSON.stringify({ sku: 'KR-EN' }),
      true,
      false,
      0.92,
      JSON.stringify(['manual review']),
      'MANUAL',
      223953,
      'Kitchen Rush',
      null,
      JSON.stringify(['admin checked']),
      JSON.stringify({ reviewed: true }),
      '',
      '3365'
    ]);
  });

  it('queries listed store items with linked item comparison data', async () => {
    const rows = [
      {
        candidate_id: 920,
        candidate_description: 'Serve orders in a busy cafe.',
        candidate_image_url: 'https://store.mx/candidate.jpg',
        candidate_name: 'Cafe Barista',
        item_description: 'Complete customer orders to increase your ratings.',
        item_description_es: '',
        item_id: 377061,
        item_image_url: 'https://bgg.example/coffee.jpg',
        item_image_url_es: 'https://bgg.example/cafe-barista.jpg',
        item_name: 'Coffee Rush',
        item_name_es: 'Cafe Barista',
        store_item_id: 920
      }
    ];
    const queries: string[] = [];
    const database: Database = {
      query: async (sql) => {
        queries.push(sql);
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get('/admin/discovery/offer-reviews');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows });
    const sql = normalizeSql(queries[0] ?? '');
    expect(sql).toContain('from store_items dic');
    expect(sql).toContain('join items i on i.id = dic.item_id');
    expect(sql).toContain('left join stores s on s.id = dic.store_id');
    expect(sql).toContain("dic.status = 'listed'");
    expect(sql).toContain('candidate_image_url');
    expect(sql).toContain('candidate_description');
    expect(sql).toContain('item_image_url');
    expect(sql).toContain('i.description as item_description');
    expect(sql).toContain('i.description_es as item_description_es');
    expect(sql).toContain('i.canonical_name_es as item_name_es');
    expect(sql).toContain('i.image_url_es as item_image_url_es');
    expect(sql).toContain('order by dic.last_updated desc');
  });

  it('filters and paginates store item reviews before returning comparison rows', async () => {
    const rows = [{ candidate_id: 3365, candidate_name: 'Kitchen Rush', item_name: 'Kitchen Rush' }];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).includes('count(*)')) {
          return { rows: [{ total: 1 }] };
        }
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get(
      '/admin/discovery/offer-reviews?page=0&page_size=25&sort=item_name&sort_direction=asc&filter_item_name=kitchen'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: rows,
      meta: {
        page: 0,
        page_size: 25,
        total: 1
      }
    });
    const rowQuery = queries.find((query) => normalizeSql(query.sql).startsWith('select dic.id as candidate_id'));
    const sql = normalizeSql(rowQuery?.sql ?? '');
    expect(sql).toContain('join items i on i.id = dic.item_id');
    expect(sql).toContain("dic.status = 'listed'");
    expect(sql).toContain("coalesce((concat_ws(' ', i.canonical_name, i.canonical_name_es))::text, '') ilike $1 escape '\\'");
    expect(sql).toContain('order by i.canonical_name asc');
    expect(rowQuery?.params).toEqual(['%kitchen%', 25, 0]);
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

  it('filters and paginates admin review tasks in the database query', async () => {
    const rows = [{ id: 'task-1', status: 'OPEN', task_type: 'ITEM_MATCH' }];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).includes('count(*)')) {
          return { rows: [{ total: 1 }] };
        }
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get(
      '/admin/review-tasks?page=0&page_size=25&sort=updated&sort_direction=desc&filter_status=open'
    );

    expect(response.status).toBe(200);
    expect(response.body.meta).toEqual({
      page: 0,
      page_size: 25,
      total: 1
    });
    const rowQuery = queries.find((query) => normalizeSql(query.sql).startsWith('select * from admin_review_tasks'));
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain("where coalesce((status)::text, '') ilike $1 escape '\\'");
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('order by updated_at desc');
    expect(rowQuery?.params).toEqual(['%open%', 25, 0]);
  });

  it('generates item match candidates through the item matching service', async () => {
    const rows = [
      {
        bgg_id: 377061,
        discovery_item_candidate_id: 42,
        id: 1,
        matched_name: 'Coffee Rush',
        source: 'BGG',
        status: 'PENDING'
      }
    ];
    const calls: number[] = [];
    const itemMatchingService: ItemMatchingService = {
      generateMatchCandidates: async (id) => {
        calls.push(id);
        return rows;
      },
      listMatchCandidates: async () => []
    };

    const response = await request(createApp({ database: idleDatabase(), itemMatchingService })).post(
      '/admin/discovery/item-candidates/42/match-candidates'
    );

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: rows });
    expect(calls).toEqual([42]);
  });

  it('lists item match candidates through the item matching service', async () => {
    const rows = [
      {
        discovery_item_candidate_id: 42,
        id: 1,
        item_id: 7,
        matched_name: 'Catan',
        source: 'LOCAL',
        status: 'PENDING'
      }
    ];
    const calls: number[] = [];
    const itemMatchingService: ItemMatchingService = {
      generateMatchCandidates: async () => [],
      listMatchCandidates: async (id) => {
        calls.push(id);
        return rows;
      }
    };

    const response = await request(createApp({ database: idleDatabase(), itemMatchingService })).get(
      '/admin/discovery/item-candidates/42/match-candidates'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows });
    expect(calls).toEqual([42]);
  });

  it('creates admin translations through the translation service', async () => {
    const calls: TranslationRequest[] = [];
    const translationService: TranslationService = {
      translate: async (request) => {
        calls.push(request);
        return {
          alternates: ['Economic'],
          fromCache: false,
          metadata: { confidence: 0.95 },
          model: 'gpt-5.4-nano',
          promptVersion: 'translation-v1',
          translatedText: 'Economico'
        };
      }
    };

    const response = await request(createApp({ database: idleDatabase(), translationService })).post('/admin/translations').send({
      purpose: 'CATEGORY_NAME',
      source_field: 'name',
      source_id: 1021,
      source_language: 'en',
      source_type: 'boardgame_category',
      target_language: 'es',
      text: 'Economic'
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      data: {
        alternates: ['Economic'],
        from_cache: false,
        metadata: { confidence: 0.95 },
        model: 'gpt-5.4-nano',
        prompt_version: 'translation-v1',
        translated_text: 'Economico'
      }
    });
    expect(calls[0]).toEqual({
      purpose: 'CATEGORY_NAME',
      sourceField: 'name',
      sourceId: 1021,
      sourceLanguage: 'en',
      sourceType: 'boardgame_category',
      targetLanguage: 'es',
      text: 'Economic'
    });
  });

  it('returns 503 for admin translations when the translation service is not configured', async () => {
    const response = await request(createApp({ database: idleDatabase() })).post('/admin/translations').send({
      purpose: 'ITEM_DESCRIPTION',
      target_language: 'es',
      text: 'A game about trading.'
    });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        message: 'Translation service is not configured'
      }
    });
  });

  it('rejects unsupported admin translation purposes', async () => {
    const translationService: TranslationService = {
      translate: async () => {
        throw new Error('should not call translation service');
      }
    };

    const response = await request(createApp({ database: idleDatabase(), translationService })).post('/admin/translations').send({
      purpose: 'UNKNOWN_PURPOSE',
      target_language: 'es',
      text: 'Economic'
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        message: 'purpose must be a supported translation purpose'
      }
    });
  });

  it('creates admin description generations through the description generation service', async () => {
    const calls: DescriptionGenerationRequest[] = [];
    const descriptionGenerationService: DescriptionGenerationService = {
      generate: async (request) => {
        calls.push(request);
        return {
          descriptionEs:
            'En Coffee Rush, cada pedido transforma la cafeteria en una carrera por ingredientes, reputacion y la satisfaccion de servir la bebida perfecta.',
          metadata: {
            sourceBalance: 'mixed',
            warnings: []
          },
          model: 'gpt-5.4-nano',
          promptVersion: 'description-generator-v1'
        };
      }
    };

    const response = await request(createApp({ database: idleDatabase(), descriptionGenerationService }))
      .post('/admin/description-generations')
      .send({
        boardgame_name: 'Coffee Rush',
        description_1: 'Complete customer orders to increase your ratings.',
        description_2: 'Vive la emocion de una cafeteria llena de pedidos y aromas.'
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      data: {
        description_es:
          'En Coffee Rush, cada pedido transforma la cafeteria en una carrera por ingredientes, reputacion y la satisfaccion de servir la bebida perfecta.',
        metadata: {
          sourceBalance: 'mixed',
          warnings: []
        },
        model: 'gpt-5.4-nano',
        prompt_version: 'description-generator-v1'
      }
    });
    expect(calls).toEqual([
      {
        boardgameName: 'Coffee Rush',
        description1: 'Complete customer orders to increase your ratings.',
        description2: 'Vive la emocion de una cafeteria llena de pedidos y aromas.'
      }
    ]);
  });

  it('returns 503 for admin description generations when the service is not configured', async () => {
    const response = await request(createApp({ database: idleDatabase() })).post('/admin/description-generations').send({
      boardgame_name: 'Coffee Rush',
      description_1: 'Complete customer orders to increase your ratings.',
      description_2: 'Vive la emocion de una cafeteria llena de pedidos y aromas.'
    });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        message: 'Description generation service is not configured'
      }
    });
  });

  it('rejects admin description generations without required source text', async () => {
    const descriptionGenerationService: DescriptionGenerationService = {
      generate: async () => {
        throw new Error('should not call description generation service');
      }
    };

    const response = await request(createApp({ database: idleDatabase(), descriptionGenerationService }))
      .post('/admin/description-generations')
      .send({
        boardgame_name: 'Coffee Rush',
        description_1: 'Complete customer orders to increase your ratings.'
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        message: 'boardgame_name, description_1, and description_2 are required'
      }
    });
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

  it('starts store discovery runs through the discovery operations client', async () => {
    const run: StoreDiscoveryRun = {
      completed_at: null,
      error: null,
      id: 'run-1',
      result: null,
      started_at: '2026-05-25T20:00:00Z',
      status: 'running',
      type: 'store_discovery'
    };
    const operationsClient: DiscoveryOperationsClient = {
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => run,
      startItemDiscoveryRun: async () => run,
      startStoreDiscoveryRun: async () => run
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient })).post(
      '/admin/operations/store-discovery-runs'
    );

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: run });
  });

  it('returns the latest store discovery run through the discovery operations client', async () => {
    const run: StoreDiscoveryRun = {
      completed_at: '2026-05-25T20:01:00Z',
      error: null,
      id: 'run-1',
      result: {
        accepted_stores: 3,
        candidate_domains: 5,
        searched_queries: 2
      },
      started_at: '2026-05-25T20:00:00Z',
      status: 'completed',
      type: 'store_discovery'
    };
    const operationsClient: DiscoveryOperationsClient = {
      getLatestStoreDiscoveryRun: async () => run,
      getStoreDiscoveryRun: async () => run,
      startItemDiscoveryRun: async () => run,
      startStoreDiscoveryRun: async () => run
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient })).get(
      '/admin/operations/store-discovery-runs/latest'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: run });
  });

  it('preserves discovery API conflicts when store discovery is already running', async () => {
    const operationsClient: DiscoveryOperationsClient = {
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => null,
      startItemDiscoveryRun: async () => {
        throw new DiscoveryApiError('Store discovery is already running', 409);
      },
      startStoreDiscoveryRun: async () => {
        throw new DiscoveryApiError('Store discovery is already running', 409);
      }
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient })).post(
      '/admin/operations/store-discovery-runs'
    );

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: {
        message: 'Store discovery is already running'
      }
    });
  });

  it('starts item discovery for a clean store through the discovery operations client', async () => {
    const run: StoreDiscoveryRun = {
      completed_at: null,
      error: null,
      id: 'run-2',
      result: null,
      started_at: '2026-05-25T20:00:00Z',
      status: 'running',
      type: 'item_discovery'
    };
    const calls: Array<{ storeId: number; websiteUrl: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        expect(normalizeSql(sql)).toContain('from stores');
        expect(params).toEqual(['12']);
        return { rows: [{ id: 12, website_url: 'https://example.mx/' }] };
      }
    };
    const operationsClient: DiscoveryOperationsClient = {
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => run,
      startItemDiscoveryRun: async (storeId, websiteUrl) => {
        calls.push({ storeId, websiteUrl });
        return run;
      },
      startStoreDiscoveryRun: async () => run
    };

    const response = await request(createApp({ database, operationsClient })).post(
      '/admin/operations/stores/12/item-discovery-runs'
    );

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: run });
    expect(calls).toEqual([{ storeId: 12, websiteUrl: 'https://example.mx/' }]);
  });

  it('returns 404 when starting item discovery for a missing clean store', async () => {
    const operationsClient: DiscoveryOperationsClient = {
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => null,
      startItemDiscoveryRun: async () => {
        throw new Error('should not call discovery API');
      },
      startStoreDiscoveryRun: async () => {
        throw new Error('should not call discovery API');
      }
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient })).post(
      '/admin/operations/stores/12/item-discovery-runs'
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { message: 'Store not found' } });
  });
});

function idleDatabase(): Database {
  return {
    query: async () => ({ rows: [] })
  };
}
