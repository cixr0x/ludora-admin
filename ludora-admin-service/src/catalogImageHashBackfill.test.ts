import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { loadCatalogImageHashRows, prepareCatalogImageHashBackfill } from './catalogImageHashBackfill.js';

const HASH = 'abcd'.repeat(16);
const row = {
  id: '9007199254740993', image_url: "https://example.test/game's\\cover", image_url_es: '',
  image_phash: null, image_phash_es: null,
  updated_at: '2026-09-28 12:34:56.123456+00', row_version: '3481'
};

describe('catalog image hash SQL preparation', () => {
  it('runs the preparation CLI entirely offline and rejects an apply option', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ludora-hash-backfill-'));
    try {
      const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'black' } }).png().toBuffer();
      await writeFile(path.join(root, 'cover.png'), image);
      const input = path.join(root, 'snapshot.json');
      const output = path.join(root, 'prepared.sql');
      await writeFile(input, JSON.stringify([{ ...row, image_path: 'cover.png' }]));
      const run = promisify(execFile);
      const script = path.resolve('src/scripts/prepareCatalogImageHashes.ts');
      await run(process.execPath, ['--import', 'tsx', script, `--input=${input}`, `--output=${output}`], {
        env: { ...process.env, LUDORA_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/never_connect' }
      });
      expect(await readFile(output, 'utf8')).toContain(`SET image_phash = '${'0'.repeat(64)}'`);
      expect(JSON.parse(await readFile(`${output}.json`, 'utf8')).failures).toEqual([]);
      await expect(run(process.execPath, ['--import', 'tsx', script, '--apply', `--output=${output}`])).rejects.toThrow('no apply mode exists');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);

  it('emits exact guarded SQL without executing it, preserving large IDs and timestamp precision', async () => {
    const prepared = await prepareCatalogImageHashBackfill([row], { hashBytes: async () => HASH, hashUrl: async () => HASH });
    expect(prepared.failures).toEqual([]);
    expect(prepared.sql).toContain(`SET image_phash = '${HASH}', updated_at = now()`);
    expect(prepared.sql).toContain('WHERE id = 9007199254740993');
    expect(prepared.sql).toContain("image_url IS NOT DISTINCT FROM E'https://example.test/game''s\\\\cover'");
    expect(prepared.sql).toContain("image_phash IS NOT DISTINCT FROM NULL");
    expect(prepared.sql).toContain("updated_at IS NOT DISTINCT FROM E'2026-09-28 12:34:56.123456+00'::timestamptz");
    expect(prepared.sql).toContain("xmin::text = '3481'");
    expect(prepared.sql).toContain('image_url_es IS NOT DISTINCT FROM');
  });

  it('uses offline final-byte inputs and clears failed refreshed hashes', async () => {
    const hasher = { hashUrl: async () => { throw new Error('offline test must not download'); }, hashBytes: async (bytes: Buffer) => bytes.toString() === 'local image' ? HASH : Promise.reject(new Error('decode failed')) };
    const prepared = await prepareCatalogImageHashBackfill([
      { ...row, image_path: '/offline/cover', image_url_es: 'https://example.test/new', image_path_es: '/offline/broken', image_phash_es: 'ffff'.repeat(16) }
    ], hasher, { refresh: true, readImageFile: async (filename) => Buffer.from(filename.endsWith('broken') ? 'broken' : 'local image') });
    expect(prepared.sql).toContain(`SET image_phash = '${HASH}', image_phash_es = NULL, updated_at = now()`);
    expect(prepared.failures).toEqual([{ itemId: row.id, field: 'image_url_es', error: 'Catalog image hash failed: decode failed' }]);
  });

  it('loads only a read-only snapshot with full guarded metadata', async () => {
    const queries: string[] = [];
    const rows = await loadCatalogImageHashRows({ query: async (sql) => { queries.push(sql); return { rows: [row] }; } }, { limit: 5 });
    expect(rows).toEqual([row]);
    expect(queries).toHaveLength(1);
    expect(queries[0].trim().toLowerCase().startsWith('select')).toBe(true);
    expect(queries[0]).toContain('updated_at::text');
    expect(queries[0]).toContain('xmin::text');
  });

  it('rejects incomplete guards before hashing instead of generating an unsafe patch', async () => {
    await expect(prepareCatalogImageHashBackfill([{ ...row, updated_at: '' }], { hashBytes: async () => HASH, hashUrl: async () => HASH })).rejects.toThrow('updated_at');
    await expect(prepareCatalogImageHashBackfill([{ ...row, id: '1;DELETE FROM items' }], { hashBytes: async () => HASH, hashUrl: async () => HASH })).rejects.toThrow('id');
  });
});
