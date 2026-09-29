import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { Database } from '../db.js';
import { createNodeCatalogImageHasher } from '../catalogImageHash.js';
import { createNodeListingImageQueryHasher } from '../listingImageQueryHash.js';
import { createImageSimilarityService, type ImageSimilarityResult } from './imageSimilarityService.js';

const sift: ImageSimilarityResult = {
  score: 98.62, method: 'sift_homography_v1', matched_region: null,
  diagnostics: { reference_dimensions: { width: 64, height: 64 }, candidate_dimensions: { width: 64, height: 64 },
    reference_keypoints: 100, candidate_keypoints: 100, tentative_matches: 80, inliers: 78, inlier_ratio: 0.975,
    reference_hull_coverage: 0.8, reference_grid_coverage: 0.8, median_reprojection_error: 0.1,
    projected_area_ratio: 1, homography_valid: true }
};
const raw = (hash: string) => ({ method: 'phash_dct256_v1', variants: [{ origin: 'raw', hash }],
  normalization: { method: 'box_silhouette_v1', status: 'no_faces' } });
const normalized = (hash: string) => ({ origin: 'box_silhouette', hash,
  face: { index: 1, type: 'two_faces', construction: 'front', corners: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]], width: 100, height: 100 } });

async function comparison() {
  const modulePath = './hashSimilarity.js';
  const module = await import(modulePath).catch(() => null);
  expect(module, 'pair hash comparison is not implemented').not.toBeNull();
  return module!.compareHashSimilarity;
}

describe('pair fingerprint comparison', () => {
  it.each([
    ['0'.repeat(64), 0, 100], ['f'.repeat(4) + '0'.repeat(60), 16, 93.75], ['f'.repeat(64), 256, 0]
  ])('reports hand-derived bit distance and 0-100 score', async (hash, distance, score) => {
    const compare = await comparison();
    expect(compare('0'.repeat(64), raw(hash as string))).toMatchObject({
      status: 'ready', method: 'phash_dct256_v1', distance, score, origin: 'raw', raw: { distance, score }
    });
  });

  it('shows the closest flattened variant while retaining the raw photo score', async () => {
    const compare = await comparison();
    const query = raw('f'.repeat(32) + '0'.repeat(32));
    query.variants.push(normalized('f'.repeat(9) + '0'.repeat(55)) as typeof query.variants[number]);
    expect(compare('0'.repeat(64), query)).toMatchObject({
      status: 'ready', score: 85.9375, distance: 36, origin: 'box_silhouette', raw: { score: 50, distance: 128 }, variant_count: 2
    });
  });

  it('keeps raw origin when raw is closer or tied', async () => {
    const compare = await comparison();
    const query = raw('0'.repeat(64));
    query.variants.push(normalized('0'.repeat(64)) as typeof query.variants[number]);
    expect(compare('0'.repeat(64), query)).toMatchObject({ origin: 'raw', score: 100, distance: 0 });
  });

  it.each(['BAD', '', '0'.repeat(63)])('rejects malformed reference or query hashes', async (hash) => {
    const compare = await comparison();
    expect(() => compare(hash, raw('0'.repeat(64)))).toThrow();
    expect(() => compare('0'.repeat(64), raw(hash))).toThrow();
  });
});

describe('opt-in pair review hashes', () => {
  function dependencies(overrides: Record<string, unknown> = {}) {
    const reference = Buffer.from('encoded reference'), candidate = Buffer.from('encoded candidate');
    const downloadImage = vi.fn(async (url: string) => url.endsWith('/reference') ? reference : candidate);
    const compareImages = vi.fn(async (left: Buffer, right: Buffer) => {
      expect(left).toBe(reference); expect(right).toBe(candidate); return sift;
    });
    const hashBytes = vi.fn(async (image: Buffer) => { expect(image).toBe(reference); return '0'.repeat(64); });
    const queryBytes = vi.fn(async (image: Buffer) => { expect(image).toBe(candidate); return raw('f'.repeat(4) + '0'.repeat(60)); });
    return { downloadImage, compareImages, catalogImageHasher: { hashBytes }, listingImageQueryHasher: { hashBytes: queryBytes, hashUrl: vi.fn() }, ...overrides };
  }

  it('reuses the exact two original downloads and preserves legacy default processing', async () => {
    const deps = dependencies();
    const service = createImageSimilarityService(deps as Parameters<typeof createImageSimilarityService>[0]);
    expect(await service.estimate('https://images.test/reference', 'https://images.test/candidate')).toEqual(sift);
    expect(deps.catalogImageHasher.hashBytes).not.toHaveBeenCalled();
    expect(deps.listingImageQueryHasher.hashBytes).not.toHaveBeenCalled();
    deps.downloadImage.mockClear();
    const result = await service.estimate('https://images.test/reference', 'https://images.test/candidate', { includeHashSimilarity: true });
    expect(result).toMatchObject({ ...sift, hash_similarity: { status: 'ready', score: 93.75, distance: 16, raw: { score: 93.75, distance: 16 } } });
    expect(deps.downloadImage.mock.calls.map(([url]) => url)).toEqual(['https://images.test/reference', 'https://images.test/candidate']);
    expect(deps.listingImageQueryHasher.hashUrl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('encoded');
  });

  it.each(['reference', 'query', 'malformed', 'missing'])('preserves SIFT with unavailable %s hashing', async (failure) => {
    const deps = dependencies();
    if (failure === 'reference') deps.catalogImageHasher.hashBytes.mockRejectedValue(new Error('reference decode failed'));
    if (failure === 'query') deps.listingImageQueryHasher.hashBytes.mockRejectedValue(new Error('normalizer failed'));
    if (failure === 'malformed') deps.catalogImageHasher.hashBytes.mockResolvedValue('BAD');
    if (failure === 'missing') delete (deps.listingImageQueryHasher as { hashBytes?: unknown }).hashBytes;
    const service = createImageSimilarityService(deps as Parameters<typeof createImageSimilarityService>[0]);
    const result = await service.estimate('https://images.test/reference', 'https://images.test/candidate', { includeHashSimilarity: true });
    expect(result).toMatchObject({ ...sift, hash_similarity: { status: 'unavailable', method: 'phash_dct256_v1' } });
    expect(result.hash_similarity).not.toHaveProperty('score');
  });

  it('returns opt-in evidence from the existing route without any database call', async () => {
    const database = { query: vi.fn(async () => { throw new Error('pair review must not query the database'); }) } as unknown as Database;
    const service = createImageSimilarityService(dependencies() as Parameters<typeof createImageSimilarityService>[0]);
    const response = await request(createApp({ database, imageSimilarityService: service }))
      .post('/admin/image-similarity').send({ reference_image_url: 'https://images.test/reference', candidate_image_url: 'https://images.test/candidate', include_hash_similarity: true });
    expect(response.status).toBe(200);
    expect(response.body.data.hash_similarity).toMatchObject({ status: 'ready', score: 93.75 });
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean opt-in rather than treating string false as enabled', async () => {
    const response = await request(createApp({ database: { query: vi.fn() } as unknown as Database, imageSimilarityService: createImageSimilarityService(dependencies() as Parameters<typeof createImageSimilarityService>[0]) }))
      .post('/admin/image-similarity').send({ reference_image_url: 'https://images.test/reference', candidate_image_url: 'https://images.test/candidate', include_hash_similarity: 'false' });
    expect(response.status).toBe(400);
  });

  it('bridges actual canonical/query adapters on encoded bytes without duplicate downloads', async () => {
    const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'black' } }).png().toBuffer();
    const downloadImage = vi.fn(async () => image);
    const options = { downloadImage, packageDir: path.resolve('../ludora-discovery'), pythonExecutable: 'python' };
    const service = createImageSimilarityService({ downloadImage, compareImages: async () => sift,
      catalogImageHasher: createNodeCatalogImageHasher(options), listingImageQueryHasher: createNodeListingImageQueryHasher(options)
    } as Parameters<typeof createImageSimilarityService>[0]);
    const result = await service.estimate('https://images.test/reference', 'https://images.test/candidate', { includeHashSimilarity: true });
    expect(result.hash_similarity).toMatchObject({ status: 'ready', method: 'phash_dct256_v1', score: 100, distance: 0, origin: 'raw', raw: { score: 100, distance: 0 }, variant_count: 1 });
    expect(downloadImage).toHaveBeenCalledTimes(2);
  });

  it('bounds reference decoding for review without changing the canonical algorithm', async () => {
    const oversized = await sharp({ create: { width: 4100, height: 4100, channels: 3, background: 'black' } }).png().toBuffer();
    const small = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'black' } }).png().toBuffer();
    const options = { downloadImage: async (url: string) => url.endsWith('/reference') ? oversized : small,
      packageDir: path.resolve('../ludora-discovery'), pythonExecutable: 'python', maxDecodePixels: 16_000_000 };
    const service = createImageSimilarityService({ downloadImage: options.downloadImage, compareImages: async () => sift,
      catalogImageHasher: createNodeCatalogImageHasher(options), listingImageQueryHasher: createNodeListingImageQueryHasher(options)
    } as Parameters<typeof createImageSimilarityService>[0]);
    const result = await service.estimate('https://images.test/reference', 'https://images.test/candidate', { includeHashSimilarity: true });
    expect(result).toMatchObject({ ...sift, hash_similarity: { status: 'unavailable' } });
  });
});
