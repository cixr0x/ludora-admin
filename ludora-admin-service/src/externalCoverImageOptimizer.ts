import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';

import type { Database } from './db.js';
import { normalizeCoverFilename, type LocalCoverWorkflowConfig } from './localCoverWorkflow.js';

export type CoverImageField = 'image_url' | 'image_url_es';

export type RemoteImageInspection = {
  contentLength: number | null;
  contentType: string | null;
};

export type CoverImageOptimizationUpload = {
  bucket: string;
  cacheControl: string;
  contentType: string;
  key: string;
};

export type CoverImageOptimizeOptions = {
  maxBytes: number;
  maxDimension: number;
};

export type ExternalCoverImageOptimizerDependencies = {
  config: LocalCoverWorkflowConfig;
  downloadImage(url: string): Promise<Buffer>;
  inspectImage(url: string): Promise<RemoteImageInspection>;
  optimizeImage(image: Buffer, options: CoverImageOptimizeOptions): Promise<Buffer>;
  uploadImage(image: Buffer, upload: CoverImageOptimizationUpload): Promise<void>;
};

export type ExternalCoverImageOptimizerOptions = {
  apply?: boolean;
  limit?: number;
  maxBytes?: number;
  maxDimension?: number;
  offset?: number;
};

export type OptimizedCoverImage = {
  applied: boolean;
  field: CoverImageField;
  itemId: number;
  newName: string;
  optimizedSizeBytes: number;
  originalSizeBytes: number | null;
  publicUrl: string;
  s3Key: string;
  sourceName: string;
  sourceUrl: string;
};

export type SkippedCoverImage = {
  field: CoverImageField;
  itemId: number;
  reason: 'blank' | 'managed' | 'within_limit';
  sizeBytes?: number | null;
  sourceUrl?: string;
};

export type FailedCoverImage = {
  error: string;
  field: CoverImageField;
  itemId: number;
  sourceUrl: string;
};

export type ExternalCoverImageOptimizerResult = {
  failures: FailedCoverImage[];
  optimized: OptimizedCoverImage[];
  skipped: SkippedCoverImage[];
  summary: {
    downloadedImages: number;
    failedImages: number;
    imageFields: number;
    itemsScanned: number;
    optimizedImages: number;
    skippedBlank: number;
    skippedManaged: number;
    skippedWithinLimit: number;
    updatedRows: number;
    uploadedImages: number;
  };
};

type ItemCoverImageRow = {
  canonical_name?: string | null;
  canonical_name_es?: string | null;
  id: number | string;
  image_url?: string | null;
  image_url_es?: string | null;
  normalized_name?: string | null;
  normalized_name_es?: string | null;
};

const DEFAULT_MAX_BYTES = 100 * 1024;
const DEFAULT_MAX_DIMENSION = 800;
const DEFAULT_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const DEFAULT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export async function optimizeExternalCoverImages(
  database: Database,
  dependencies: ExternalCoverImageOptimizerDependencies,
  options: ExternalCoverImageOptimizerOptions = {}
): Promise<ExternalCoverImageOptimizerResult> {
  const apply = options.apply === true;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const items = await loadItemCoverImages(database, dependencies.config.publicBaseUrl, options.limit, options.offset);
  const skipped: SkippedCoverImage[] = [];
  const optimized: OptimizedCoverImage[] = [];
  const failures: FailedCoverImage[] = [];
  let downloadedImages = 0;
  let uploadedImages = 0;
  let updatedRows = 0;

  for (const item of items) {
    const itemId = numberOrNull(item.id);
    if (itemId === null) {
      continue;
    }

    for (const field of ['image_url', 'image_url_es'] as const) {
      const sourceUrl = stringValue(item[field]);
      if (!sourceUrl) {
        skipped.push({ field, itemId, reason: 'blank' });
        continue;
      }
      if (isManagedImageUrl(sourceUrl, dependencies.config.publicBaseUrl)) {
        skipped.push({ field, itemId, reason: 'managed', sourceUrl });
        continue;
      }

      try {
        const inspection = await dependencies.inspectImage(sourceUrl);
        if (inspection.contentLength !== null && inspection.contentLength <= maxBytes) {
          skipped.push({ field, itemId, reason: 'within_limit', sizeBytes: inspection.contentLength, sourceUrl });
          continue;
        }

        const originalImage = await dependencies.downloadImage(sourceUrl);
        downloadedImages += 1;
        const optimizedImage = await dependencies.optimizeImage(originalImage, {
          maxBytes,
          maxDimension
        });
        const s3Key = coverImageS3Key(dependencies.config.s3Prefix, item, itemId, field);
        const publicUrl = publicUrlFor(dependencies.config.publicBaseUrl, s3Key);

        if (apply) {
          await dependencies.uploadImage(optimizedImage, {
            bucket: dependencies.config.s3Bucket,
            cacheControl: DEFAULT_CACHE_CONTROL,
            contentType: 'image/webp',
            key: s3Key
          });
          uploadedImages += 1;
          await updateItemImageUrl(database, itemId, field, publicUrl);
          updatedRows += 1;
        }

        optimized.push({
          applied: apply,
          field,
          itemId,
          newName: filenameFromPath(s3Key),
          optimizedSizeBytes: optimizedImage.length,
          originalSizeBytes: inspection.contentLength ?? originalImage.length,
          publicUrl,
          s3Key,
          sourceName: filenameFromUrl(sourceUrl),
          sourceUrl
        });
      } catch (error) {
        failures.push({
          error: error instanceof Error ? error.message : String(error),
          field,
          itemId,
          sourceUrl
        });
      }
    }
  }

  return {
    failures,
    optimized,
    skipped,
    summary: {
      downloadedImages,
      failedImages: failures.length,
      imageFields: items.length * 2,
      itemsScanned: items.length,
      optimizedImages: optimized.length,
      skippedBlank: skipped.filter((image) => image.reason === 'blank').length,
      skippedManaged: skipped.filter((image) => image.reason === 'managed').length,
      skippedWithinLimit: skipped.filter((image) => image.reason === 'within_limit').length,
      updatedRows,
      uploadedImages
    }
  };
}

export function createNodeExternalCoverImageOptimizerDependencies(
  config: LocalCoverWorkflowConfig
): ExternalCoverImageOptimizerDependencies {
  const s3Client = new S3Client({ region: config.s3Region });
  return {
    config,
    downloadImage: downloadImageWithLimit,
    inspectImage: inspectImage,
    optimizeImage: optimizeImageToWebp,
    uploadImage: async (image, upload) => {
      await s3Client.send(
        new PutObjectCommand({
          Body: image,
          Bucket: upload.bucket,
          CacheControl: upload.cacheControl,
          ContentType: upload.contentType,
          Key: upload.key
        })
      );
    }
  };
}

async function loadItemCoverImages(
  database: Database,
  publicBaseUrl: string,
  limit?: number,
  offset?: number
): Promise<ItemCoverImageRow[]> {
  const managedUrlPattern = `${publicBaseUrl.replace(/\/+$/, '')}/%`;
  const params: unknown[] = [managedUrlPattern];
  const limitSql = limit !== undefined ? `limit $${params.push(limit)}` : '';
  const offsetSql = offset !== undefined ? `offset $${params.push(offset)}` : '';
  const result = await database.query(
    `
    select id, canonical_name, normalized_name, canonical_name_es, normalized_name_es, image_url, image_url_es
    from items
    where (
        coalesce(image_url, '') <> ''
        and image_url not like $1
      )
       or (
        coalesce(image_url_es, '') <> ''
        and image_url_es not like $1
      )
    order by id asc
    ${limitSql}
    ${offsetSql}
    `,
    params.length > 0 ? params : undefined
  );
  return result.rows as ItemCoverImageRow[];
}

function coverImageS3Key(prefix: string, item: ItemCoverImageRow, itemId: number, field: CoverImageField): string {
  const baseFilename = normalizeCoverFilename(item).replace(/\.webp$/i, '');
  const suffix = field === 'image_url' ? 'en' : 'es';
  return keyFor(prefix, `${itemId}-${baseFilename}.${suffix}.webp`);
}

async function updateItemImageUrl(database: Database, itemId: number, field: CoverImageField, publicUrl: string): Promise<void> {
  const column = field === 'image_url' ? 'image_url' : 'image_url_es';
  await database.query(
    `
    update items
    set ${column} = $1,
        updated_at = now()
    where id = $2
    returning id
    `,
    [publicUrl, itemId]
  );
}

async function inspectImage(url: string): Promise<RemoteImageInspection> {
  const response = await fetch(url, {
    headers: userAgentHeaders(),
    method: 'HEAD'
  });

  if (!response.ok) {
    return { contentLength: null, contentType: response.headers.get('content-type') };
  }

  return {
    contentLength: numberOrNull(response.headers.get('content-length')),
    contentType: response.headers.get('content-type')
  };
}

async function downloadImageWithLimit(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: userAgentHeaders()
  });
  if (!response.ok) {
    throw new Error(`Could not download image: ${response.status} ${response.statusText}`);
  }

  const contentLength = numberOrNull(response.headers.get('content-length'));
  if (contentLength !== null && contentLength > DEFAULT_MAX_DOWNLOAD_BYTES) {
    throw new Error(`Image is too large to download safely: ${contentLength} bytes`);
  }
  if (!response.body) {
    return Buffer.from(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks);
    }
    const chunk = Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > DEFAULT_MAX_DOWNLOAD_BYTES) {
      throw new Error(`Image exceeded safe download limit: ${totalBytes} bytes`);
    }
    chunks.push(chunk);
  }
}

async function optimizeImageToWebp(image: Buffer, options: CoverImageOptimizeOptions): Promise<Buffer> {
  const dimensions = [...new Set([options.maxDimension, 700, 600, 500, 400, 320, 256, 192, 128])]
    .filter((dimension) => dimension > 0)
    .sort((left, right) => right - left);
  for (const maxDimension of dimensions) {
    for (const quality of [82, 76, 70, 64, 58, 52, 46, 40, 34, 28, 22]) {
      const output = Buffer.from(
        await sharp(image, { failOn: 'none' })
          .rotate()
          .resize({
            fit: 'inside',
            height: maxDimension,
            withoutEnlargement: true,
            width: maxDimension
          })
          .webp({ quality })
          .toBuffer()
      );
      if (output.length < options.maxBytes) {
        return output;
      }
    }
  }
  throw new Error(`Image could not be reduced below ${options.maxBytes} bytes`);
}

function isManagedImageUrl(url: string, publicBaseUrl: string): boolean {
  const normalizedUrl = url.trim().replace(/\/+$/, '');
  const normalizedBaseUrl = publicBaseUrl.trim().replace(/\/+$/, '');
  return normalizedUrl === normalizedBaseUrl || normalizedUrl.startsWith(`${normalizedBaseUrl}/`);
}

function publicUrlFor(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function filenameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const filename = filenameFromPath(pathname);
    return filename ? decodeURIComponent(filename) : 'external-image';
  } catch {
    return 'external-image';
  }
}

function keyFor(prefix: string, filename: string): string {
  const cleanPrefix = prefix.trim().replace(/^\/+|\/+$/g, '');
  return cleanPrefix ? `${cleanPrefix}/${filename}` : filename;
}

function userAgentHeaders(): Record<string, string> {
  return {
    'User-Agent': 'LudoraExternalCoverImageOptimizer/1.0'
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
