import { execFile } from 'node:child_process';
import path from 'node:path';
import { CATALOG_IMAGE_HASH_METHOD, isCatalogImageHash } from './catalogImageHash.js';

export type ListingImageQueryVariant = {
  origin: 'raw' | 'box_silhouette'; hash: string;
  face?: { index: number; type: 'two_faces' | 'three_faces'; construction: string;
    corners: number[][]; width: number; height: number; geometry?: unknown };
};
export type ListingImageQueryHashes = {
  method: typeof CATALOG_IMAGE_HASH_METHOD;
  variants: ListingImageQueryVariant[];
  normalization: { method: 'box_silhouette_v1'; status: 'completed' | 'no_faces' | 'error'; [key: string]: unknown };
  // This buffer remains in memory for one attempt; never persist it in JSON.
  imageBytes?: Buffer;
};
export type ListingImageQueryHasher = { hashUrl(url: string): Promise<ListingImageQueryHashes> };

export function createNodeListingImageQueryHasher(options: {
  packageDir: string; pythonExecutable: string; downloadImage(url: string): Promise<Buffer>; processTimeoutMs?: number;
}): ListingImageQueryHasher {
  return {
    async hashUrl(url) {
      const imageBytes = await options.downloadImage(url);
      if (!imageBytes.length || imageBytes.length > 25 * 1024 * 1024) throw new Error('Listing image is empty or exceeds 25 MB');
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(options.pythonExecutable, ['-m', 'ludora.listing_image_query_hash'], {
          cwd: options.packageDir,
          env: { ...process.env, PYTHONPATH: path.join(options.packageDir, 'src'), OPENCV_IO_MAX_IMAGE_PIXELS: '16000000' },
          windowsHide: true, timeout: options.processTimeoutMs ?? 30_000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024
        }, (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || error.message)); else resolve(stdout);
        });
        child.stdin?.on('error', () => { /* execFile's callback reports process failure. */ });
        child.stdin?.end(imageBytes);
      });
      return { ...parseListingImageQueryHashes(stdout), imageBytes };
    }
  };
}

export function parseListingImageQueryHashes(stdout: string): ListingImageQueryHashes {
  const result: unknown = JSON.parse(stdout);
  if (!isRecord(result) || result.method !== CATALOG_IMAGE_HASH_METHOD || !Array.isArray(result.variants)
    || result.variants.length < 1 || result.variants.length > 3 || !isRecord(result.normalization)
    || result.normalization.method !== 'box_silhouette_v1'
    || !['completed', 'no_faces', 'error'].includes(String(result.normalization.status))) {
    throw new Error('Listing image query process returned an invalid result');
  }
  result.variants.forEach((variant, index) => {
    if (!isRecord(variant) || !isCatalogImageHash(variant.hash) || variant.origin !== (index === 0 ? 'raw' : 'box_silhouette')) {
      throw new Error('Listing image query process returned an invalid variant');
    }
    if (index > 0 && !validFace(variant.face)) throw new Error('Listing image query process returned invalid face geometry');
  });
  return result as unknown as ListingImageQueryHashes;
}

function validFace(value: unknown): boolean {
  if (!isRecord(value) || typeof value.index !== 'number' || ![1, 2].includes(value.index) || !['two_faces', 'three_faces'].includes(String(value.type))
    || typeof value.construction !== 'string' || !value.construction.trim()
    || ![value.width, value.height].every((size) => Number.isInteger(size) && Number(size) >= 2 && Number(size) <= 1200)
    || !Array.isArray(value.corners) || value.corners.length !== 4) return false;
  const points: number[][] = value.corners;
  if (!points.every((point) => Array.isArray(point) && point.length === 2 && point.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1))) return false;
  const signs = points.map((point, index) => {
    const next = points[(index + 1) % 4], following = points[(index + 2) % 4];
    return (next[0] - point[0]) * (following[1] - next[1]) - (next[1] - point[1]) * (following[0] - next[0]);
  });
  const area = Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % 4]; return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
  return area >= 0.01 && (signs.every((sign) => sign > 0) || signs.every((sign) => sign < 0));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
