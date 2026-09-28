import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { createBggItemImporter } from './bgg/bggItemImporter.js';
import type { BggThingDetails } from './bgg/bggParser.js';
import type { Database } from './db.js';
import { createLocalCoverWorkflowManager } from './localCoverWorkflow.js';

const HASH = 'abcd'.repeat(16);
const hasher = { hashBytes: async () => HASH, hashUrl: async () => HASH };

function sqlText(sql: string): string { return sql.replace(/\s+/g, ' ').trim(); }

describe('catalog image writers', () => {
  it('recomputes hashes when explicitly saving a replacement at the same URL', async () => {
    const saved: unknown[][] = [];
    let currentHash = HASH;
    const database: Database = { query: async (_sql, params) => { saved.push(params ?? []); return { rows: [{ id: 77 }] }; } };
    const app = createApp({ database, catalogImageHasher: { ...hasher, hashUrl: async () => currentHash } });
    const body = { canonical_name: 'Game', image_url: 'https://example.test/stable', image_url_es: '' };
    await request(app).patch('/items/77').send(body).expect(200);
    currentHash = '0123'.repeat(16);
    await request(app).patch('/items/77').send(body).expect(200);
    expect(saved.map((params) => [params[19], params[23]])).toEqual([
      ['https://example.test/stable', HASH], ['https://example.test/stable', '0123'.repeat(16)]
    ]);
  });

  it('rejects copying when the source changed during hashing without writing another cover snapshot', async () => {
    const database: Database = { query: async (sql) => ({ rows: sql.includes('update items') ? [] : [{ item_id: 77, image_url: 'https://store.test/original' }] }) };
    const response = await request(createApp({ database, catalogImageHasher: hasher }))
      .post('/discovery/listings/42/copy-cover-to-item').send({ target_field: 'image_url' });
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('changed while preparing');
  });

  it('edits default and Spanish images atomically, clearing removed and failed images', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const database: Database = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ id: 77 }] }; } };
    const app = createApp({ database, catalogImageHasher: hasher });
    await request(app).patch('/items/77').send({ canonical_name: 'Game', image_url: 'https://example.test/a', image_url_es: '' }).expect(200);
    expect(sqlText(queries[0].sql)).toContain('image_phash = $24');
    expect(queries[0].params?.slice(-2)).toEqual([HASH, null]);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await request(createApp({ database, catalogImageHasher: { ...hasher, hashUrl: async () => { throw new Error('new cover failed'); } } }))
        .patch('/items/77').send({ canonical_name: 'Game', image_url: 'https://example.test/new', image_url_es: '' }).expect(200);
      expect(queries[1].params?.slice(-2)).toEqual([null, null]);
      expect(warning).toHaveBeenCalledWith('Catalog image hash failed: new cover failed');
    } finally { warning.mockRestore(); }
  });

  it('creates an item from the exact source image snapshot that was hashed', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const database: Database = { query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: sql.includes('insert into items') ? [{ id: 920, item_id: 77 }] : [{ id: 920, store_id: 1, title: 'Game', source_url: 'https://store.test/game', image_url: 'https://store.test/original' }] };
    } };
    await request(createApp({ database, catalogImageHasher: hasher })).post('/discovery/listings/920/create-item').expect(201);
    const write = queries.find((query) => query.sql.includes('insert into items'))!;
    expect(sqlText(write.sql)).toContain('image_url, image_phash, status');
    expect(write.params?.slice(-2)).toEqual(['https://store.test/original', HASH]);
    expect(sqlText(write.sql)).not.toContain('candidate.image_url,');
  });

  it.each(['image_url', 'image_url_es'])('copies the source snapshot and hash into %s with a source guard', async (field) => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const database: Database = { query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: sql.includes('update items') ? [{ id: 77 }] : [{ item_id: 77, image_url: 'https://store.test/cover' }] };
    } };
    await request(createApp({ database, catalogImageHasher: hasher })).post('/discovery/listings/42/copy-cover-to-item').send({ target_field: field }).expect(200);
    const write = queries.find((query) => query.sql.includes('update items'))!;
    expect(sqlText(write.sql)).toContain(`${field === 'image_url' ? 'image_phash' : 'image_phash_es'} = $3`);
    expect(sqlText(write.sql)).toContain('source.image_url is not distinct from $2');
    expect(write.params).toEqual([42, 'https://store.test/cover', HASH, 77]);
  });

  it('binds edited local cover bytes to an immutable content key and the same hash', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ludora-hash-writer-'));
    try {
      const edited = path.join(root, 'game.es.webp');
      await writeFile(edited, 'edited bytes');
      const queries: Array<{ sql: string; params?: unknown[] }> = [];
      let uploaded: Buffer | undefined;
      const database: Database = { query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: sql.includes('update items') ? [{ id: 77 }] : [{ item_id: 77, normalized_name: 'game', source_image_url: 'https://store.test/cover' }] };
      } };
      const manager = createLocalCoverWorkflowManager(database, {
        config: { workDir: root, s3Prefix: 'covers', publicBaseUrl: 'https://cdn.test' },
        downloadFile: async () => {}, openEditor: async () => {}, waitForFile: async () => edited,
        readImageFile: readFile,
        catalogImageHasher: { ...hasher, hashBytes: async (image) => { expect(image.toString()).toBe('edited bytes'); return HASH; } },
        uploadFile: async (_filename, _upload, image) => { uploaded = image; await writeFile(edited, 'later edit'); }
      });
      await manager.start(42); await manager.waitForIdle();
      const write = queries.find((query) => query.sql.includes('update items'))!;
      expect(write.params?.[0]).toMatch(/^https:\/\/cdn.test\/covers\/game\.es\.[a-f0-9]{12}\.webp$/);
      expect(write.params).toEqual([manager.getCurrent()?.public_url, 77, HASH]);
      expect(sqlText(write.sql)).toContain('image_phash_es = $3');
      expect(uploaded?.toString()).toBe('edited bytes');
      expect(manager.getCurrent()?.status).toBe('completed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])('synchronizes Node BGG image/hash on upsert (existing=%s)', async (existing) => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const database: Database = { query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.startsWith('select id, bgg_last')) return { rows: [] };
      if (sql.startsWith('select id from items')) return { rows: existing ? [{ id: 77 }] : [] };
      return { rows: [{ id: 77 }] };
    } };
    const thing: BggThingDetails = {
      bggId: 1, type: 'boardgame', name: 'Game', image: 'https://bgg.test/image', thumbnail: '',
      alternateNames: [], artists: [], categories: [], designers: [], families: [], mechanics: [], publishers: [], parentLinks: [], implementationLinks: [],
      description: '', yearPublished: null, rating: null, weight: null, minPlayers: null, maxPlayers: null, minPlaytime: null, maxPlaytime: null, playingTime: null, minAge: null
    };
    await createBggItemImporter(database, { fetchThing: async () => ({ details: thing, rawXml: '' }), search: async () => [] }, hasher).importBggId(1);
    const write = queries.find((query) => /(?:insert into|update) items/.test(query.sql))!;
    expect(sqlText(write.sql)).toContain('image_phash');
    expect(write.params).toContain(HASH);
  });
});
