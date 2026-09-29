import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createNodeCatalogImageHasher } from './catalogImageHash.js';
import { createNodeImageSimilarityDependencies } from './imageSimilarity/imageSimilarityService.js';

async function queryModule() {
  const modulePath = './listingImageQueryHash.js';
  const module = await import(modulePath).catch(() => null);
  expect(module, 'listing query adapter is not implemented').not.toBeNull();
  return module;
}

describe('listing image query hash adapter', () => {
  it('downloads once and preserves canonical raw hashing through the real Python CLI', async () => {
    const module = await queryModule();
    const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'black' } }).png().toBuffer();
    const downloadImage = vi.fn(async () => image);
    const options = { packageDir: path.resolve('../ludora-discovery'), pythonExecutable: 'python', downloadImage };
    const result = await module.createNodeListingImageQueryHasher(options).hashUrl('https://store.test/image');
    expect(result.method).toBe('phash_dct256_v1');
    expect(result.variants[0]).toEqual({ origin: 'raw', hash: '0'.repeat(64) });
    expect(result.imageBytes).toEqual(image);
    expect(downloadImage).toHaveBeenCalledTimes(1);
    expect(await createNodeCatalogImageHasher(options).hashBytes(image)).toBe(result.variants[0].hash);
  });

  it('rejects excess variants and invalid normalized geometry at the adapter boundary', async () => {
    const module = await queryModule();
    const raw = { origin: 'raw', hash: '0'.repeat(64) };
    const face = { origin: 'box_silhouette', hash: '1'.repeat(64), face: { index: 1, type: 'two_faces', construction: 'test', corners: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]], width: 100, height: 100 } };
    const valid = { method: 'phash_dct256_v1', variants: [raw, face], normalization: { method: 'box_silhouette_v1', status: 'completed' } };
    expect(module.parseListingImageQueryHashes(JSON.stringify(valid))).toMatchObject(valid);
    for (const invalid of [
      { ...valid, variants: [raw, face, face, face] },
      { ...valid, method: 'other_hash' },
      { ...valid, variants: [{ ...raw, hash: 'BAD' }] },
      { ...valid, variants: [raw, { ...face, face: { ...face.face, corners: [[-1, 0], [1, 0], [1, 1], [0, 1]] } }] },
      { ...valid, variants: [raw, { ...face, face: { ...face.face, width: 1201 } }] },
      { ...valid, variants: [raw, { ...face, face: { ...face.face, index: '1' } }] },
      { ...valid, variants: [raw, { ...face, face: { ...face.face, corners: [[0, 0], [1, 1], [0, 1], [1, 0]] } }] }
    ]) expect(() => module.parseListingImageQueryHashes(JSON.stringify(invalid))).toThrow();
  });
});

describe('bounded image subprocesses', () => {
  it('kills a stalled query-variant process after downloading only once', async () => {
    const module = await queryModule();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ludora-query-process-test-'));
    try {
      const moduleDir = path.join(directory, 'src', 'ludora');
      await mkdir(moduleDir, { recursive: true });
      await writeFile(path.join(moduleDir, '__init__.py'), '');
      await writeFile(path.join(moduleDir, 'listing_image_query_hash.py'), 'import sys, time\nsys.stdin.buffer.read()\ntime.sleep(2.5)\n');
      const downloadImage = vi.fn(async () => Buffer.from('encoded listing'));
      const hasher = module.createNodeListingImageQueryHasher({ packageDir: directory, pythonExecutable: 'python', downloadImage, processTimeoutMs: 250 });
      const started = Date.now();
      await expect(hasher.hashUrl('https://store.test/image')).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1800);
      expect(downloadImage).toHaveBeenCalledTimes(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('kills a stalled SIFT process and removes its temporary encoded images', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ludora-query-timeout-test-'));
    try {
      const moduleDir = path.join(directory, 'src', 'ludora');
      await mkdir(moduleDir, { recursive: true });
      await writeFile(path.join(moduleDir, '__init__.py'), '');
      await writeFile(path.join(moduleDir, 'image_similarity.py'), "from pathlib import Path\nimport sys, time\nPath('temporary-path.txt').write_text(str(Path(sys.argv[1]).parent))\ntime.sleep(2.5)\nprint('{}')\n");
      const dependencies = createNodeImageSimilarityDependencies({
        downloadImage: async () => Buffer.from('image'), packageDir: directory, pythonExecutable: 'python', processTimeoutMs: 250
      } as Parameters<typeof createNodeImageSimilarityDependencies>[0]);
      const started = Date.now();
      await expect(dependencies.compareImages(Buffer.from('reference'), Buffer.from('candidate'))).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1800);
      const temporaryPath = await readFile(path.join(directory, 'temporary-path.txt'), 'utf8');
      await expect(readFile(path.join(temporaryPath, 'reference.image'))).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
