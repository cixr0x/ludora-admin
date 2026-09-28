import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createNodeCatalogImageHasher, prepareCatalogImageHash } from './catalogImageHash.js';

describe('catalog image hash', () => {
  it('uses the canonical Python generator for exact image bytes', async () => {
    const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'black' } }).png().toBuffer();
    const hasher = createNodeCatalogImageHasher({
      packageDir: path.resolve('../ludora-discovery'), pythonExecutable: 'python',
      downloadImage: async () => image
    });
    expect(await hasher.hashBytes(image)).toBe('0'.repeat(64));
    expect(await hasher.hashUrl('https://example.test/image')).toBe('0'.repeat(64));
  });

  it('clears removed images and failed downloads without retaining a previous hash', async () => {
    const failures: string[] = [];
    const hasher = {
      hashBytes: async () => { throw new Error('decode failed'); },
      hashUrl: async () => { throw new Error('download failed'); }
    };
    expect(await prepareCatalogImageHash(hasher, '   ', (message) => failures.push(message))).toBeNull();
    expect(await prepareCatalogImageHash(hasher, 'https://example.test/new', (message) => failures.push(message))).toBeNull();
    expect(await prepareCatalogImageHash(hasher, Buffer.from('broken'), (message) => failures.push(message))).toBeNull();
    expect(failures).toEqual(['Catalog image hash failed: download failed', 'Catalog image hash failed: decode failed']);
  });
});
