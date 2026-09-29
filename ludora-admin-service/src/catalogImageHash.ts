import { execFile } from 'node:child_process';
import path from 'node:path';

export const CATALOG_IMAGE_HASH_METHOD = 'phash_dct256_v1';

export type CatalogImageHasher = {
  hashBytes(image: Buffer): Promise<string>;
  hashUrl(url: string): Promise<string>;
};

export function createNodeCatalogImageHasher(options: {
  packageDir: string; pythonExecutable: string; downloadImage(url: string): Promise<Buffer>; maxDecodePixels?: number;
}): CatalogImageHasher {
  async function hashBytes(image: Buffer): Promise<string> {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(options.pythonExecutable, ['-m', 'ludora.image_phash'], {
        cwd: options.packageDir,
        env: { ...process.env, PYTHONPATH: path.join(options.packageDir, 'src'),
          ...(options.maxDecodePixels ? { OPENCV_IO_MAX_IMAGE_PIXELS: String(options.maxDecodePixels) } : {}) },
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 64 * 1024
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      });
      child.stdin?.on('error', () => { /* execFile reports process failure through its callback. */ });
      child.stdin?.end(image);
    });
    const result = JSON.parse(stdout) as { method?: unknown; hash?: unknown };
    if (result.method !== CATALOG_IMAGE_HASH_METHOD || !isCatalogImageHash(result.hash)) {
      throw new Error('Catalog image hash process returned an invalid result');
    }
    return result.hash;
  }
  return { hashBytes, hashUrl: async (url) => hashBytes(await options.downloadImage(url)) };
}

export async function prepareCatalogImageHash(
  hasher: CatalogImageHasher | undefined, source: Buffer | string,
  report: (message: string) => void = console.warn
): Promise<string | null> {
  if ((typeof source === 'string' && !source.trim()) || !hasher) return null;
  try {
    const hash = typeof source === 'string' ? await hasher.hashUrl(source) : await hasher.hashBytes(source);
    if (!isCatalogImageHash(hash)) throw new Error('Generator returned an invalid catalog image hash');
    return hash;
  } catch (error) {
    report(`Catalog image hash failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function isCatalogImageHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
