import { CATALOG_IMAGE_HASH_METHOD, isCatalogImageHash, type CatalogImageHasher } from '../catalogImageHash.js';
import type { ImageSimilarityResult, ImageSimilarityService } from '../imageSimilarity/imageSimilarityService.js';
import { parseListingImageQueryHashes, type ListingImageQueryHashes, type ListingImageQueryHasher, type ListingImageQueryVariant } from '../listingImageQueryHash.js';
import { scoreLocalItem, type DiscoveryCandidateForMatch, type LocalItemForMatch } from './itemMatcher.js';

export const LOCAL_AUTO_MATCH_SCORE_THRESHOLD = 0.85;
export const LOCAL_IMAGE_MATCH_THRESHOLDS = {
  max_raw_hash_distance: 12,
  max_normalized_hash_distance: 40,
  min_hash_gap: 8,
  min_visual_score: 95,
  name_score_gap: 0.05
} as const;

export type CatalogItemForMatching = LocalItemForMatch & {
  imageUrl?: string | null; imageUrlEs?: string | null;
  imagePhash?: string | null; imagePhashEs?: string | null;
};
export type RankedLocalMatch = {
  item: CatalogItemForMatching; accepted: boolean; matchScore: number; matchReasons: string[];
  evidence: Record<string, unknown>;
};
type CoverMatch = {
  distance: number; radius: number; variant: ListingImageQueryVariant;
  field: 'image_url' | 'image_url_es'; url: string; hash: string;
};
type ComparedItem = { match: RankedLocalMatch; observed: CoverMatch | null; viable: CoverMatch | null };
type Verification = { status: 'not_run' | 'passed' | 'below_threshold' | 'error'; score: number | null; error?: string; result?: ImageSimilarityResult };

export async function rankLocalCatalogMatches(
  candidate: DiscoveryCandidateForMatch & { imageUrl?: string | null },
  nameItems: CatalogItemForMatching[],
  options: {
    catalogImageHasher?: CatalogImageHasher;
    listingImageQueryHasher?: ListingImageQueryHasher;
    imageSimilarityService?: ImageSimilarityService;
    findNearestItems(variants: ListingImageQueryVariant[]): Promise<CatalogItemForMatching[]>;
    trace(fields: Record<string, unknown>): void;
  }
): Promise<RankedLocalMatch[]> {
  const named = scoreItems(candidate, nameItems);
  const top = named[0];
  const group = top ? named.filter((match) => top.matchScore - match.matchScore <= LOCAL_IMAGE_MATCH_THRESHOLDS.name_score_gap + 1e-9) : [];
  const listingUrl = candidate.imageUrl?.trim() || null;
  if (top && top.matchScore >= LOCAL_AUTO_MATCH_SCORE_THRESHOLD && group.length === 1) {
    return finish(named.map((match) => ({ match, observed: null, viable: null })), top, {
      mode: 'name', outcome: 'unique_accepted_name', listing_url: listingUrl,
      listing_hash: null, query_variants: [], normalization: null, runner_up: null, hash_gap: null,
      thresholds: LOCAL_IMAGE_MATCH_THRESHOLDS, verification: { status: 'not_run', score: null }
    }, options.trace);
  }

  const mode = top && top.matchScore >= LOCAL_AUTO_MATCH_SCORE_THRESHOLD ? 'image_tiebreak' : 'image_fallback';
  let matches = named;
  let compared: ComparedItem[] = named.map((match) => ({ match, observed: null, viable: null }));
  let hashes: ListingImageQueryHashes | null = null;
  let outcome = 'missing_image';
  let imageError: string | null = null;
  let runner: ComparedItem | undefined;
  let gap: number | null = null;
  let selected: RankedLocalMatch | null = null;
  let verification: Verification = { status: 'not_run', score: null };
  if (listingUrl) {
    if ((!options.listingImageQueryHasher && !options.catalogImageHasher) || !options.imageSimilarityService) {
      outcome = 'image_adapters_unavailable';
    } else {
      try {
        if (options.listingImageQueryHasher) {
          const generated = await options.listingImageQueryHasher.hashUrl(listingUrl);
          // Validate all injected/runtime outputs too, and preserve bytes only in memory.
          hashes = { ...parseListingImageQueryHashes(JSON.stringify({ method: generated.method, variants: generated.variants, normalization: generated.normalization })), imageBytes: generated.imageBytes };
        } else {
          const hash = await options.catalogImageHasher!.hashUrl(listingUrl);
          if (!isCatalogImageHash(hash)) throw new Error('Invalid listing image hash');
          hashes = { method: CATALOG_IMAGE_HASH_METHOD, variants: [{ origin: 'raw', hash }], normalization: { method: 'box_silhouette_v1', status: 'no_faces' } };
        }
        outcome = 'nearest_query_failed';
        if (mode === 'image_fallback') {
          matches = scoreItems(candidate, [...nameItems, ...await options.findNearestItems(hashes.variants)]);
        }
        const eligibleIds = new Set((mode === 'image_tiebreak' ? group : matches).map((match) => match.item.id));
        compared = matches.map((match) => compareItem(match, eligibleIds.has(match.item.id) ? hashes!.variants : []));
        const comparable = compared.filter((entry) => entry.observed !== null);
        const viable = comparable.filter((entry) => entry.viable !== null).sort((left, right) => left.viable!.distance - right.viable!.distance || left.match.item.id - right.match.item.id);
        const nominee = viable[0] ?? [...comparable].sort(observedOrder)[0];
        runner = nominee ? [...comparable].filter((entry) => entry.match.item.id !== nominee.match.item.id).sort(observedOrder)[0] : undefined;
        const nominationDistance = nominee?.viable?.distance ?? nominee?.observed?.distance;
        gap = runner && nominationDistance !== undefined ? runner.observed!.distance - nominationDistance : null;
        if (!nominee) outcome = 'no_comparable_hashes';
        else if (!nominee.viable) outcome = 'outside_hash_radius';
        else if (gap !== null && gap < LOCAL_IMAGE_MATCH_THRESHOLDS.min_hash_gap) outcome = 'ambiguous_hash_gap';
        else {
          outcome = 'visual_verification_failed';
          try {
            const service = options.imageSimilarityService!;
            // Verify original catalog artwork against the original downloaded listing,
            // never against a flattened face, and reuse its exact download when supported.
            const result = hashes.imageBytes && service.estimateBytes
              ? await service.estimateBytes(nominee.viable.url, hashes.imageBytes)
              : await service.estimate(nominee.viable.url, listingUrl);
            if (result.method !== 'sift_homography_v1' || !Number.isFinite(result.score) || result.score < 0 || result.score > 100) throw new Error('Invalid visual verification result');
            if (result.score >= LOCAL_IMAGE_MATCH_THRESHOLDS.min_visual_score) {
              verification = { status: 'passed', score: result.score, result };
              selected = nominee.match;
              outcome = 'image_selected';
            } else {
              verification = { status: 'below_threshold', score: result.score, result };
              outcome = 'visual_score_below_threshold';
            }
          } catch (error) {
            imageError = errorMessage(error);
            verification = { status: 'error', score: null, error: imageError };
          }
        }
      } catch (error) {
        imageError = errorMessage(error);
        if (!hashes) outcome = 'listing_hash_failed';
      }
    }
  }
  return finish(compared, selected, {
    mode, outcome, method: CATALOG_IMAGE_HASH_METHOD, listing_url: listingUrl,
    listing_hash: hashes?.variants[0].hash ?? null, query_variants: hashes?.variants ?? [],
    normalization: hashes?.normalization ?? null,
    runner_up: runner ? { item_id: runner.match.item.id, distance: runner.observed!.distance, query_variant: runner.observed!.variant, applicable_radius: runner.observed!.radius } : null,
    hash_gap: gap, image_error: imageError, verification, thresholds: LOCAL_IMAGE_MATCH_THRESHOLDS,
    comparable_item_count: compared.filter((entry) => entry.observed).length,
    unknown_image_item_count: compared.filter((entry) => !entry.observed).length
  }, options.trace);
}

function scoreItems(candidate: DiscoveryCandidateForMatch, items: CatalogItemForMatching[]): RankedLocalMatch[] {
  const distinct = new Map(items.map((item) => [item.id, item]));
  return [...distinct.values()].map((item) => {
    const score = scoreLocalItem(candidate, item);
    return { item, ...score, accepted: false, evidence: {} };
  }).sort((left, right) => right.matchScore - left.matchScore || left.item.id - right.item.id);
}

function compareItem(match: RankedLocalMatch, variants: ListingImageQueryVariant[]): ComparedItem {
  const item = match.item;
  const pairs: CoverMatch[] = [];
  for (const cover of [
    { field: 'image_url' as const, url: item.imageUrl, hash: item.imagePhash },
    { field: 'image_url_es' as const, url: item.imageUrlEs, hash: item.imagePhashEs }
  ]) {
    if (!cover.url?.trim() || !isCatalogImageHash(cover.hash)) continue;
    for (const variant of variants) pairs.push({
      field: cover.field, url: cover.url.trim(), hash: cover.hash, variant,
      distance: hammingDistance(cover.hash, variant.hash),
      radius: variant.origin === 'raw' ? LOCAL_IMAGE_MATCH_THRESHOLDS.max_raw_hash_distance : LOCAL_IMAGE_MATCH_THRESHOLDS.max_normalized_hash_distance
    });
  }
  pairs.sort((left, right) => left.distance - right.distance);
  return { match, observed: pairs[0] ?? null, viable: pairs.find((pair) => pair.distance <= pair.radius) ?? null };
}

function finish(entries: ComparedItem[], selected: RankedLocalMatch | null, common: Record<string, unknown>, trace: (fields: Record<string, unknown>) => void): RankedLocalMatch[] {
  entries.sort((left, right) => Number(right.match === selected) - Number(left.match === selected) || observedOrder(left, right)
    || right.match.matchScore - left.match.matchScore || left.match.item.id - right.match.item.id);
  const result = entries.map((entry, index) => {
    const cover = entry.viable ?? entry.observed;
    entry.match.accepted = entry.match === selected;
    entry.match.evidence = {
      ...common, rank: index + 1, selected: entry.match.accepted, name_score: entry.match.matchScore,
      hash_distance: cover?.distance ?? null, hash_similarity: cover ? (256 - cover.distance) / 256 : null,
      best_observed_distance: entry.observed?.distance ?? null, applicable_radius: cover?.radius ?? null,
      cover_field: cover?.field ?? null, cover_url: cover?.url ?? null, cover_hash: cover?.hash ?? null,
      query_variant: cover?.variant ?? null
    };
    entry.match.matchReasons.push(`local selection mode: ${common.mode}`, `local selection outcome: ${common.outcome}`);
    if (cover) entry.match.matchReasons.push(`catalog cover ${cover.field}; query ${cover.variant.origin}; pHash distance ${cover.distance}/256; radius ${cover.radius}`);
    return entry.match;
  });
  trace({ ...common, selected_item_id: selected?.item.id ?? null, item_count: result.length });
  return result;
}

function observedOrder(left: ComparedItem, right: ComparedItem): number {
  return (left.observed?.distance ?? 257) - (right.observed?.distance ?? 257);
}
function hammingDistance(left: string, right: string): number {
  let different = BigInt(`0x${left}`) ^ BigInt(`0x${right}`), count = 0;
  while (different !== 0n) { different &= different - 1n; count++; }
  return count;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
