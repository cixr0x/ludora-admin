import { CATALOG_IMAGE_HASH_METHOD } from '../catalogImageHash.js';
import { imageHashDistance } from '../imageHashDistance.js';
import { parseListingImageQueryHashes, type ListingImageQueryHashes } from '../listingImageQueryHash.js';

export type HashSimilarityResult = {
  status: 'ready'; method: typeof CATALOG_IMAGE_HASH_METHOD;
  score: number; distance: number; origin: 'raw' | 'box_silhouette';
  raw: { score: number; distance: number }; variant_count: number;
  normalization_status: 'completed' | 'no_faces' | 'error';
} | { status: 'unavailable'; method: typeof CATALOG_IMAGE_HASH_METHOD; error: string };

export function compareHashSimilarity(referenceHash: string, query: ListingImageQueryHashes): HashSimilarityResult {
  // Select only public query fields: encoded bytes remain in memory, outside JSON.
  const validated = parseListingImageQueryHashes(JSON.stringify({ method: query.method, variants: query.variants, normalization: query.normalization }));
  const pairs = validated.variants.map((variant) => ({ origin: variant.origin, distance: imageHashDistance(referenceHash, variant.hash) }));
  const raw = pairs[0];
  const best = pairs.reduce((closest, pair) => pair.distance < closest.distance ? pair : closest);
  const score = (distance: number) => 100 * (256 - distance) / 256;
  return { status: 'ready', method: CATALOG_IMAGE_HASH_METHOD, score: score(best.distance), distance: best.distance,
    origin: best.origin, raw: { score: score(raw.distance), distance: raw.distance }, variant_count: pairs.length,
    normalization_status: validated.normalization.status };
}
