import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { CoverFlatteningWorkflow, CoverFlatteningWorkflowManager } from './coverFlatteningWorkflow.js';
import type { AmazonTitleExtractionRequest, AmazonTitleExtractionService } from './amazonTitleExtraction/amazonTitleExtractionService.js';
import type { DescriptionGenerationRequest, DescriptionGenerationService } from './descriptionGeneration/descriptionGenerationService.js';
import type { Database } from './db.js';
import { DiscoveryOperationError, type DiscoveryOperationsClient, type StoreDiscoveryRun } from './discoveryOperations.js';
import type { ItemMatchingService } from './itemMatching/itemMatchingService.js';
import { LocalCoverWorkflowError, type LocalCoverWorkflowManager, type LocalCoverWorkflowState } from './localCoverWorkflow.js';
import type { ProductDetailsEnrichmentService } from './productDetailsExtraction/productDetailsExtractionService.js';
import type { TranslationRequest, TranslationService } from './translation/translationService.js';

describe('ludora admin service', () => {
  const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase();
  const authOptions = {
    cookieName: 'ludora_admin_session',
    cookieSameSite: 'lax' as const,
    cookieSecure: false,
    password: 'secret-password',
    sessionSecret: 'test-session-secret-with-enough-length',
    sessionTtlHours: 12,
    username: 'admin'
  };

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

  it('requires authentication for admin data routes', async () => {
    const response = await request(createApp({ database: idleDatabase(), adminAuth: authOptions })).get('/stores');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { message: 'Authentication required' } });
  });

  it('accepts the configured internal token for protected admin routes', async () => {
    const app = createApp({
      database: idleDatabase(),
      adminAuth: { ...authOptions, internalApiToken: 'internal-test-token' }
    });

    const response = await request(app).get('/stores').set('X-Ludora-Internal-Token', 'internal-test-token');

    expect(response.status).toBe(200);
  });

  it('sets an HttpOnly session cookie after a successful login', async () => {
    const app = createApp({ database: idleDatabase(), adminAuth: authOptions });

    const loginResponse = await request(app).post('/admin/auth/login').send({
      password: 'secret-password',
      username: 'admin'
    });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body).toEqual({ data: { username: 'admin' } });
    expect(loginResponse.headers['set-cookie']?.[0]).toContain('ludora_admin_session=');
    expect(loginResponse.headers['set-cookie']?.[0]).toContain('HttpOnly');

    const protectedResponse = await request(app).get('/stores').set('Cookie', loginResponse.headers['set-cookie']);

    expect(protectedResponse.status).toBe(200);
  });

  it('rejects missing and wrong login credentials', async () => {
    const app = createApp({ database: idleDatabase(), adminAuth: authOptions });

    const missingResponse = await request(app).post('/admin/auth/login').send({ username: 'admin' });
    const wrongResponse = await request(app).post('/admin/auth/login').send({
      password: 'wrong-password',
      username: 'admin'
    });

    expect(missingResponse.status).toBe(400);
    expect(missingResponse.body).toEqual({ error: { message: 'username and password are required' } });
    expect(wrongResponse.status).toBe(401);
    expect(wrongResponse.body).toEqual({ error: { message: 'Invalid username or password' } });
  });

  it('rejects tampered admin session cookies', async () => {
    const app = createApp({ database: idleDatabase(), adminAuth: authOptions });
    const loginResponse = await request(app).post('/admin/auth/login').send({
      password: 'secret-password',
      username: 'admin'
    });
    const originalCookie = loginResponse.headers['set-cookie'][0] as string;
    const tamperedCookie = originalCookie.replace('ludora_admin_session=', 'ludora_admin_session=x');

    const response = await request(app).get('/stores').set('Cookie', tamperedCookie);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { message: 'Authentication required' } });
  });

  it('clears admin session cookies on logout', async () => {
    const app = createApp({ database: idleDatabase(), adminAuth: authOptions });
    const loginResponse = await request(app).post('/admin/auth/login').send({
      password: 'secret-password',
      username: 'admin'
    });

    const logoutResponse = await request(app).post('/admin/auth/logout').set('Cookie', loginResponse.headers['set-cookie']);

    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.body).toEqual({ data: { ok: true } });
    expect(logoutResponse.headers['set-cookie'][0]).toContain('Max-Age=0');
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
      'select id, name, canonical_domain, website_url, platform, instagram_url, facebook_url, city, state, country, logo_url, status, created_at, updated_at'
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
      platform: 'shopify',
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
      platform: 'shopify',
      state: 'CDMX',
      status: 'active',
      website_url: 'https://example.mx/'
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    const query = queries[0];
    const sql = normalizeSql(query.sql);
    expect(sql).toContain('update stores');
    expect(sql).toContain('where id = $12');
    expect(query.params).toEqual([
      'Example Updated',
      'example.mx',
      'https://example.mx/',
      'shopify',
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

  it('filters and paginates front page categories in the database query', async () => {
    const rows = [
      {
        category_id: 5,
        category_name: 'Party Game',
        category_name_es: 'Juego de fiesta',
        category_type: 'category',
        id: 1,
        order: 10,
        title: 'Need a laugh?'
      }
    ];
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
      '/front-page-categories?page=0&page_size=25&sort=category_name&sort_direction=asc&filter_title=laugh'
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
    const rowQuery = queries.find((query) => normalizeSql(query.sql).startsWith('select fpc.id'));
    const sql = normalizeSql(rowQuery?.sql ?? '');
    expect(sql).toContain('select fpc.id, fpc.category_type, fpc.category_id, fpc.title, fpc."order"');
    expect(sql).toContain('from front_page_categories fpc');
    expect(sql).toContain("left join boardgame_categories bc on fpc.category_type = 'category' and bc.id = fpc.category_id");
    expect(sql).toContain("left join boardgame_families bf on fpc.category_type = 'family' and bf.id = fpc.category_id");
    expect(sql).toContain("left join boardgame_mechanics bm on fpc.category_type = 'mechanic' and bm.id = fpc.category_id");
    expect(sql).toContain("where coalesce((fpc.title)::text, '') ilike $1 escape '\\'");
    expect(sql).toContain("order by coalesce(bc.name, bf.name, bm.name, '') asc");
    expect(rowQuery?.params).toEqual(['%laugh%', 25, 0]);
  });

  it('creates front page categories', async () => {
    const row = { category_id: 5, category_type: 'category', id: 1, order: 10, title: 'Need a laugh?' };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database })).post('/front-page-categories').send({
      category_id: '5',
      category_type: 'category',
      order: '10',
      title: 'Need a laugh?'
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: row });
    expect(normalizeSql(queries[0].sql)).toContain('insert into front_page_categories');
    expect(queries[0].params).toEqual(['category', 5, 'Need a laugh?', 10]);
  });

  it('updates front page categories', async () => {
    const row = { category_id: 8, category_type: 'mechanic', id: 1, order: 20, title: 'Big table energy' };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database })).patch('/front-page-categories/1').send({
      category_id: 8,
      category_type: 'mechanic',
      order: 20,
      title: 'Big table energy'
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    expect(normalizeSql(queries[0].sql)).toContain('update front_page_categories');
    expect(normalizeSql(queries[0].sql)).toContain('where id = $5');
    expect(queries[0].params).toEqual(['mechanic', 8, 'Big table energy', 20, '1']);
  });

  it('deletes front page categories', async () => {
    const row = { category_id: 5, category_type: 'category', id: 1, order: 10, title: 'Need a laugh?' };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database })).delete('/front-page-categories/1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    const sql = normalizeSql(queries[0].sql);
    expect(sql).toContain('delete from front_page_categories');
    expect(sql).toContain('where id = $1');
    expect(sql).toContain('returning');
    expect(queries[0].params).toEqual(['1']);
  });

  it('rejects invalid front page category types', async () => {
    const response = await request(createApp({ database: idleDatabase() })).post('/front-page-categories').send({
      category_id: '5',
      category_type: 'publisher',
      title: 'Need a laugh?'
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('category_type must be category, family, or mechanic');
  });

  it('lists taxonomy rows available for front page categories', async () => {
    const rows = [
      {
        bgg_id: 1021,
        category_id: 5,
        category_type: 'category',
        front_page_category_id: 12,
        game_count: 42,
        name: 'Party Game',
        name_es: 'Juego de fiesta'
      },
      {
        bgg_id: 2023,
        category_id: 8,
        category_type: 'mechanic',
        front_page_category_id: null,
        game_count: 17,
        name: 'Hand Management',
        name_es: 'Gestión de mano'
      },
      {
        bgg_id: 3001,
        category_id: 2,
        category_type: 'family',
        front_page_category_id: null,
        game_count: 9,
        name: 'Food & Drink',
        name_es: 'Comida y bebida'
      }
    ];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get('/front-page-category-options');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows });
    const sql = normalizeSql(queries[0].sql);
    expect(sql).toContain('from boardgame_categories');
    expect(sql).toContain('from boardgame_mechanics');
    expect(sql).toContain('from boardgame_families');
    expect(sql).toContain('from front_page_categories');
    expect(sql).toContain('from item_categories');
    expect(sql).toContain('from item_mechanics');
    expect(sql).toContain('from item_families');
    expect(sql).toContain('from active_item ai');
    expect(sql).toContain('select ai.id as item_id');
    expect(sql).toContain('ai.has_approved_listing = true');
    expect(sql).toContain('ai.is_expansion = false');
    expect(sql).toContain('game_count');
    expect(sql).toContain("where category_type = 'category'");
    expect(sql).toContain("where category_type = 'mechanic'");
    expect(sql).toContain("where category_type = 'family'");
    expect(sql).toContain('order by category_type asc, name asc');
  });

  it('can count only games not already covered by a front page category taxonomy', async () => {
    const rows = [
      {
        bgg_id: 1021,
        category_id: 5,
        category_type: 'category',
        front_page_category_id: null,
        game_count: 7,
        name: 'Party Game',
        name_es: 'Juego de fiesta'
      }
    ];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get('/front-page-category-options?only_unlinked_games=true');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows });
    const sql = normalizeSql(queries[0].sql);
    expect(sql).toContain('countable_items as');
    expect(sql).toContain('from active_item ai');
    expect(sql).toContain('ai.has_approved_listing = true');
    expect(sql).toContain('ai.is_expansion = false');
    expect(sql).toContain('from qualified_items qi');
    expect(sql).toContain('from item_categories existing_ic');
    expect(sql).toContain("existing_category_fpc.category_type = 'category'");
    expect(sql).toContain('existing_category_fpc.category_id = existing_ic.category_id');
    expect(sql).toContain('existing_ic.item_id = qi.item_id');
    expect(sql).toContain('from item_families existing_ifa');
    expect(sql).toContain("existing_family_fpc.category_type = 'family'");
    expect(sql).toContain('existing_family_fpc.category_id = existing_ifa.family_id');
    expect(sql).toContain('existing_ifa.item_id = qi.item_id');
    expect(sql).toContain('from item_mechanics existing_im');
    expect(sql).toContain("existing_mechanic_fpc.category_type = 'mechanic'");
    expect(sql).toContain('existing_mechanic_fpc.category_id = existing_im.mechanic_id');
    expect(sql).toContain('existing_im.item_id = qi.item_id');
    expect(sql).toContain('join countable_items ci on ci.item_id = ic.item_id');
    expect(sql).toContain('join countable_items ci on ci.item_id = ifa.item_id');
    expect(sql).toContain('join countable_items ci on ci.item_id = im.item_id');
  });

  it('lists products linked to a front page category option', async () => {
    const rows = [
      {
        canonical_name: 'Coffee Rush',
        canonical_name_es: 'Cafeteria',
        id: 77,
        image_url: 'https://cdn.example/coffee.jpg',
        image_url_es: 'https://cdn.example/cafe.jpg',
        item_type: 'base_game',
        year_published: 2023
      }
    ];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get('/front-page-category-options/category/5/products');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows });
    const sql = normalizeSql(queries[0].sql);
    expect(sql).toContain('with qualified_items as');
    expect(sql).toContain('from active_item ai');
    expect(sql).toContain('select ai.id as item_id');
    expect(sql).toContain('ai.has_approved_listing = true');
    expect(sql).toContain('ai.is_expansion = false');
    expect(sql).toContain('from item_categories ic');
    expect(sql).toContain('join qualified_items qi on qi.item_id = ic.item_id');
    expect(sql).toContain('join items i on i.id = ic.item_id');
    expect(sql).toContain('where ic.category_id = $1');
    expect(sql).toContain('order by i.canonical_name asc');
    expect(queries[0].params).toEqual([5]);
  });

  it('uses the matching taxonomy relation table for front page category option products', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [] };
      }
    };
    const app = createApp({ database });

    await request(app).get('/front-page-category-options/mechanic/8/products');
    await request(app).get('/front-page-category-options/family/2/products');

    expect(normalizeSql(queries[0].sql)).toContain('from item_mechanics im');
    expect(normalizeSql(queries[0].sql)).toContain('where im.mechanic_id = $1');
    expect(queries[0].params).toEqual([8]);
    expect(normalizeSql(queries[1].sql)).toContain('from item_families ifa');
    expect(normalizeSql(queries[1].sql)).toContain('where ifa.family_id = $1');
    expect(queries[1].params).toEqual([2]);
  });

  it('randomly assigns active items through thirty-two category cycles without reusing games', async () => {
    const rows = [{ assigned_count: 32, skipped_count: 10 }];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows };
      }
    };

    const response = await request(createApp({ database })).post('/front-page-categories/random-item-assignments');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows[0] });
    const sql = normalizeSql(queries[0].sql);
    expect(sql).toContain('from front_page_category_items');
    expect(sql).toContain('from front_page_categories fpc');
    expect(sql).toContain('generate_series(1, 32) as cycle_number');
    expect(sql).toContain('row_number() over (order by cycle_number asc, category_position asc)');
    expect(sql).toContain('from active_item ai');
    expect(sql).toContain('ai.has_approved_listing = true');
    expect(sql).toContain('ai.is_expansion = false');
    expect(sql).toContain('from item_categories ic');
    expect(sql).toContain('from item_families ifa');
    expect(sql).toContain('from item_mechanics im');
    expect(sql).toContain('order by random()');
    expect(sql).toContain('not (ai.id = any(previous.assigned_item_ids))');
    expect(sql).toContain('insert into front_page_category_items (front_page_category_id, item_id, item_order)');
    expect(sql).toContain('on conflict (item_id) do update');
    expect(sql).toContain('delete from front_page_category_items fpci');
    expect(sql).toContain('cycle_number as item_order');
    expect(sql).toContain('where item_id is not null');
    expect(queries[0].params).toBeUndefined();
  });

  it('assigns randomly ordered active items to the least-covered matching front page category', async () => {
    const rows = [{ assigned_count: 3, skipped_count: 1, replaced_count: 4, removed_count: 1 }];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows };
      }
    };

    const response = await request(createApp({ database })).post(
      '/front-page-categories/balanced-random-item-assignments'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows[0] });
    const sql = normalizeSql(queries[0].sql);
    expect(sql).toContain('from front_page_category_items');
    expect(sql).toContain('eligible_items as');
    expect(sql).toContain('row_number() over (order by random()) as position');
    expect(sql).toContain('from active_item ai');
    expect(sql).toContain('ai.has_approved_listing = true');
    expect(sql).toContain('ai.is_expansion = false');
    expect(sql).toContain('from front_page_categories fpc');
    expect(sql).toContain('from item_categories ic');
    expect(sql).toContain('from item_families ifa');
    expect(sql).toContain('from item_mechanics im');
    expect(sql).toContain('remaining.position >= mc.position');
    expect(sql).toContain('remaining_unassigned_count');
    expect(sql).toContain(
      'row_number() over (partition by mc.item_id order by count(remaining.item_id) asc, random()) as category_rank'
    );
    expect(sql).toContain('where category_rank = 1');
    expect(sql).toContain(
      'row_number() over (partition by front_page_category_id order by position asc)::int as item_order'
    );
    expect(sql).toContain('insert into front_page_category_items (front_page_category_id, item_id, item_order)');
    expect(sql).toContain('on conflict (item_id) do update');
    expect(sql).toContain('delete from front_page_category_items fpci');
    expect(sql).not.toContain('generate_series(1, 32) as cycle_number');
    expect(queries[0].params).toBeUndefined();
  });

  it('lists front page preview rows with assigned active products', async () => {
    const rows = [
      {
        category_id: 5,
        category_name: 'Party Game',
        category_type: 'category',
        id: 1,
        order: 10,
        products: [
          {
            canonical_name: 'Coffee Rush',
            canonical_name_es: 'Cafeteria',
            id: 77,
            image_url: 'https://cdn.example/coffee.jpg',
            image_url_es: 'https://cdn.example/cafe.jpg',
            item_type: 'base_game',
            year_published: 2023
          }
        ],
        title: 'Party Game',
        title_display: 'Para empezar la noche'
      }
    ];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get('/front-page-preview');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows });
    const sql = normalizeSql(queries[0].sql);
    expect(sql).toContain('from front_page_categories fpc');
    expect(sql).toContain('fpc.title_display');
    expect(sql).toContain('left join front_page_category_items fpci on fpci.front_page_category_id = fpc.id');
    expect(sql).toContain('left join active_item i on i.id = fpci.item_id');
    expect(sql).toContain('jsonb_agg');
    expect(sql).toContain('jsonb_build_object');
    expect(sql).toContain('filter (where i.id is not null)');
    expect(sql).toContain('group by fpc.id');
    expect(sql).toContain('order by i.rating desc nulls last, fpci.item_order asc, i.canonical_name asc, i.id asc');
    expect(sql).toContain('order by fpc."order" asc, fpc.id asc');
    expect(queries[0].params).toBeUndefined();
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
    expect(normalizeSql(rowQuery?.sql ?? '')).not.toContain('from active_item');
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain("where coalesce((canonical_name)::text, '') ilike $1 escape '\\'");
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('order by canonical_name asc');
    expect(rowQuery?.params).toEqual(['%coffee%', 25, 0]);
  });

  it('filters and sorts catalog items by id in the database query', async () => {
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
      '/items?page=0&page_size=25&sort=id&sort_direction=desc&filter_id=377061'
    );

    expect(response.status).toBe(200);
    const rowQuery = queries.find((query) => normalizeSql(query.sql).startsWith('select id, canonical_name'));
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain("where coalesce((id)::text, '') ilike $1 escape '\\'");
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('order by id desc');
    expect(rowQuery?.params).toEqual(['%377061%', 25, 0]);
  });

  it('lists catalog items from all items when no table query is provided', async () => {
    const rows = [{ canonical_name: 'Coffee Rush', id: 377061, item_type: 'base_game' }];
    const queries: string[] = [];
    const database: Database = {
      query: async (sql) => {
        queries.push(sql);
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get('/items');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows });
    const sql = normalizeSql(queries[0] ?? '');
    expect(sql).toContain('from items');
    expect(sql).not.toContain('from active_item');
    expect(sql).toContain('order by canonical_name asc');
    expect(sql).toContain('limit 200');
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

  it('returns the next item for TikTok tutorial curation', async () => {
    const row = {
      canonical_name: 'Coffee Rush',
      canonical_name_es: 'Coffee Rush',
      description: 'Serve customers and make coffee under pressure.',
      description_es: 'Atiende clientes y prepara cafe bajo presion.',
      id: 77,
      image_url: 'https://example.com/coffee-rush.jpg',
      image_url_es: 'https://example.com/coffee-rush-es.jpg',
      item_type: 'base_game'
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database })).get('/admin/tutorial-curation/next');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    const query = queries[0];
    const sql = normalizeSql(query.sql);
    expect(sql).toContain('from active_item i');
    expect(sql).toContain('i.is_expansion = false');
    expect(sql).toContain('i.description');
    expect(sql).toContain('i.description_es');
    expect(sql).toContain('i.image_url');
    expect(sql).toContain('i.image_url_es');
    expect(sql).toContain('not exists');
    expect(sql).toContain('from tutorial_links tl');
    expect(sql).toContain('tl.item_id = i.id');
    expect(sql).toContain('tl.source = $1');
    expect(sql).toContain('i.id <> all($2::bigint[])');
    expect(sql).toContain("tl.status in ('candidate', 'published')");
    expect(sql).toContain('limit 1');
    expect(query.params).toEqual(['tiktok', []]);
  });

  it('excludes locally skipped items from TikTok tutorial curation', async () => {
    const row = {
      canonical_name: 'Azul',
      canonical_name_es: 'Azul',
      id: 88,
      item_type: 'base_game'
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database })).get(
      '/admin/tutorial-curation/next?exclude_item_ids=77,99'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    const query = queries[0];
    expect(normalizeSql(query.sql)).toContain('from active_item i');
    expect(normalizeSql(query.sql)).toContain('i.is_expansion = false');
    expect(normalizeSql(query.sql)).toContain('i.id <> all($2::bigint[])');
    expect(query.params).toEqual(['tiktok', [77, 99]]);
  });

  it('returns null when no TikTok tutorial curation item is available', async () => {
    const database: Database = {
      query: async () => ({ rows: [] })
    };

    const response = await request(createApp({ database })).get('/admin/tutorial-curation/next');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: null });
  });

  it('creates a published TikTok tutorial link for an item', async () => {
    const savedRow = {
      id: 123,
      item_id: 77,
      language: 'es',
      source: 'tiktok',
      status: 'published',
      title: 'Como jugar Coffee Rush',
      url: 'https://www.tiktok.com/@creator/video/7552741217180716308'
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        const normalized = normalizeSql(sql);
        if (normalized.includes('from items')) {
          return { rows: [{ id: 77 }] };
        }
        if (normalized.includes('from tutorial_links') && normalized.includes('limit 1')) {
          return { rows: [] };
        }
        return { rows: [savedRow] };
      }
    };

    const response = await request(createApp({ database }))
      .post('/admin/tutorial-curation/items/77/tutorial-links')
      .send({
        title: 'Como jugar Coffee Rush',
        url: 'https://www.tiktok.com/@creator/video/7552741217180716308'
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: savedRow });
    expect(queries).toHaveLength(3);
    expect(normalizeSql(queries[0].sql)).toContain('from items');
    expect(queries[0].params).toEqual([77]);
    expect(normalizeSql(queries[1].sql)).toContain('from tutorial_links');
    expect(queries[1].params).toEqual([77, 'https://www.tiktok.com/@creator/video/7552741217180716308']);
    const insertQuery = queries[2];
    expect(normalizeSql(insertQuery.sql)).toContain('insert into tutorial_links');
    expect(normalizeSql(insertQuery.sql)).toContain('returning id, item_id, url, title, language, source, status, created_at');
    expect(insertQuery.params).toEqual([
      77,
      'https://www.tiktok.com/@creator/video/7552741217180716308',
      'Como jugar Coffee Rush',
      'es',
      'tiktok',
      'published'
    ]);
  });

  it('updates an existing TikTok tutorial link as published for an item url', async () => {
    const savedRow = {
      id: 123,
      item_id: 77,
      language: 'es',
      source: 'tiktok',
      status: 'published',
      title: 'Coffee Rush overview',
      url: 'https://www.tiktok.com/@creator/video/7552741217180716308'
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        const normalized = normalizeSql(sql);
        if (normalized.includes('from items')) {
          return { rows: [{ id: 77 }] };
        }
        if (normalized.includes('from tutorial_links') && normalized.includes('limit 1')) {
          return { rows: [{ id: 123 }] };
        }
        return { rows: [savedRow] };
      }
    };

    const response = await request(createApp({ database }))
      .post('/admin/tutorial-curation/items/77/tutorial-links')
      .send({
        title: 'Coffee Rush overview',
        url: 'https://www.tiktok.com/@creator/video/7552741217180716308'
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: savedRow });
    const updateQuery = queries[2];
    expect(normalizeSql(updateQuery.sql)).toContain('update tutorial_links');
    expect(normalizeSql(updateQuery.sql)).toContain('where id = $5');
    expect(updateQuery.params).toEqual(['Coffee Rush overview', 'es', 'tiktok', 'published', 123]);
  });

  it('rejects non-TikTok tutorial curation urls', async () => {
    const database: Database = {
      query: async () => {
        throw new Error('should not query database');
      }
    };

    const response = await request(createApp({ database }))
      .post('/admin/tutorial-curation/items/77/tutorial-links')
      .send({ url: 'https://example.com/not-tiktok' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { message: 'url must be a TikTok video URL' } });
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
        image_url: 'https://store.mx/coffee-rush-box.jpg',
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
    expect(sql).toContain('dic.image_url');
    expect(sql).toContain('from store_items dic');
    expect(sql).toContain('left join stores s on s.id = dic.store_id');
    expect(sql).toContain('where dic.item_id = $1');
    expect(sql).toContain('order by dic.last_seen_at desc');
    expect(query.params).toEqual(['77']);
  });

  it('returns taxonomy metadata linked to a catalog item', async () => {
    const categories = [{ bgg_id: 1021, id: 1, value: 'Economic', value_es: 'Economico' }];
    const mechanics = [{ bgg_id: 2912, id: 2, value: 'Contracts', value_es: 'Contratos' }];
    const families = [{ bgg_id: 46953, id: 3, value: 'Food & Drink: Coffee', value_es: 'Cafe' }];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        const normalized = normalizeSql(sql);
        if (normalized.includes('from item_categories')) {
          return { rows: categories };
        }
        if (normalized.includes('from item_mechanics')) {
          return { rows: mechanics };
        }
        if (normalized.includes('from item_families')) {
          return { rows: families };
        }
        return { rows: [] };
      }
    };

    const response = await request(createApp({ database })).get('/items/77/taxonomy');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        categories,
        families,
        mechanics
      }
    });
    expect(queries).toHaveLength(3);
    expect(queries.map((query) => query.params)).toEqual([['77'], ['77'], ['77']]);
    expect(normalizeSql(queries[0].sql)).toContain('join boardgame_categories bc on bc.id = ic.category_id');
    expect(normalizeSql(queries[1].sql)).toContain('join boardgame_mechanics bm on bm.id = im.mechanic_id');
    expect(normalizeSql(queries[2].sql)).toContain('join boardgame_families bf on bf.id = ifa.family_id');
  });

  it('returns relationships linked to a catalog item', async () => {
    const rows = [
      {
        direction: 'outgoing',
        id: 12,
        item_a_id: 77,
        item_b_id: 88,
        link_type: 'implementation',
        related_item_id: 88,
        related_item_name: 'Coffee Rush Original'
      }
    ];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows };
      }
    };

    const response = await request(createApp({ database })).get('/items/77/relationships');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: rows });
    const query = queries[0];
    const sql = normalizeSql(query.sql);
    expect(sql).toContain('from item_relationships ir');
    expect(sql).toContain('join items related_item');
    expect(sql).toContain('ir.item_a_id = $1::bigint or ir.item_b_id = $1::bigint');
    expect(sql).toContain("then 'outgoing'");
    expect(sql).toContain("else 'incoming'");
    expect(sql).toContain('order by ir.link_type asc, related_item.canonical_name asc, ir.id asc');
    expect(query.params).toEqual(['77']);
  });

  it('creates a relationship from a catalog item to another item', async () => {
    const row = {
      direction: 'outgoing',
      id: 12,
      item_a_id: 77,
      item_b_id: 88,
      link_type: 'implementation',
      related_item_id: 88,
      related_item_name: 'Coffee Rush Original',
      source: 'admin',
      source_ref: 'manual'
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database }))
      .post('/items/77/relationships')
      .send({
        direction: 'outgoing',
        link_type: 'implementation',
        related_item_id: '88',
        source: 'admin',
        source_ref: 'manual'
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: row });
    const query = queries[0];
    const sql = normalizeSql(query.sql);
    expect(sql).toContain('insert into item_relationships');
    expect(sql).toContain('on conflict (item_a_id, link_type, item_b_id) do update');
    expect(sql).toContain('returning *');
    expect(sql).toContain('join items current_item');
    expect(sql).toContain('join items target_item');
    expect(query.params).toEqual(['77', 88, 'implementation', 'admin', 'manual', 'outgoing']);
  });

  it('copies base taxonomy links when creating an implementation relationship from a catalog item', async () => {
    const row = {
      direction: 'outgoing',
      id: 12,
      item_a_id: 77,
      item_b_id: 88,
      link_type: 'implementation',
      related_item_id: 88,
      related_item_name: 'Coffee Rush Original',
      source: 'admin',
      source_ref: 'manual'
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database }))
      .post('/items/77/relationships')
      .send({
        direction: 'outgoing',
        link_type: 'implementation',
        related_item_id: '88',
        source: 'admin',
        source_ref: 'manual'
      });

    expect(response.status).toBe(201);
    const sql = normalizeSql(queries[0].sql);
    expect(sql).toContain('copied_base_categories as');
    expect(sql).toContain('insert into item_categories (item_id, category_id)');
    expect(sql).toContain('select saved.item_a_id, base_categories.category_id');
    expect(sql).toContain('join item_categories base_categories on base_categories.item_id = saved.item_b_id');
    expect(sql).toContain('copied_base_families as');
    expect(sql).toContain('insert into item_families (item_id, family_id)');
    expect(sql).toContain('select saved.item_a_id, base_families.family_id');
    expect(sql).toContain('join item_families base_families on base_families.item_id = saved.item_b_id');
    expect(sql).toContain('copied_base_mechanics as');
    expect(sql).toContain('insert into item_mechanics (item_id, mechanic_id)');
    expect(sql).toContain('select saved.item_a_id, base_mechanics.mechanic_id');
    expect(sql).toContain('join item_mechanics base_mechanics on base_mechanics.item_id = saved.item_b_id');
    expect(sql).toContain("where saved.link_type = 'implementation'");
    expect(sql).toContain('on conflict do nothing');
    expect(queries[0].params).toEqual(['77', 88, 'implementation', 'admin', 'manual', 'outgoing']);
  });

  it('removes reciprocal implementation relationships before saving a catalog item relationship', async () => {
    const row = {
      direction: 'outgoing',
      id: 12,
      item_a_id: 77,
      item_b_id: 88,
      link_type: 'implementation',
      related_item_id: 88,
      related_item_name: 'Coffee Rush Original',
      source: 'admin',
      source_ref: 'manual'
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database }))
      .post('/items/77/relationships')
      .send({
        direction: 'outgoing',
        link_type: 'implementation',
        related_item_id: '88',
        source: 'admin',
        source_ref: 'manual'
      });

    expect(response.status).toBe(201);
    const sql = normalizeSql(queries[0].sql);
    expect(sql).toContain('removed_inverse_relationship as');
    expect(sql).toContain('delete from item_relationships inverse_relationship');
    expect(sql).toContain('using resolved');
    expect(sql).toContain("resolved.link_type in ('extension', 'implementation')");
    expect(sql).toContain('inverse_relationship.link_type = resolved.link_type');
    expect(sql).toContain('inverse_relationship.item_a_id = resolved.item_b_id');
    expect(sql).toContain('inverse_relationship.item_b_id = resolved.item_a_id');
    expect(sql).toContain('cross join (select count(*) as deleted_count from removed_inverse_relationship) inverse_cleanup');
    expect(queries[0].params).toEqual(['77', 88, 'implementation', 'admin', 'manual', 'outgoing']);
  });

  it('removes reciprocal extension relationships before saving a catalog item relationship', async () => {
    const row = {
      direction: 'outgoing',
      id: 12,
      item_a_id: 77,
      item_b_id: 88,
      link_type: 'extension',
      related_item_id: 88,
      related_item_name: 'Coffee Rush',
      source: 'admin',
      source_ref: 'manual'
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database }))
      .post('/items/77/relationships')
      .send({
        direction: 'outgoing',
        link_type: 'extension',
        related_item_id: '88',
        source: 'admin',
        source_ref: 'manual'
      });

    expect(response.status).toBe(201);
    const sql = normalizeSql(queries[0].sql);
    expect(sql).toContain('removed_inverse_relationship as');
    expect(sql).toContain('delete from item_relationships inverse_relationship');
    expect(sql).toContain("resolved.link_type in ('extension', 'implementation')");
    expect(sql).toContain('inverse_relationship.link_type = resolved.link_type');
    expect(sql).toContain('inverse_relationship.item_a_id = resolved.item_b_id');
    expect(sql).toContain('inverse_relationship.item_b_id = resolved.item_a_id');
    expect(queries[0].params).toEqual(['77', 88, 'extension', 'admin', 'manual', 'outgoing']);
  });

  it('deletes a relationship linked to a catalog item', async () => {
    const row = {
      direction: 'outgoing',
      id: 12,
      item_a_id: 77,
      item_b_id: 88,
      link_type: 'extension',
      related_item_id: 88,
      related_item_name: 'Coffee Rush Expansion',
      source: 'admin',
      source_ref: 'manual'
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database })).delete('/items/77/relationships/12');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    const query = queries[0];
    const sql = normalizeSql(query.sql);
    expect(sql).toContain('delete from item_relationships');
    expect(sql).toContain('where ir.id = $2::bigint');
    expect(sql).toContain('and (ir.item_a_id = $1::bigint or ir.item_b_id = $1::bigint)');
    expect(sql).toContain('returning *');
    expect(query.params).toEqual(['77', '12']);
  });

  it('rejects self-referencing catalog item relationships', async () => {
    const database: Database = {
      query: async () => ({ rows: [] })
    };

    const response = await request(createApp({ database }))
      .post('/items/77/relationships')
      .send({
        link_type: 'implementation',
        related_item_id: '77'
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('related_item_id must be different from the current item id');
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
        rating: '7.48',
        status: 'active',
        weight: '1.92',
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
    expect(sql).toContain('rating = $17');
    expect(sql).toContain('weight = $18');
    expect(sql).toContain('image_url_es = $21');
    expect(sql).toContain('where id = $23');
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
      7.48,
      1.92,
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

  it('queries discovery item candidates by title', async () => {
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
    expect(sql).toContain('listing_status');
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
    expect(sql).toContain('refreshed_date');
    expect(sql).toContain('order by title asc');
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
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('order by title asc');
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
    const row = { id: '920', listing_status: 'PENDING', title: 'Cafe Barista' };
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

  it('updates a discovery item candidate listing status only', async () => {
    const row = { id: '920', listing_status: 'LISTED', title: 'Cafe Barista' };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };

    const response = await request(createApp({ database }))
      .patch('/discovery/listings/920/listing-status')
      .send({ listing_status: 'LISTED' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    const mutation = queries[0];
    const sql = normalizeSql(mutation.sql);
    expect(sql).toContain('update store_items');
    expect(sql).toContain('set listing_status = $1');
    expect(sql).toContain('last_updated = now()');
    expect(sql).toContain('where id = $2');
    expect(sql).toContain('returning');
    expect(sql).not.toContain('title =');
    expect(mutation.params).toEqual(['LISTED', '920']);
  });

  it('rejects unsupported discovery item candidate listing status updates', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [] };
      }
    };

    const response = await request(createApp({ database }))
      .patch('/discovery/listings/920/listing-status')
      .send({ listing_status: 'ARCHIVED' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('listing_status must be PENDING, LISTED, UNLISTED, or REJECTED');
    expect(queries).toEqual([]);
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
      listing_status: 'PENDING',
      store_id: 42,
      title: 'Café Barista'
    };
    const updatedCandidate = {
      ...candidate,
      item_id: 77,
      listing_status: 'PENDING'
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
    expect(sql).toContain('rating');
    expect(sql).toContain('select candidate.title, $2, $3, $9::bigint, null, \'\', null, null');
    expect(sql).toContain('insert into publishers');
    expect(sql).toContain('insert into item_publishers');
    expect(sql).not.toContain('insert into offers');
    expect(sql).toContain('update store_items');
    expect(sql).toContain('set item_id = created_item.id');
    expect(sql).toContain('is_boardgame = true');
    expect(sql).toContain('is_boardgame_confirmed = true');
    expect(sql).not.toContain('offer_id');
    expect(sql).not.toContain('match_item_id');
    expect(sql).not.toContain("status = 'listed'");
    expect(sql).not.toContain('listing_status =');
    expect(mutation.params).toEqual([
      '920',
      'cafe barista',
      'base_game',
      'local publisher',
      JSON.stringify(['Manual item creation from admin candidate form']),
      JSON.stringify({ source: 'admin_manual_create_item' }),
      null,
      null,
      null,
      null
    ]);
  });

  it('enriches missing product details when creating a curated item from a candidate', async () => {
    const candidate = {
      availability: 'available',
      description: 'Juego para 2-4 jugadores, 30-45 minutos, edad 8+.',
      id: '920',
      image_url: 'https://store.mx/cafe-barista.jpg',
      item_id: null,
      item_type: 'unknown',
      language: 'es',
      max_minutes: null,
      max_players: null,
      min_age: null,
      min_minutes: null,
      min_players: null,
      price: '899.00',
      publisher: 'Local Publisher',
      raw_payload: { specs: '2-4 jugadores | 30-45 min | 8+' },
      source_url: 'https://store.mx/products/cafe-barista',
      listing_status: 'PENDING',
      store_id: 42,
      title: 'Cafe Barista'
    };
    const enrichedCandidate = {
      ...candidate,
      max_minutes: 45,
      max_players: 4,
      min_age: 8,
      min_minutes: 30,
      min_players: 2
    };
    const updatedCandidate = {
      ...enrichedCandidate,
      item_id: 77,
      listing_status: 'PENDING'
    };
    const enrichmentCalls: Array<{ id: number; options?: { updateLinkedItem?: boolean } }> = [];
    const productDetailsEnrichmentService: ProductDetailsEnrichmentService = {
      enrichCandidate: async (id, options) => {
        enrichmentCalls.push({ id, options });
        return {
          candidate: enrichedCandidate,
          extraction: {
            details: {
              maxMinutes: 45,
              maxPlayers: 4,
              minAge: 8,
              minMinutes: 30,
              minPlayers: 2
            },
            extractedDetails: {
              maxMinutes: 45,
              maxPlayers: 4,
              minAge: 8,
              minMinutes: 30,
              minPlayers: 2
            },
            metadata: {
              confidence: 0.9,
              evidence: ['2-4 jugadores'],
              warnings: []
            },
            model: 'gpt-5.4-nano',
            promptVersion: 'product-details-v1',
            skipped: false
          }
        };
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

    const response = await request(createApp({ database, productDetailsEnrichmentService })).post(
      '/discovery/listings/920/create-item'
    );

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: updatedCandidate });
    expect(enrichmentCalls).toEqual([{ id: 920, options: { updateLinkedItem: false } }]);
    expect(normalizeSql(queries[1].sql)).toContain('insert into items');
  });

  it('does not enrich product details during item creation when all details already exist', async () => {
    const candidate = {
      description: 'Already enriched.',
      id: '920',
      image_url: 'https://store.mx/cafe-barista.jpg',
      item_id: null,
      item_type: 'base_game',
      max_minutes: 45,
      max_players: 4,
      min_age: 8,
      min_minutes: 30,
      min_players: 2,
      publisher: 'Local Publisher',
      source_url: 'https://store.mx/products/cafe-barista',
      store_id: 42,
      title: 'Cafe Barista'
    };
    const updatedCandidate = {
      ...candidate,
      item_id: 77,
      listing_status: 'PENDING'
    };
    const productDetailsEnrichmentService: ProductDetailsEnrichmentService = {
      enrichCandidate: async () => {
        throw new Error('should not enrich complete details');
      }
    };
    const database: Database = {
      query: async (sql) => {
        if (normalizeSql(sql).startsWith('select')) {
          return { rows: [candidate] };
        }
        return { rows: [updatedCandidate] };
      }
    };

    const response = await request(createApp({ database, productDetailsEnrichmentService })).post(
      '/discovery/listings/920/create-item'
    );

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: updatedCandidate });
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
      listing_status: 'PENDING'
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
      '377061',
      null,
      null
    ]);
  });

  it('creates a curated item with an extension relationship to an existing item', async () => {
    const candidate = {
      description: 'An expansion for an existing game.',
      id: '922',
      image_url: 'https://store.mx/cafe-barista-expansion.jpg',
      item_id: null,
      item_type: 'expansion',
      publisher: 'Local Publisher',
      source_url: 'https://store.mx/products/cafe-barista-expansion',
      store_id: 42,
      title: 'Cafe Barista Expansion'
    };
    const updatedCandidate = {
      ...candidate,
      item_id: 79,
      match_source: 'MANUAL',
      listing_status: 'PENDING'
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

    const response = await request(createApp({ database }))
      .post('/discovery/listings/922/create-item')
      .send({ extends: true, extends_item_id: '55' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: updatedCandidate });
    const mutation = queries[1];
    const sql = normalizeSql(mutation.sql);
    expect(sql).toContain('extension_relationship as');
    expect(sql).toContain("'extension'");
    expect(sql).toContain("'admin'");
    expect(sql).toContain('candidate.title, $2, $3, $9::bigint');
    expect(mutation.params).toEqual([
      '922',
      'cafe barista expansion',
      'expansion',
      'local publisher',
      JSON.stringify(['Manual item creation from admin candidate form']),
      JSON.stringify({ extends: true, extends_item_id: 55, source: 'admin_manual_create_item' }),
      null,
      null,
      55,
      '55'
    ]);
  });

  it('copies parent taxonomy links when creating an implementation item from a candidate', async () => {
    const candidate = {
      description: 'A local implementation of an existing game.',
      id: '921',
      image_url: 'https://store.mx/cafe-barista-dice.jpg',
      item_id: null,
      item_type: 'base_game',
      publisher: 'Local Publisher',
      source_url: 'https://store.mx/products/cafe-barista-dice',
      store_id: 42,
      title: 'Cafe Barista Dice'
    };
    const updatedCandidate = {
      ...candidate,
      item_id: 78,
      match_source: 'MANUAL',
      listing_status: 'PENDING'
    };
    const bggItemImporter = {
      importBggId: async () => 44
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
      .post('/discovery/listings/921/create-item')
      .send({ bgg_id: '377061', implements: true });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: updatedCandidate });
    const sql = normalizeSql(queries[1].sql);
    expect(sql).toContain('taxonomy_parent_items as');
    expect(sql).toContain('select $7::bigint as item_id');
    expect(sql).toContain('insert into item_categories (item_id, category_id)');
    expect(sql).toContain('select created_item.id, parent_categories.category_id');
    expect(sql).toContain('join item_categories parent_categories on parent_categories.item_id = taxonomy_parent_items.item_id');
    expect(sql).toContain('insert into item_families (item_id, family_id)');
    expect(sql).toContain('select created_item.id, parent_families.family_id');
    expect(sql).toContain('join item_families parent_families on parent_families.item_id = taxonomy_parent_items.item_id');
    expect(sql).toContain('insert into item_mechanics (item_id, mechanic_id)');
    expect(sql).toContain('select created_item.id, parent_mechanics.mechanic_id');
    expect(sql).toContain('join item_mechanics parent_mechanics on parent_mechanics.item_id = taxonomy_parent_items.item_id');
    expect(sql).toContain('on conflict do nothing');
    expect(queries[1].params?.[6]).toBe(44);
  });

  it('copies parent taxonomy links when creating an extension item from a candidate', async () => {
    const candidate = {
      description: 'An expansion of an existing game.',
      id: '923',
      image_url: 'https://store.mx/cafe-barista-expansion.jpg',
      item_id: null,
      item_type: 'expansion',
      publisher: 'Local Publisher',
      source_url: 'https://store.mx/products/cafe-barista-expansion',
      store_id: 42,
      title: 'Cafe Barista Expansion'
    };
    const updatedCandidate = {
      ...candidate,
      item_id: 80,
      match_source: 'MANUAL',
      listing_status: 'PENDING'
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

    const response = await request(createApp({ database }))
      .post('/discovery/listings/923/create-item')
      .send({ extends: true, extends_item_id: '55' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: updatedCandidate });
    const sql = normalizeSql(queries[1].sql);
    expect(sql).toContain('taxonomy_parent_items as');
    expect(sql).toContain('select $9::bigint as item_id');
    expect(sql).toContain('join item_categories parent_categories on parent_categories.item_id = taxonomy_parent_items.item_id');
    expect(sql).toContain('join item_families parent_families on parent_families.item_id = taxonomy_parent_items.item_id');
    expect(sql).toContain('join item_mechanics parent_mechanics on parent_mechanics.item_id = taxonomy_parent_items.item_id');
    expect(queries[1].params?.[8]).toBe(55);
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
      listing_status: 'PENDING',
      store_id: 42,
      title: 'CafÃ© Barista'
    };
    const updatedCandidate = {
      ...candidate,
      item_id: 77,
      matched_bgg_id: 377061,
      listing_status: 'PENDING'
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
    expect(sql).not.toContain("status = 'listed'");
    expect(sql).not.toContain('listing_status =');
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
      listing_status: 'PENDING'
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
    const updatedRow = { id: '3365', listing_status: 'UNLISTED', title: 'Kitchen Rush Updated' };
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
        listing_status: 'UNLISTED',
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
      'UNLISTED',
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

  it('queries confirmed boardgame store items with optional item comparison data', async () => {
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
    expect(sql).toContain('left join items i on i.id = dic.item_id');
    expect(sql).toContain('left join stores s on s.id = dic.store_id');
    expect(sql).toContain('dic.is_boardgame = true');
    expect(sql).toContain('dic.is_boardgame_confirmed = true');
    expect(sql).not.toContain("dic.status = 'listed'");
    expect(sql).not.toContain('dic.item_id is not null');
    expect(sql).toContain('candidate_image_url');
    expect(sql).toContain('candidate_description');
    expect(sql).toContain('item_image_url');
    expect(sql).toContain('i.description as item_description');
    expect(sql).toContain('i.description_es as item_description_es');
    expect(sql).toContain('i.canonical_name_es as item_name_es');
    expect(sql).toContain('i.image_url_es as item_image_url_es');
    expect(sql).toContain('dic.listing_status as store_item_listing_status');
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
    expect(sql).toContain('left join items i on i.id = dic.item_id');
    expect(sql).toContain('dic.is_boardgame = true');
    expect(sql).toContain('dic.is_boardgame_confirmed = true');
    expect(sql).not.toContain("dic.status = 'listed'");
    expect(sql).not.toContain('dic.item_id is not null');
    expect(sql).toContain("coalesce((concat_ws(' ', i.canonical_name, i.canonical_name_es))::text, '') ilike $1 escape '\\'");
    expect(sql).toContain('order by i.canonical_name asc');
    expect(rowQuery?.params).toEqual(['%kitchen%', 25, 0]);
  });

  it('filters and sorts store item reviews by listing status', async () => {
    const rows = [
      {
        candidate_id: 3365,
        candidate_name: 'Kitchen Rush',
        item_name: 'Kitchen Rush',
        store_item_listing_status: 'LISTED'
      }
    ];
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
      '/admin/discovery/offer-reviews?page=0&page_size=25&sort=store_item_listing_status&sort_direction=asc&filter_store_item_listing_status=listed'
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
    expect(sql).toContain("coalesce((dic.listing_status)::text, '') ilike $1 escape '\\'");
    expect(sql).toContain('order by dic.listing_status asc');
    expect(rowQuery?.params).toEqual(['%listed%', 25, 0]);
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
    const calls: Array<{ id: number; options: unknown }> = [];
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

  it('confirms a store item as boardgame and runs item matching', async () => {
    const row = {
      id: 42,
      is_boardgame: true,
      is_boardgame_confirmed: true,
      item_id: 77,
      match_source: 'LOCAL',
      listing_status: 'PENDING',
      title: 'Coffee Rush'
    };
    const calls: Array<{ id: number; options: { confirmationSource?: 'admin' | 'automated' } | undefined }> = [];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [row] };
      }
    };
    const itemMatchingService: ItemMatchingService = {
      confirmBoardgameAndMatch: async (id, options) => {
        calls.push({ id, options });
      },
      generateMatchCandidates: async () => [],
      listMatchCandidates: async () => []
    };

    const response = await request(createApp({ database, itemMatchingService })).post('/discovery/listings/42/confirm-boardgame');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: row });
    expect(calls).toEqual([{ id: 42, options: { confirmationSource: 'admin' } }]);
    expect(normalizeSql(queries[0].sql)).toContain('from store_items');
    expect(normalizeSql(queries[0].sql)).toContain('where id = $1');
    expect(queries[0].params).toEqual([42]);
  });

  it('passes automated confirmation source to boardgame matching', async () => {
    const row = {
      id: 42,
      is_boardgame: true,
      is_boardgame_confirmed: false,
      item_id: null,
      match_source: 'NONE',
      listing_status: 'PENDING',
      title: 'False Positive'
    };
    const calls: Array<{ id: number; options: { confirmationSource?: 'admin' | 'automated' } | undefined }> = [];
    const database: Database = {
      query: async () => ({ rows: [row] })
    };
    const itemMatchingService: ItemMatchingService = {
      confirmBoardgameAndMatch: async (id, options) => {
        calls.push({ id, options });
      },
      generateMatchCandidates: async () => [],
      listMatchCandidates: async () => []
    };

    const response = await request(createApp({ database, itemMatchingService }))
      .post('/discovery/listings/42/confirm-boardgame')
      .send({ confirmation_source: 'automated' });

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ id: 42, options: { confirmationSource: 'automated' } }]);
  });

  it('passes trace logger context from internal matcher headers to boardgame matching', async () => {
    const row = {
      id: 42,
      is_boardgame: true,
      is_boardgame_confirmed: false,
      item_id: null,
      match_source: 'NONE',
      listing_status: 'PENDING',
      title: 'False Positive'
    };
    const calls: Array<{
      id: number;
      options:
        | {
            confirmationSource?: 'admin' | 'automated';
            traceLogger?: { log(event: string, fields?: Record<string, unknown>): void };
          }
        | undefined;
    }> = [];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return normalizeSql(sql).startsWith('insert into store_item_discovery_trace_log') ? { rows: [] } : { rows: [row] };
      }
    };
    const itemMatchingService: ItemMatchingService = {
      confirmBoardgameAndMatch: async (id, options) => {
        calls.push({ id, options });
        options?.traceLogger?.log('item_matcher.test', { candidate_id: id });
      },
      generateMatchCandidates: async () => [],
      listMatchCandidates: async () => []
    };

    const response = await request(createApp({ database, itemMatchingService }))
      .post('/discovery/listings/42/confirm-boardgame')
      .set('X-Ludora-Trace-Run-Id', 'run-123')
      .send({ confirmation_source: 'automated' });

    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({
      id: 42,
      options: {
        confirmationSource: 'automated',
        traceLogger: expect.objectContaining({ log: expect.any(Function) })
      }
    });
    const traceQuery = queries.find((query) => normalizeSql(query.sql).startsWith('insert into store_item_discovery_trace_log'));
    expect(traceQuery?.params).toEqual(['run-123', 'item_matcher.test', expect.stringContaining('"candidate_id":42')]);
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

  it('creates admin description generations with one source description', async () => {
    const calls: DescriptionGenerationRequest[] = [];
    const descriptionGenerationService: DescriptionGenerationService = {
      generate: async (request) => {
        calls.push(request);
        return {
          descriptionEs: 'Una descripcion generada desde una sola fuente.',
          metadata: {
            sourceBalance: 'single_source',
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
        boardgame_name: 'Star Wars: Unlimited',
        description_1: 'A tactical card game set in the Star Wars galaxy.'
      });

    expect(response.status).toBe(201);
    expect(calls).toEqual([
      {
        boardgameName: 'Star Wars: Unlimited',
        description1: 'A tactical card game set in the Star Wars galaxy.',
        description2: ''
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
        boardgame_name: 'Coffee Rush'
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        message: 'boardgame_name and at least one source description are required'
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
      cancelStoreDiscoveryRun: async () => run,
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => run,
      startItemDiscoveryRun: async () => run,
      startItemEmbeddingRun: async () => run,
      startItemUpdateRun: async () => run,
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
      cancelStoreDiscoveryRun: async () => run,
      getLatestStoreDiscoveryRun: async () => run,
      getStoreDiscoveryRun: async () => run,
      startItemDiscoveryRun: async () => run,
      startItemEmbeddingRun: async () => run,
      startItemUpdateRun: async () => run,
      startStoreDiscoveryRun: async () => run
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient })).get(
      '/admin/operations/store-discovery-runs/latest'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: run });
  });

  it('returns 503 when product details extraction is not configured', async () => {
    const response = await request(createApp({ database: idleDatabase() })).post(
      '/admin/discovery/item-candidates/920/product-details'
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        message: 'Product details extraction service is not configured'
      }
    });
  });

  it('extracts Amazon game titles through the configured admin AI service', async () => {
    const calls: AmazonTitleExtractionRequest[] = [];
    const amazonTitleExtractionService: AmazonTitleExtractionService = {
      extract: async (input) => {
        calls.push(input);
        return {
          gameTitle: 'Yokai Pagoda',
          metadata: {
            confidence: 0.96,
            removedNoise: ['La Compania de los Juegos', 'marketing copy'],
            warnings: []
          },
          model: 'gpt-5.4-nano',
          promptVersion: 'amazon-title-v1'
        };
      }
    };

    const response = await request(createApp({ amazonTitleExtractionService, database: idleDatabase() }))
      .post('/admin/ai/amazon-title-extractions')
      .send({
        amazon_title:
          'La Compania de los Juegos | Yokai Pagoda | Juega Cartas para Evitar Recibir Puntos Negativos | Juego en Espanol',
        raw_payload: {
          amazon: {
            asin: 'B0TEST1234'
          }
        },
        source_url: 'https://www.amazon.com.mx/dp/B0TEST1234'
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      data: {
        game_title: 'Yokai Pagoda',
        metadata: {
          confidence: 0.96,
          removedNoise: ['La Compania de los Juegos', 'marketing copy'],
          warnings: []
        },
        model: 'gpt-5.4-nano',
        prompt_version: 'amazon-title-v1'
      }
    });
    expect(calls).toEqual([
      {
        amazonTitle:
          'La Compania de los Juegos | Yokai Pagoda | Juega Cartas para Evitar Recibir Puntos Negativos | Juego en Espanol',
        rawPayload: {
          amazon: {
            asin: 'B0TEST1234'
          }
        },
        sourceUrl: 'https://www.amazon.com.mx/dp/B0TEST1234'
      }
    ]);
  });

  it('returns 503 when Amazon title extraction is not configured', async () => {
    const response = await request(createApp({ database: idleDatabase() }))
      .post('/admin/ai/amazon-title-extractions')
      .send({
        amazon_title: 'La Compania de los Juegos | Yokai Pagoda | Juego en Espanol',
        source_url: 'https://www.amazon.com.mx/dp/B0TEST1234'
      });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        message: 'Amazon title extraction service is not configured'
      }
    });
  });

  it('enriches product details for an existing linked item candidate', async () => {
    const candidate = {
      id: 920,
      item_id: 77,
      max_minutes: 45,
      max_players: 4,
      min_age: 8,
      min_minutes: 30,
      min_players: 2,
      title: 'Cafe Barista'
    };
    const calls: Array<{ id: number; options?: { updateLinkedItem?: boolean } }> = [];
    const productDetailsEnrichmentService: ProductDetailsEnrichmentService = {
      enrichCandidate: async (id, options) => {
        calls.push({ id, options });
        return {
          candidate,
          extraction: {
            details: {
              maxMinutes: 45,
              maxPlayers: 4,
              minAge: 8,
              minMinutes: 30,
              minPlayers: 2
            },
            extractedDetails: {
              maxMinutes: 45,
              maxPlayers: 4,
              minAge: 8,
              minMinutes: 30,
              minPlayers: 2
            },
            metadata: {
              confidence: 0.91,
              evidence: ['2-4 jugadores', '30-45 minutos'],
              warnings: []
            },
            model: 'gpt-5.4-nano',
            promptVersion: 'product-details-v1',
            skipped: false
          }
        };
      }
    };

    const response = await request(createApp({ database: idleDatabase(), productDetailsEnrichmentService })).post(
      '/admin/discovery/item-candidates/920/product-details'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: candidate,
      extraction: {
        details: {
          max_minutes: 45,
          max_players: 4,
          min_age: 8,
          min_minutes: 30,
          min_players: 2
        },
        extracted_details: {
          max_minutes: 45,
          max_players: 4,
          min_age: 8,
          min_minutes: 30,
          min_players: 2
        },
        metadata: {
          confidence: 0.91,
          evidence: ['2-4 jugadores', '30-45 minutos'],
          warnings: []
        },
        model: 'gpt-5.4-nano',
        prompt_version: 'product-details-v1',
        skipped: false
      }
    });
    expect(calls).toEqual([{ id: 920, options: { updateLinkedItem: true } }]);
  });

  it('cancels running discovery operations through the discovery operations client', async () => {
    const run: StoreDiscoveryRun = {
      completed_at: null,
      error: null,
      id: 'run-1',
      result: null,
      started_at: '2026-06-27T08:00:00Z',
      status: 'cancelling',
      type: 'item_discovery'
    };
    const calls: string[] = [];
    const operationsClient: DiscoveryOperationsClient = {
      cancelStoreDiscoveryRun: async (runId) => {
        calls.push(runId);
        return run;
      },
      getLatestStoreDiscoveryRun: async () => run,
      getStoreDiscoveryRun: async () => run,
      startItemDiscoveryRun: async () => run,
      startItemEmbeddingRun: async () => run,
      startItemUpdateRun: async () => run,
      startStoreDiscoveryRun: async () => run
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient })).post(
      '/admin/operations/store-discovery-runs/run-1/cancel'
    );

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: run });
    expect(calls).toEqual(['run-1']);
  });

  it('preserves discovery API conflicts when store discovery is already running', async () => {
    const operationsClient: DiscoveryOperationsClient = {
      cancelStoreDiscoveryRun: async () => {
        throw new DiscoveryOperationError('Store discovery is already running', 409);
      },
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => null,
      startItemDiscoveryRun: async () => {
        throw new DiscoveryOperationError('Store discovery is already running', 409);
      },
      startItemEmbeddingRun: async () => {
        throw new DiscoveryOperationError('Store discovery is already running', 409);
      },
      startItemUpdateRun: async () => {
        throw new DiscoveryOperationError('Store discovery is already running', 409);
      },
      startStoreDiscoveryRun: async () => {
        throw new DiscoveryOperationError('Store discovery is already running', 409);
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
    const calls: Array<{ storeId: number; websiteUrl: string; platform: string; storeName: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        expect(normalizeSql(sql)).toContain('from stores');
        expect(normalizeSql(sql)).toContain('name');
        expect(normalizeSql(sql)).toContain('platform');
        expect(params).toEqual(['12']);
        return { rows: [{ id: 12, name: 'Hasbro Gaming', platform: 'amazon_brand', website_url: 'https://example.mx/' }] };
      }
    };
    const operationsClient: DiscoveryOperationsClient = {
      cancelStoreDiscoveryRun: async () => run,
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => run,
      startItemDiscoveryRun: async (storeId, websiteUrl, platform, storeName) => {
        calls.push({ storeId, platform, storeName, websiteUrl });
        return run;
      },
      startItemEmbeddingRun: async () => run,
      startItemUpdateRun: async () => run,
      startStoreDiscoveryRun: async () => run
    };

    const response = await request(createApp({ database, operationsClient })).post(
      '/admin/operations/stores/12/item-discovery-runs'
    );

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: run });
    expect(calls).toEqual([{ storeId: 12, platform: 'amazon_brand', storeName: 'Hasbro Gaming', websiteUrl: 'https://example.mx/' }]);
  });

  it('starts item discovery runs for selected stores through the discovery operations client', async () => {
    const run: StoreDiscoveryRun = {
      completed_at: null,
      error: null,
      id: 'run-discovery-selected',
      result: {
        item_candidates: 5,
        new_items: 5,
        store_id: null,
        stores_scanned: 1,
        website_url: ''
      },
      started_at: '2026-07-05T20:00:00Z',
      status: 'completed',
      type: 'item_discovery'
    };
    const calls: unknown[] = [];
    const operationsClient: DiscoveryOperationsClient = {
      cancelStoreDiscoveryRun: async () => run,
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => run,
      startItemDiscoveryRun: async (scope) => {
        calls.push(scope);
        return run;
      },
      startItemEmbeddingRun: async () => run,
      startItemUpdateRun: async () => {
        throw new Error('should not start item update');
      },
      startStoreDiscoveryRun: async () => run
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-discovery-runs')
      .send({ store_ids: [12, 34] });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: run });
    expect(calls).toEqual([{ store_ids: [12, 34] }]);
  });

  it('starts item discovery runs for all stores through the discovery operations client', async () => {
    const run: StoreDiscoveryRun = {
      completed_at: null,
      error: null,
      id: 'run-discovery-all',
      result: {
        item_candidates: 9,
        new_items: 9,
        store_id: null,
        stores_scanned: 3,
        website_url: ''
      },
      started_at: '2026-07-05T20:00:00Z',
      status: 'completed',
      type: 'item_discovery'
    };
    const calls: unknown[] = [];
    const operationsClient: DiscoveryOperationsClient = {
      cancelStoreDiscoveryRun: async () => run,
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => run,
      startItemDiscoveryRun: async (scope) => {
        calls.push(scope);
        return run;
      },
      startItemEmbeddingRun: async () => run,
      startItemUpdateRun: async () => {
        throw new Error('should not start item update');
      },
      startStoreDiscoveryRun: async () => run
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-discovery-runs')
      .send({ all_stores: true });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: run });
    expect(calls).toEqual([{ all_stores: true }]);
  });

  it('rejects item discovery requests with invalid selected store ids', async () => {
    const operationsClient: DiscoveryOperationsClient = {
      cancelStoreDiscoveryRun: async () => {
        throw new Error('should not call operations client');
      },
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => null,
      startItemDiscoveryRun: async () => {
        throw new Error('should not call operations client');
      },
      startItemEmbeddingRun: async () => {
        throw new Error('should not call operations client');
      },
      startItemUpdateRun: async () => {
        throw new Error('should not call operations client');
      },
      startStoreDiscoveryRun: async () => {
        throw new Error('should not call operations client');
      }
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-discovery-runs')
      .send({ store_ids: [12, 12] });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { message: 'store_ids must not contain duplicates' } });
  });

  it('lists store item discovery job logs from the job table', async () => {
    const rows = [
      {
        completed_at: '2026-07-05T20:03:00Z',
        created_at: '2026-07-05T20:00:00Z',
        error: '',
        id: 19,
        new_items: 7,
        run_id: 'run-discovery-19',
        started_at: '2026-07-05T20:00:00Z',
        status: 'completed',
        store_id: 12,
        store_name: 'Alpha Games',
        updated_at: '2026-07-05T20:03:00Z',
        website_url: 'https://store.example'
      }
    ];
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

    const response = await request(createApp({ database, operationsClient: idleOperationsClient() })).get(
      '/admin/operations/store-item-discovery-jobs?page=0&page_size=25&sort=started_at&sort_direction=desc&filter_store_name=Alpha'
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
    const rowQuery = queries.find((query) => normalizeSql(query.sql).startsWith('select jobs.id, jobs.run_id'));
    const countQuery = queries.find((query) => normalizeSql(query.sql).includes('count(*)'));
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('from job_store_item_discovery_log');
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('left join stores on stores.id = jobs.store_id');
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain("where coalesce((stores.name)::text, '') ilike $1 escape '\\'");
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('order by jobs.started_at desc');
    expect(rowQuery?.params).toEqual(['%Alpha%', 25, 0]);
    expect(countQuery?.params).toEqual(['%Alpha%']);
  });

  it('returns database trace entries for a store item discovery job after a row id', async () => {
    const job = {
      completed_at: '2026-07-11T12:01:00Z',
      id: 19,
      run_id: 'run-batch:12',
      started_at: '2026-07-11T12:00:00Z',
      status: 'completed',
      store_id: 12,
      store_name: 'Alpha Games'
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).includes('from store_item_discovery_trace_log')) {
          return {
            rows: [
              {
                created_at: '2026-07-11T12:01:00Z',
                event: 'item_discovery.run.completed',
                id: 91,
                payload: { elapsed_ms: 1000, new_items: 7 },
                run_id: 'run-batch:12',
                source: 'discovery'
              }
            ]
          };
        }
        return { rows: [job] };
      }
    };

    const app = createApp({ database, operationsClient: idleOperationsClient() });
    const response = await request(app).get('/admin/operations/store-item-discovery-jobs/19/log?after_id=90');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        entries: [
          {
            created_at: '2026-07-11T12:01:00Z',
            event: 'item_discovery.run.completed',
            id: 91,
            payload: { elapsed_ms: 1000, new_items: 7 },
            run_id: 'run-batch:12',
            source: 'discovery'
          }
        ],
        has_more: false,
        job,
        next_cursor: 91
      }
    });
    expect(normalizeSql(queries[0]?.sql ?? '')).toContain(
      'from job_store_item_discovery_log jobs left join stores on stores.id = jobs.store_id where jobs.id = $1'
    );
    expect(queries[0]?.params).toEqual([19]);
    expect(normalizeSql(queries[1]?.sql ?? '')).toContain('from store_item_discovery_trace_log');
    expect(queries[1]?.params).toEqual(['run-batch:12', 90, 1001]);
  });

  it('lists store item update job logs from the job table', async () => {
    const rows = [
      {
        completed_at: '2026-07-05T21:04:00Z',
        created_at: '2026-07-05T21:00:00Z',
        error: '',
        id: 27,
        run_id: 'run-update-27',
        scanned_items: 18,
        started_at: '2026-07-05T21:00:00Z',
        status: 'completed',
        store_id: 12,
        store_name: 'Alpha Games',
        updated_at: '2026-07-05T21:04:00Z',
        updated_items: 5
      }
    ];
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

    const response = await request(createApp({ database, operationsClient: idleOperationsClient() })).get(
      '/admin/operations/store-item-update-jobs?page=0&page_size=25&sort=scanned_items&sort_direction=desc&filter_store_name=Alpha'
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
    const rowQuery = queries.find((query) => normalizeSql(query.sql).startsWith('select jobs.id, jobs.run_id'));
    const countQuery = queries.find((query) => normalizeSql(query.sql).includes('count(*)'));
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('from job_store_item_update_log');
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('left join stores on stores.id = jobs.store_id');
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain("where coalesce((stores.name)::text, '') ilike $1 escape '\\'");
    expect(normalizeSql(rowQuery?.sql ?? '')).toContain('order by jobs.scanned_items desc');
    expect(rowQuery?.params).toEqual(['%Alpha%', 25, 0]);
    expect(countQuery?.params).toEqual(['%Alpha%']);
  });

  it('lists store item update changes for the store that owns the selected run', async () => {
    const job = {
      completed_at: null,
      id: 27,
      run_id: 'run-update-27',
      started_at: '2026-07-11T20:00:00Z',
      status: 'running',
      store_id: 12,
      store_name: 'Alpha Games'
    };
    const changes = [
      {
        created_at: '2026-07-11T20:01:00Z',
        field_name: 'price',
        id: 91,
        job_id: 27,
        new_value: 799,
        old_value: 899,
        run_id: 'run-update-27',
        source_url: 'https://alpha.example/game',
        store_id: 12,
        store_item_id: 501,
        store_item_title: 'Coffee Rush',
        store_name: 'Alpha Games'
      }
    ];
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        const normalizedSql = normalizeSql(sql);
        if (normalizedSql.includes('from job_store_item_update_log')) {
          return { rows: [job] };
        }
        if (normalizedSql.startsWith('select count(*)')) {
          return { rows: [{ total: changes.length }] };
        }
        return { rows: changes };
      }
    };

    const response = await request(createApp({ database, operationsClient: idleOperationsClient() })).get(
      '/admin/operations/store-item-update-jobs/run-update-27/changes?filter_field_name=price'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: { changes, job },
      meta: { page: 0, page_size: 25, total: 1 }
    });
    expect(normalizeSql(queries[0]?.sql ?? '')).toContain(
      'from job_store_item_update_log jobs left join stores on stores.id = jobs.store_id where jobs.run_id = $1'
    );
    expect(queries[0]?.params).toEqual(['run-update-27']);
    expect(normalizeSql(queries[1]?.sql ?? '')).toContain('from store_item_update_change_log changes');
    expect(normalizeSql(queries[1]?.sql ?? '')).toContain('where store_items.store_id = $1');
    expect(normalizeSql(queries[1]?.sql ?? '')).toContain("coalesce((changes.field_name)::text, '') ilike $2 escape '\\'");
    expect(normalizeSql(queries[1]?.sql ?? '')).toContain('order by changes.created_at desc, changes.id desc');
    expect(normalizeSql(queries[1]?.sql ?? '')).toContain('limit $3 offset $4');
    expect(queries[1]?.params).toEqual([12, '%price%', 25, 0]);
    expect(normalizeSql(queries[2]?.sql ?? '')).toContain('select count(*)::int as total');
    expect(queries[2]?.params).toEqual([12, '%price%']);
  });

  it('starts item update runs through the discovery operations client', async () => {
    const run: StoreDiscoveryRun = {
      completed_at: null,
      error: null,
      id: 'run-3',
      result: {
        updated_items: 8
      },
      started_at: '2026-06-08T20:00:00Z',
      status: 'completed',
      type: 'item_update'
    };
    const calls: string[] = [];
    const operationsClient: DiscoveryOperationsClient = {
      cancelStoreDiscoveryRun: async () => run,
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => run,
      startItemDiscoveryRun: async () => {
        throw new Error('should not start item discovery');
      },
      startItemEmbeddingRun: async () => {
        throw new Error('should not start item embeddings');
      },
      startItemUpdateRun: async () => {
        calls.push('item_update');
        return run;
      },
      startStoreDiscoveryRun: async () => run
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient })).post(
      '/admin/operations/item-update-runs'
    );

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: run });
    expect(calls).toEqual(['item_update']);
  });

  it('starts item update runs for selected stores through the discovery operations client', async () => {
    const run: StoreDiscoveryRun = {
      completed_at: null,
      error: null,
      id: 'run-selected',
      result: {
        updated_items: 3
      },
      started_at: '2026-07-05T20:00:00Z',
      status: 'completed',
      type: 'item_update'
    };
    const calls: unknown[] = [];
    const operationsClient: DiscoveryOperationsClient = {
      cancelStoreDiscoveryRun: async () => run,
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => run,
      startItemDiscoveryRun: async () => {
        throw new Error('should not start item discovery');
      },
      startItemEmbeddingRun: async () => {
        throw new Error('should not start item embeddings');
      },
      startItemUpdateRun: async (scope) => {
        calls.push(scope);
        return run;
      },
      startStoreDiscoveryRun: async () => run
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-update-runs')
      .send({ store_ids: [12, 34] });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: run });
    expect(calls).toEqual([{ store_ids: [12, 34] }]);
  });

  it('starts item update runs for all stores through the discovery operations client', async () => {
    const run: StoreDiscoveryRun = {
      completed_at: null,
      error: null,
      id: 'run-all',
      result: {
        updated_items: 8
      },
      started_at: '2026-07-05T20:00:00Z',
      status: 'completed',
      type: 'item_update'
    };
    const calls: unknown[] = [];
    const operationsClient: DiscoveryOperationsClient = {
      cancelStoreDiscoveryRun: async () => run,
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => run,
      startItemDiscoveryRun: async () => {
        throw new Error('should not start item discovery');
      },
      startItemEmbeddingRun: async () => {
        throw new Error('should not start item embeddings');
      },
      startItemUpdateRun: async (scope) => {
        calls.push(scope);
        return run;
      },
      startStoreDiscoveryRun: async () => run
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-update-runs')
      .send({ all_stores: true });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: run });
    expect(calls).toEqual([{ all_stores: true }]);
  });

  it('rejects item update requests that combine all stores and selected stores', async () => {
    const operationsClient: DiscoveryOperationsClient = {
      cancelStoreDiscoveryRun: async () => {
        throw new Error('should not call operations client');
      },
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => null,
      startItemDiscoveryRun: async () => {
        throw new Error('should not call operations client');
      },
      startItemEmbeddingRun: async () => {
        throw new Error('should not call operations client');
      },
      startItemUpdateRun: async () => {
        throw new Error('should not call operations client');
      },
      startStoreDiscoveryRun: async () => {
        throw new Error('should not call operations client');
      }
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-update-runs')
      .send({ all_stores: true, store_ids: [12] });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { message: 'Specify either all_stores or store_ids, not both' } });
  });

  it('rejects item update requests with invalid selected store ids', async () => {
    const operationsClient: DiscoveryOperationsClient = {
      cancelStoreDiscoveryRun: async () => {
        throw new Error('should not call operations client');
      },
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => null,
      startItemDiscoveryRun: async () => {
        throw new Error('should not call operations client');
      },
      startItemEmbeddingRun: async () => {
        throw new Error('should not call operations client');
      },
      startItemUpdateRun: async () => {
        throw new Error('should not call operations client');
      },
      startStoreDiscoveryRun: async () => {
        throw new Error('should not call operations client');
      }
    };

    const emptyResponse = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-update-runs')
      .send({ store_ids: [] });
    const invalidResponse = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-update-runs')
      .send({ store_ids: [12, 'nope'] });
    const duplicateResponse = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-update-runs')
      .send({ store_ids: [12, 12] });
    const stringNumericResponse = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-update-runs')
      .send({ store_ids: ['12'] });
    const booleanResponse = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-update-runs')
      .send({ store_ids: [true] });
    const arrayResponse = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-update-runs')
      .send({ store_ids: [[12]] });
    const typoResponse = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-update-runs')
      .send({ store_id: [12] });
    const falseAllStoresResponse = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-update-runs')
      .send({ all_stores: false });

    expect(emptyResponse.status).toBe(400);
    expect(emptyResponse.body).toEqual({ error: { message: 'store_ids must be a non-empty array' } });
    expect(invalidResponse.status).toBe(400);
    expect(invalidResponse.body).toEqual({ error: { message: 'store_ids must contain positive integers' } });
    expect(duplicateResponse.status).toBe(400);
    expect(duplicateResponse.body).toEqual({ error: { message: 'store_ids must not contain duplicates' } });
    expect(stringNumericResponse.status).toBe(400);
    expect(stringNumericResponse.body).toEqual({ error: { message: 'store_ids must contain positive integers' } });
    expect(booleanResponse.status).toBe(400);
    expect(booleanResponse.body).toEqual({ error: { message: 'store_ids must contain positive integers' } });
    expect(arrayResponse.status).toBe(400);
    expect(arrayResponse.body).toEqual({ error: { message: 'store_ids must contain positive integers' } });
    expect(typoResponse.status).toBe(400);
    expect(typoResponse.body).toEqual({ error: { message: 'Item update scope must include all_stores or store_ids' } });
    expect(falseAllStoresResponse.status).toBe(400);
    expect(falseAllStoresResponse.body).toEqual({ error: { message: 'all_stores must be true when provided' } });
  });

  it('starts item embedding runs through the discovery operations client', async () => {
    const run: StoreDiscoveryRun = {
      completed_at: null,
      error: null,
      id: 'run-4',
      result: {
        embedded_items: 8,
        model: 'text-embedding-3-small',
        refresh_mode: 'full',
        selected_items: 8
      },
      started_at: '2026-06-13T20:00:00Z',
      status: 'completed',
      type: 'item_embeddings'
    };
    const calls: string[] = [];
    const operationsClient: DiscoveryOperationsClient = {
      cancelStoreDiscoveryRun: async () => run,
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => run,
      startItemDiscoveryRun: async () => {
        throw new Error('should not start item discovery');
      },
      startItemEmbeddingRun: async (refreshMode) => {
        calls.push(refreshMode);
        return run;
      },
      startItemUpdateRun: async () => {
        throw new Error('should not start item update');
      },
      startStoreDiscoveryRun: async () => run
    };

    const response = await request(createApp({ database: idleDatabase(), operationsClient }))
      .post('/admin/operations/item-embedding-runs')
      .send({ refresh_mode: 'full' });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: run });
    expect(calls).toEqual(['full']);
  });

  it('runs external cover image optimization with apply enabled', async () => {
    const result = {
      failures: [
        {
          error: 'Could not download image: 404 Not Found',
          field: 'image_url_es',
          itemId: 88,
          sourceUrl: 'https://cdn.example/missing.jpg'
        }
      ],
      optimized: [
        {
          applied: true,
          field: 'image_url',
          itemId: 77,
          newName: '77-coffeerush.en.webp',
          optimizedSizeBytes: 84210,
          originalSizeBytes: 180000,
          publicUrl: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/77-coffeerush.en.webp',
          s3Key: 'boardgame/77-coffeerush.en.webp',
          sourceName: 'coffee.jpg',
          sourceUrl: 'https://cf.geekdo-images.com/coffee.jpg'
        }
      ],
      skipped: [],
      summary: {
        downloadedImages: 1,
        failedImages: 1,
        imageFields: 4,
        itemsScanned: 2,
        optimizedImages: 1,
        skippedBlank: 0,
        skippedManaged: 0,
        skippedWithinLimit: 0,
        updatedRows: 1,
        uploadedImages: 1
      }
    };
    const calls: unknown[] = [];
    const externalCoverImageOptimizer = {
      run: async (options: unknown) => {
        calls.push(options);
        return result;
      }
    };

    const response = await request(
      createApp({
        database: idleDatabase(),
        externalCoverImageOptimizer,
        operationsClient: idleOperationsClient()
      })
    ).post('/admin/operations/external-cover-image-optimizations');

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: result });
    expect(calls).toEqual([{ apply: true }]);
  });

  it('returns 404 when starting item discovery for a missing clean store', async () => {
    const operationsClient: DiscoveryOperationsClient = {
      cancelStoreDiscoveryRun: async () => {
        throw new Error('should not call discovery API');
      },
      getLatestStoreDiscoveryRun: async () => null,
      getStoreDiscoveryRun: async () => null,
      startItemDiscoveryRun: async () => {
        throw new Error('should not call discovery API');
      },
      startItemEmbeddingRun: async () => {
        throw new Error('should not call discovery API');
      },
      startItemUpdateRun: async () => {
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

  it('serves the automatic cover flattening workflow through the injected manager', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-flattening-route-'));
    const candidatePath = path.join(directory, 'candidate.png');
    const sourcePath = path.join(directory, 'source.jpg');
    fs.writeFileSync(candidatePath, Buffer.from('candidate-image'));
    fs.writeFileSync(sourcePath, Buffer.from('source-image'));
    const workflow: CoverFlatteningWorkflow = {
      automatic_error: null,
      candidates: [
        {
          aspect_ratio: 1,
          aspect_ratio_method: 'vanishing_points',
          construction: 'two-face cover',
          height: 500,
          index: 1,
          square_snapped: true,
          vanishing_confidence: 0.96,
          width: 500
        }
      ],
      created_at: '2026-07-11T12:00:00.000Z',
      expires_at: '2026-07-11T12:30:00.000Z',
      item_id: 77,
      perspective: 'two_faces',
      source_field: 'image_url_es',
      store_item_id: null,
      workflow_id: 'flatten-77'
    };
    const manualOnlyWorkflow: CoverFlatteningWorkflow = {
      ...workflow,
      automatic_error: 'Flattening must return one or two cover candidates.',
      candidates: [],
      perspective: null,
      source_field: 'store_item_image',
      store_item_id: 3365,
      workflow_id: 'flatten-manual-only'
    };
    const calls: unknown[] = [];
    const manager: CoverFlatteningWorkflowManager = {
      accept: async (workflowId, candidateIndex, targetField, aspectRatio) => {
        calls.push(['accept', workflowId, candidateIndex, targetField, aspectRatio]);
        return {
          item_id: 77,
          optimized_size_bytes: 88_000,
          output_aspect_ratio: aspectRatio ?? 1,
          public_url: 'https://cdn.example/boardgame/cover.webp',
          s3_key: 'boardgame/cover.webp',
          target_field: targetField
        };
      },
      cancel: async (workflowId) => {
        calls.push(['cancel', workflowId]);
      },
      createManualCandidate: async (workflowId, points) => {
        calls.push(['manual', workflowId, points]);
        return {
          ...workflow,
          candidates: [
            ...workflow.candidates,
            {
              aspect_ratio: 1.25,
              aspect_ratio_method: 'edge_average',
              construction: 'manual corner selection',
              height: 400,
              index: 3,
              square_snapped: false,
              vanishing_confidence: 0,
              width: 500
            }
          ]
        };
      },
      getCandidateFile: async (workflowId, candidateIndex) => {
        calls.push(['candidate', workflowId, candidateIndex]);
        return candidatePath;
      },
      getSourceFile: async (workflowId) => {
        calls.push(['source', workflowId]);
        return sourcePath;
      },
      startFromItem: async (itemId, sourceField) => {
        calls.push(['item', itemId, sourceField]);
        return workflow;
      },
      startFromStoreItem: async (storeItemId) => {
        calls.push(['store-item', storeItemId]);
        return manualOnlyWorkflow;
      }
    };
    const app = createApp({ coverFlatteningWorkflowManager: manager, database: idleDatabase() });

    try {
      const start = await request(app)
        .post('/admin/cover-flattening-workflows/items')
        .send({ item_id: 77, source_field: 'image_url_es' });
      const manualOnlyStart = await request(app)
        .post('/admin/cover-flattening-workflows/store-items')
        .send({ store_item_id: 3365 });
      const source = await request(app).get('/admin/cover-flattening-workflows/flatten-77/source');
      const invalidManual = await request(app)
        .post('/admin/cover-flattening-workflows/flatten-77/manual-candidate')
        .send({ points: [{ x: 0, y: 0 }] });
      const manualPoints = [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 }
      ];
      const manual = await request(app)
        .post('/admin/cover-flattening-workflows/flatten-77/manual-candidate')
        .send({ points: manualPoints });
      const candidate = await request(app).get('/admin/cover-flattening-workflows/flatten-77/candidates/1');
      const accepted = await request(app)
        .post('/admin/cover-flattening-workflows/flatten-77/accept')
        .send({ aspect_ratio: 1, candidate_index: 1, target_field: 'image_url' });
      const cancelled = await request(app).delete('/admin/cover-flattening-workflows/flatten-77');

      expect(start.status).toBe(201);
      expect(start.body).toEqual({ data: workflow });
      expect(manualOnlyStart.status).toBe(201);
      expect(manualOnlyStart.body).toEqual({ data: manualOnlyWorkflow });
      expect(manualOnlyStart.body.data).toMatchObject({
        automatic_error: 'Flattening must return one or two cover candidates.',
        candidates: [],
        perspective: null
      });
      expect(source.status).toBe(200);
      expect(source.headers['cache-control']).toBe('no-store');
      expect(invalidManual.status).toBe(400);
      expect(manual.status).toBe(201);
      expect(manual.body.data.candidates).toHaveLength(2);
      expect(manual.body.data.candidates[1]).toMatchObject({ index: 3, construction: 'manual corner selection' });
      expect(candidate.status).toBe(200);
      expect(candidate.headers['cache-control']).toBe('no-store');
      expect(accepted.body.data).toMatchObject({ item_id: 77, target_field: 'image_url' });
      expect(cancelled.body).toEqual({ data: { cancelled: true } });
      expect(calls).toEqual([
        ['item', 77, 'image_url_es'],
        ['store-item', 3365],
        ['source', 'flatten-77'],
        ['manual', 'flatten-77', manualPoints],
        ['candidate', 'flatten-77', 1],
        ['accept', 'flatten-77', 1, 'image_url', 1],
        ['cancel', 'flatten-77']
      ]);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it('starts a local cover workflow through the injected manager', async () => {
    const workflow: LocalCoverWorkflowState = {
      error: null,
      expected_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.webp',
      filename: 'dontgetgot.webp',
      item_id: 77,
      public_url: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/dontgetgot.webp',
      source_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\dontgetgot.source.jpg',
      status: 'waiting_for_edit',
      store_item_id: 123,
      workflow_id: 'cover-123-77'
    };
    const calls: number[] = [];
    const localCoverWorkflowManager: LocalCoverWorkflowManager = {
      getCurrent: () => workflow,
      start: async (storeItemId) => {
        calls.push(storeItemId);
        return workflow;
      },
      startFromItem: async () => {
        throw new Error('should not start workflow from item');
      },
      waitForIdle: async () => undefined
    };

    const response = await request(createApp({ database: idleDatabase(), localCoverWorkflowManager }))
      .post('/admin/local-cover-workflows')
      .send({ store_item_id: 123 });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: workflow });
    expect(calls).toEqual([123]);
  });

  it('starts a local cover workflow from an item through the injected manager', async () => {
    const workflow: LocalCoverWorkflowState = {
      error: null,
      expected_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.es.webp',
      expected_paths: [
        'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.en.webp',
        'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.es.webp'
      ],
      filename: 'coffeerush.es.webp',
      item_id: 77,
      public_url: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/coffeerush.es.webp',
      source_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\coffeerush.source.jpg',
      status: 'waiting_for_edit',
      store_item_id: null,
      target_field: null,
      workflow_id: 'cover-item-77'
    };
    const calls: number[] = [];
    const localCoverWorkflowManager: LocalCoverWorkflowManager = {
      getCurrent: () => workflow,
      start: async () => {
        throw new Error('should not start from store item');
      },
      startFromItem: async (itemId) => {
        calls.push(itemId);
        return workflow;
      },
      waitForIdle: async () => undefined
    };

    const response = await request(createApp({ database: idleDatabase(), localCoverWorkflowManager }))
      .post('/admin/local-cover-workflows/items')
      .send({ item_id: 77 });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: workflow });
    expect(calls).toEqual([77]);
  });

  it('returns the current local cover workflow', async () => {
    const workflow: LocalCoverWorkflowState = {
      error: null,
      expected_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\azul.webp',
      filename: 'azul.webp',
      item_id: 7,
      public_url: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/azul.webp',
      source_path: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame\\azul.source.jpg',
      status: 'completed',
      store_item_id: 20,
      workflow_id: 'cover-20-7'
    };
    const localCoverWorkflowManager: LocalCoverWorkflowManager = {
      getCurrent: () => workflow,
      start: async () => workflow,
      startFromItem: async () => workflow,
      waitForIdle: async () => undefined
    };

    const response = await request(createApp({ database: idleDatabase(), localCoverWorkflowManager })).get(
      '/admin/local-cover-workflows/current'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: workflow });
  });

  it('maps local cover workflow conflicts to 409 responses', async () => {
    const localCoverWorkflowManager: LocalCoverWorkflowManager = {
      getCurrent: () => null,
      start: async () => {
        throw new LocalCoverWorkflowError('A local cover workflow is already active.', 409);
      },
      startFromItem: async () => {
        throw new LocalCoverWorkflowError('A local cover workflow is already active.', 409);
      },
      waitForIdle: async () => undefined
    };

    const response = await request(createApp({ database: idleDatabase(), localCoverWorkflowManager }))
      .post('/admin/local-cover-workflows')
      .send({ store_item_id: 123 });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { message: 'A local cover workflow is already active.' } });
  });

  it('validates local cover workflow store item ids', async () => {
    const localCoverWorkflowManager: LocalCoverWorkflowManager = {
      getCurrent: () => null,
      start: async () => {
        throw new Error('should not start workflow');
      },
      startFromItem: async () => {
        throw new Error('should not start workflow');
      },
      waitForIdle: async () => undefined
    };

    const response = await request(createApp({ database: idleDatabase(), localCoverWorkflowManager }))
      .post('/admin/local-cover-workflows')
      .send({ store_item_id: '' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { message: 'store_item_id must be a positive integer' } });
  });
});

function idleDatabase(): Database {
  return {
    query: async () => ({ rows: [] })
  };
}

function idleOperationsClient(): DiscoveryOperationsClient {
  const run: StoreDiscoveryRun = {
    completed_at: null,
    error: null,
    id: 'idle-run',
    result: null,
    started_at: '2026-07-05T20:00:00Z',
    status: 'completed',
    type: 'store_discovery'
  };

  return {
    cancelStoreDiscoveryRun: async () => run,
    getLatestStoreDiscoveryRun: async () => null,
    getStoreDiscoveryRun: async () => run,
    startItemDiscoveryRun: async () => run,
    startItemEmbeddingRun: async () => run,
    startItemUpdateRun: async () => run,
    startStoreDiscoveryRun: async () => run
  };
}
