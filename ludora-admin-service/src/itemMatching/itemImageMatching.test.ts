import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db.js';
import type { CatalogImageHasher } from '../catalogImageHash.js';
import type { ImageSimilarityResult, ImageSimilarityService } from '../imageSimilarity/imageSimilarityService.js';
import { createItemMatchingService, type ItemMatchingDependencies } from './itemMatchingService.js';

const LISTING_IMAGE = 'https://store.test/listing.jpg';
const ZERO_HASH = '0'.repeat(64);
const titleWords = Array.from({ length: 20 }, (_, index) => `word${index + 1}`);
const title = titleWords.join(' ');

describe('local catalog image matching', () => {
  it('keeps a unique accepted name without downloading or verifying images', async () => {
    const fixture = setup({ nameRows: [item(11, 'Coffee Rush')], listingTitle: 'Coffee Rush' });
    await fixture.service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });
    expect(fixture.linked()?.slice(0, 5)).toEqual([11, 'LOCAL', null, 'Coffee Rush', 0.99]);
    expect(fixture.hasher.hashUrl).not.toHaveBeenCalled();
    expect(fixture.visual.estimate).not.toHaveBeenCalled();
  });

  it('finds an unrelated catalog title through its Spanish cover and retains its low name score', async () => {
    const fixture = setup({ nearestRows: [item(22, 'Different Catalog Title', { image_phash: null, image_phash_es: bits(12) })] });
    const generated = await fixture.service.generateMatchCandidates(42);
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ item_id: 22, source: 'LOCAL', match_score: 0 });
    expect(generated[0].raw_payload).toMatchObject({ local_match: {
      mode: 'image_fallback', selected: true, name_score: 0, hash_distance: 12,
      hash_similarity: 0.953125, cover_field: 'image_url_es', listing_hash: ZERO_HASH,
      verification: { status: 'passed', score: 95 },
      thresholds: { max_raw_hash_distance: 12, max_normalized_hash_distance: 40, min_hash_gap: 8, min_visual_score: 95, name_score_gap: 0.05 }
    } });
    expect(fixture.visual.estimate).toHaveBeenCalledWith('https://catalog.test/22.es.jpg', LISTING_IMAGE);
    expect(fixture.cacheLookup).not.toHaveBeenCalled();
    expect(fixture.hasher.hashUrl).toHaveBeenCalledTimes(1);
  });

  it('automatically links the slightly lower name candidate selected by its image', async () => {
    const fixture = closeNames();
    await fixture.service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });
    expect(fixture.linked()?.slice(0, 5)).toEqual([22, 'LOCAL', null, titleWords.slice(0, 18).concat(['other1', 'other2']).join(' '), 0.9]);
    expect(JSON.parse(String(fixture.linked()?.[6]))).toMatchObject({ local_match: { mode: 'image_tiebreak', selected: true } });
    expect(fixture.cacheLookup).not.toHaveBeenCalled();
  });

  it('uses the inclusive 0.05 name group and persists the same selected-first ordering', async () => {
    const fixture = closeNames();
    const generated = await fixture.service.generateMatchCandidates(42);
    const listed = await fixture.service.listMatchCandidates(42);
    expect(generated.map((row) => row.item_id)).toEqual([22, 11]);
    expect(listed.map((row) => row.item_id)).toEqual([22, 11]);
    expect(generated[0].raw_payload).toMatchObject({ candidate_rank: 1, local_match: { rank: 1, name_score: 0.9 } });
    expect(fixture.nearestQueries).toHaveLength(0);
  });

  it('collapses both covers of one item before measuring the distinct runner-up gap', async () => {
    const fixture = setup({ nearestRows: [
      item(22, 'Different Title', { image_phash: ZERO_HASH, image_phash_es: bits(1) }),
      item(33, 'Other Title', { image_phash: bits(20) })
    ] });
    const rows = await fixture.service.generateMatchCandidates(42);
    expect(rows.map((row) => row.item_id)).toEqual([22, 33]);
    expect(rows[0].raw_payload).toMatchObject({ local_match: { selected: true, runner_up: { item_id: 33, distance: 20 }, hash_gap: 20 } });
    expect(fixture.visual.estimate).toHaveBeenCalledTimes(1);
  });

  it.each([
    [12, 20, true], [13, 21, false], [11, 18, false], [11, 19, true], [11, 15, false]
  ])('applies radius and runner-up boundaries for best %i and runner %i', async (best, runner, selected) => {
    const fixture = setup({ nearestRows: [item(22, 'Different Title', { image_phash: bits(best) }), item(33, 'Other Title', { image_phash: bits(runner) })] });
    await fixture.service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });
    expect(fixture.linked()?.[0] ?? null).toBe(selected ? 22 : null);
    expect(fixture.visual.estimate).toHaveBeenCalledTimes(selected ? 1 : 0);
    expect(fixture.cacheLookup).toHaveBeenCalledTimes(selected ? 0 : 1);
  });

  it('does not choose between distinct catalog items with identical covers', async () => {
    const fixture = closeNames(ZERO_HASH, ZERO_HASH);
    await fixture.service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });
    expect(fixture.linked()).toBeUndefined();
    expect(fixture.cacheLookup).toHaveBeenCalledOnce();
    expect(fixture.visual.estimate).not.toHaveBeenCalled();
    expect(fixture.events).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ outcome: 'ambiguous_hash_gap' }) }));
  });

  it.each([94.99, 95])('requires the visual score boundary for score %s', async (score) => {
    const fixture = setup({ nearestRows: [item(22, 'Different Title', { image_phash: bits(12) })], visualScore: score });
    await fixture.service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });
    expect(fixture.linked()?.[0] ?? null).toBe(score === 95 ? 22 : null);
  });

  it.each(['missing_image', 'hash_failure', 'invalid_listing_hash', 'nearest_failure', 'visual_failure', 'missing_hashes', 'missing_adapters'] as const)(
    'continues downstream without setting processing_error when images are unavailable: %s', async (failure) => {
      const fixture = setup({ nearestRows: [item(22, 'Different Title', { image_phash: ZERO_HASH })], failure });
      await fixture.service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated', traceLogger: fixture.traceLogger });
      expect(fixture.linked()).toBeUndefined();
      expect(fixture.cacheLookup).toHaveBeenCalledOnce();
      expect(fixture.updates.some(({ sql }) => sql.includes('processing_error = $1'))).toBe(false);
      expect(fixture.events).toContainEqual(expect.objectContaining({ event: 'item_matcher.local_image.completed' }));
    }
  );

  it('ignores null/malformed catalog hashes and considers the remaining usable cover', async () => {
    const fixture = setup({ nearestRows: [
      item(11, 'Bad Cover', { image_phash: 'not-a-hash', image_phash_es: null }),
      item(22, 'Different Title', { image_phash: null, image_phash_es: bits(12) })
    ] });
    await fixture.service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });
    expect(fixture.linked()?.[0]).toBe(22);
  });

  it('retains unresolved image fallback candidates for review without auto-linking them', async () => {
    const fixture = setup({ nearestRows: [item(22, 'Different Title', { image_phash: bits(11) }), item(33, 'Other Title', { image_phash: bits(15) })] });
    const generated = await fixture.service.generateMatchCandidates(42);
    expect(generated.map((row) => row.item_id)).toEqual([22, 33]);
    expect(generated[0].raw_payload).toMatchObject({ local_match: { selected: false, outcome: 'ambiguous_hash_gap', hash_gap: 4 } });
    expect(fixture.linked()).toBeUndefined();
  });

  it('never expands image tie-breaking outside the strongest name group', async () => {
    const fixture = setup({ listingTitle: 'Coffee Rush', nameRows: [item(11, 'Coffee Rush'), item(22, 'Coffee Rush Other')], nearestRows: [item(33, 'Different Title', { image_phash: ZERO_HASH })] });
    await fixture.service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });
    expect(fixture.linked()?.[0]).toBe(11);
    expect(fixture.hasher.hashUrl).not.toHaveBeenCalled();
  });

  it.each([40, 41])('uses the normalized-only radius boundary for distance %i', async (distance) => {
    const fixture = setup({ nearestRows: [item(22, 'Different Title', { image_phash: bits(distance) })], variants: [raw(bits(120)), normalized(ZERO_HASH)] });
    await fixture.service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });
    expect(fixture.linked()?.[0] ?? null).toBe(distance === 40 ? 22 : null);
    expect(fixture.visual.estimate).toHaveBeenCalledTimes(distance === 40 ? 1 : 0);
    if (distance === 40) expect(JSON.parse(String(fixture.linked()?.[6]))).toMatchObject({ local_match: { query_variant: { origin: 'box_silhouette' }, applicable_radius: 40 } });
  });

  it('keeps viable normalized evidence when the same item has a closer but ineligible raw distance', async () => {
    const fixture = setup({ nearestRows: [item(22, 'Different Title', { image_phash: ZERO_HASH })], variants: [raw(bits(19)), normalized(bits(30))] });
    await fixture.service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });
    expect(fixture.linked()?.[0]).toBe(22);
    expect(JSON.parse(String(fixture.linked()?.[6]))).toMatchObject({ local_match: { hash_distance: 30, best_observed_distance: 19, query_variant: { origin: 'box_silhouette' } } });
  });

  it('does not hide a close competitor whose best raw variant is outside its radius', async () => {
    const fixture = setup({ nearestRows: [item(22, 'Different Title', { image_phash: ZERO_HASH }), item(33, 'Other Title', { image_phash: bits(1) })], variants: [raw(bits(19)), normalized(bits(30))] });
    await fixture.service.confirmBoardgameAndMatch?.(42, { confirmationSource: 'automated' });
    expect(fixture.linked()).toBeUndefined();
    expect(fixture.visual.estimate).not.toHaveBeenCalled();
    expect(fixture.cacheLookup).toHaveBeenCalledOnce();
  });

  it('uses raw output when automatic normalization returns no valid faces', async () => {
    const fixture = setup({ nearestRows: [item(22, 'Different Title', { image_phash: bits(12) })], variants: [raw(ZERO_HASH)] });
    const rows = await fixture.service.generateMatchCandidates(42);
    expect(rows[0]).toMatchObject({ item_id: 22, raw_payload: { local_match: { selected: true, applicable_radius: 12, query_variant: { origin: 'raw' } } } });
    expect(fixture.hasher.hashUrl).not.toHaveBeenCalled();
    expect(fixture.queryHasher?.hashUrl).toHaveBeenCalledTimes(1);
  });

  it('verifies the exact original listing buffer and never persists its bytes', async () => {
    const fixture = setup({ nearestRows: [item(22, 'Different Title', { image_phash: ZERO_HASH })], variants: [raw(ZERO_HASH)] });
    const original = Buffer.from('original encoded listing snapshot');
    fixture.queryHasher!.hashUrl = vi.fn(async () => ({ method: 'phash_dct256_v1', variants: [raw(ZERO_HASH)], normalization: { method: 'box_silhouette_v1', status: 'no_faces' }, imageBytes: original }));
    fixture.visual.estimateBytes = vi.fn(async () => ({ score: 95, method: 'sift_homography_v1', matched_region: null, diagnostics: {} } as ImageSimilarityResult));
    const rows = await fixture.service.generateMatchCandidates(42);
    expect(fixture.visual.estimateBytes).toHaveBeenCalledWith('https://catalog.test/22.jpg', original);
    expect(fixture.visual.estimate).not.toHaveBeenCalled();
    expect(JSON.stringify(rows[0].raw_payload)).not.toContain('imageBytes');
    expect(JSON.stringify(rows[0].raw_payload)).not.toContain('"type":"Buffer"');
  });

  it('lists persisted ranks ahead of legacy scores and safely ignores malformed legacy rank values', async () => {
    const rows = [
      { id: 11, source: 'LOCAL' as const, match_score: 0.99, raw_payload: { candidate_rank: '1' } },
      { id: 22, source: 'LOCAL' as const, match_score: 0.95, raw_payload: { candidate_rank: -1 } },
      { id: 33, source: 'LOCAL' as const, match_score: 0.92, raw_payload: { candidate_rank: 0.5 } },
      { id: 44, source: 'LOCAL' as const, match_score: 0.91, raw_payload: null },
      { id: 55, source: 'LOCAL' as const, match_score: 0.9, raw_payload: { candidate_rank: 2 } },
      { id: 66, source: 'LOCAL' as const, match_score: 0, raw_payload: { candidate_rank: 1 } }
    ];
    const service = createItemMatchingService({ query: async () => ({ rows }) }, {} as ItemMatchingDependencies);
    const listed = await service.listMatchCandidates(42);
    expect(listed.map((row) => row.id)).toEqual([66, 55, 11, 22, 33, 44]);
  });

  it('keeps unresolved local image ranks together before unaccepted BGG candidates', async () => {
    const fixture = setup({ listingTitle: 'Alpha Beta Gamma', nearestRows: [
      item(22, 'Different Title', { image_phash: bits(11) }),
      item(11, 'Alpha Beta', { image_phash: bits(15) }),
      item(33, 'Alpha Other Something Else More', { image_phash: bits(22) })
    ], cacheMatches: [{ item: { bggId: 777, name: 'Alpha Beta', type: 'boardgame' }, verifiedByAi: false }] });
    const generated = await fixture.service.generateMatchCandidates(42);
    const listed = await fixture.service.listMatchCandidates(42);
    expect(generated.map((row) => row.item_id)).toEqual([22, 11, 33, null]);
    expect(listed.map((row) => row.item_id)).toEqual([22, 11, 33, null]);
    expect(generated[3]).toMatchObject({ bgg_id: 777, source: 'BGG', match_score: 0.55 });
  });
});

function raw(hash: string) { return { origin: 'raw', hash }; }
function normalized(hash: string) { return { origin: 'box_silhouette', hash, face: { index: 1, type: 'two_faces', construction: 'two-face seam and larger-face selection', corners: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]], width: 100, height: 100 } }; }
function bits(count: number): string { return ((1n << BigInt(count)) - 1n).toString(16).padStart(64, '0'); }
function item(id: number, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, canonical_name: name, normalized_name: name.toLowerCase(), canonical_name_es: '', normalized_name_es: '', aliases: [], publishers: [], bgg_id: null, item_type: 'base_game', image_url: `https://catalog.test/${id}.jpg`, image_url_es: `https://catalog.test/${id}.es.jpg`, image_phash: null, image_phash_es: null, ...extra };
}
function closeNames(firstHash = bits(20), secondHash = ZERO_HASH) {
  return setup({ listingTitle: title, nameRows: [
    item(11, titleWords.slice(0, 19).concat('other1').join(' '), { image_phash: firstHash }),
    item(22, titleWords.slice(0, 18).concat(['other1', 'other2']).join(' '), { image_phash: secondHash })
  ] });
}
type Failure = 'missing_image' | 'hash_failure' | 'invalid_listing_hash' | 'nearest_failure' | 'visual_failure' | 'missing_hashes' | 'missing_adapters';
function setup(options: { nameRows?: Record<string, unknown>[]; nearestRows?: Record<string, unknown>[]; listingTitle?: string; visualScore?: number; failure?: Failure; variants?: unknown[]; cacheMatches?: unknown[] } = {}) {
  const updates: Array<{ sql: string; params?: unknown[] }> = [];
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const nearestQueries: string[] = [];
  const stored: Record<string, unknown>[] = [];
  const traceLogger = { log: (event: string, fields: Record<string, unknown> = {}) => events.push({ event, fields }) };
  const database: Database = { query: async (sql, params) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.includes('from store_items')) return { rows: [{ id: 42, title: options.listingTitle ?? 'Unrelated Listing', image_url: options.failure === 'missing_image' ? '' : LISTING_IMAGE, item_type: 'base_game', language: 'es' }] };
    if (normalized.startsWith('with local_names')) return { rows: options.nameRows ?? [] };
    if (normalized.startsWith('with catalog_image_covers')) {
      nearestQueries.push(sql);
      if (options.failure === 'nearest_failure') throw new Error('nearest query unavailable');
      return { rows: options.failure === 'missing_hashes' ? [] : options.nearestRows ?? [] };
    }
    if (normalized.startsWith('update store_items')) { updates.push({ sql, params }); return { rows: [] }; }
    if (normalized.startsWith('delete from item_match_candidates')) { stored.length = 0; return { rows: [] }; }
    if (normalized.startsWith('insert into item_match_candidates')) {
      const row = { id: stored.length + 1, item_id: params?.[2], bgg_id: params?.[3], source: params?.[1], match_score: params?.[5], match_reasons: JSON.parse(String(params?.[6])), raw_payload: JSON.parse(String(params?.[7])), status: 'PENDING' };
      stored.push(row); return { rows: [row] };
    }
    if (normalized.includes('from item_match_candidates')) {
      // Return ordinary SQL score order; the real service must restore persisted ranks.
      return { rows: [...stored].sort((left, right) => Number(right.match_score) - Number(left.match_score)) };
    }
    throw new Error(`Unexpected query: ${normalized}`);
  } };
  const hasher: CatalogImageHasher = { hashBytes: vi.fn(), hashUrl: vi.fn(async () => {
    if (options.failure === 'hash_failure') throw new Error('image decode failed');
    return options.failure === 'invalid_listing_hash' ? 'invalid' : ZERO_HASH;
  }) };
  const visual: ImageSimilarityService = { estimate: vi.fn(async () => {
    if (options.failure === 'visual_failure') throw new Error('SIFT timeout');
    return { score: options.visualScore ?? 95, method: 'sift_homography_v1', matched_region: null, diagnostics: {} } as ImageSimilarityResult;
  }) };
  const cacheLookup = vi.fn(async () => ({ cacheHit: false, matches: options.cacheMatches ?? [] }));
  const queryHasher = options.variants ? { hashUrl: vi.fn(async () => ({ method: 'phash_dct256_v1', variants: options.variants, normalization: { method: 'box_silhouette_v1', status: 'completed' } })) } : undefined;
  const dependencies = {
    autoListEvaluationService: { evaluateLinkedStoreItem: vi.fn(async () => ({ status: 'SKIPPED', reason: 'TRANSLATION_NOT_GENERATED' })) },
    bggMatchCache: { lookup: cacheLookup, recordAiMatch: vi.fn() },
    ...(options.failure === 'missing_adapters' ? {} : { catalogImageHasher: hasher, imageSimilarityService: visual }),
    ...(queryHasher ? { listingImageQueryHasher: queryHasher } : {})
  } as unknown as ItemMatchingDependencies;
  const rawService = createItemMatchingService(database, dependencies);
  const service = { ...rawService, confirmBoardgameAndMatch: (id: number, matchOptions: Record<string, unknown> = {}) => rawService.confirmBoardgameAndMatch?.(id, { traceLogger, ...matchOptions }) };
  return { service, hasher, queryHasher, visual, cacheLookup, updates, events, traceLogger, nearestQueries, linked: () => updates.find(({ sql }) => sql.includes('set item_id = $1'))?.params };
}
