import { describe, expect, it } from 'vitest';

import type { Database } from './db.js';
import {
  optimizeExternalCoverImages,
  type ExternalCoverImageOptimizerDependencies,
  type RemoteImageInspection
} from './externalCoverImageOptimizer.js';

describe('external cover image optimizer', () => {
  it('dry-runs oversized external item cover fields without uploading or updating rows', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return {
          rows: [
            {
              canonical_name: 'Coffee Rush',
              canonical_name_es: '',
              id: 10,
              image_url: 'https://cf.geekdo-images.com/coffee.jpg',
              image_url_es: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/coffeerush.es.webp',
              normalized_name: 'coffee rush',
              normalized_name_es: ''
            },
            {
              canonical_name: 'Fiesta de los Muertos',
              canonical_name_es: '',
              id: 11,
              image_url: '',
              image_url_es: 'https://cf.geekdo-images.com/fiesta.png',
              normalized_name: 'fiesta de los muertos',
              normalized_name_es: ''
            },
            {
              canonical_name: 'Small Image',
              canonical_name_es: '',
              id: 12,
              image_url: 'https://cdn.example/small.jpg',
              image_url_es: '',
              normalized_name: 'small image',
              normalized_name_es: ''
            }
          ]
        };
      }
    };
    const calls: string[] = [];
    const dependencies = fakeDependencies({
      downloadImage: async (url) => {
        calls.push(`download:${url}`);
        const inspection = inspectionByUrl(url);
        return Buffer.alloc(inspection.contentLength ?? 1);
      },
      inspectImage: async (url) => {
        calls.push(`inspect:${url}`);
        return inspectionByUrl(url);
      },
      optimizeImage: async (image, options) => {
        calls.push(`optimize:${image.length}:${options.maxBytes}`);
        return Buffer.alloc(80000);
      },
      uploadImage: async () => {
        throw new Error('dry-run should not upload images');
      }
    });

    const result = await optimizeExternalCoverImages(database, dependencies, {
      apply: false,
      maxBytes: 100 * 1024
    });

    expect(normalizeSql(queries[0]?.sql ?? '')).toContain('from items');
    expect(normalizeSql(queries[0]?.sql ?? '')).toContain('image_url_es');
    expect(calls).toEqual([
      'inspect:https://cf.geekdo-images.com/coffee.jpg',
      'download:https://cf.geekdo-images.com/coffee.jpg',
      'optimize:150000:102400',
      'inspect:https://cf.geekdo-images.com/fiesta.png',
      'download:https://cf.geekdo-images.com/fiesta.png',
      'optimize:180000:102400',
      'inspect:https://cdn.example/small.jpg'
    ]);
    expect(result.summary).toEqual({
      downloadedImages: 2,
      failedImages: 0,
      imageFields: 6,
      itemsScanned: 3,
      optimizedImages: 2,
      skippedBlank: 2,
      skippedManaged: 1,
      skippedWithinLimit: 1,
      updatedRows: 0,
      uploadedImages: 0
    });
    expect(result.optimized.map((image) => `${image.itemId}:${image.field}:${image.publicUrl}:${image.applied}`)).toEqual([
      '10:image_url:https://ludora.s3.us-east-2.amazonaws.com/boardgame/10-coffeerush.en.webp:false',
      '11:image_url_es:https://ludora.s3.us-east-2.amazonaws.com/boardgame/11-fiestadelosmuertos.es.webp:false'
    ]);
    expect(result.optimized[0]).toMatchObject({
      newName: '10-coffeerush.en.webp',
      sourceName: 'coffee.jpg'
    });
  });

  it('uploads and updates only oversized external image fields when apply is enabled', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).startsWith('select')) {
          return {
            rows: [
              {
                canonical_name: 'Coffee Rush',
                canonical_name_es: '',
                id: 10,
                image_url: 'https://cf.geekdo-images.com/coffee.jpg',
                image_url_es: '',
                normalized_name: 'coffee rush',
                normalized_name_es: ''
              }
            ]
          };
        }
        return { rows: [{ id: 10 }] };
      }
    };
    const calls: string[] = [];
    const dependencies = fakeDependencies({
      downloadImage: async (url) => {
        calls.push(`download:${url}`);
        return Buffer.alloc(150000);
      },
      inspectImage: async () => ({ contentLength: 150000, contentType: 'image/jpeg' }),
      optimizeImage: async (image, options) => {
        calls.push(`optimize:${image.length}:${options.maxBytes}`);
        return Buffer.alloc(80000);
      },
      uploadImage: async (image, upload) => {
        calls.push(`upload:${image.length}:${upload.bucket}:${upload.key}:${upload.contentType}:${upload.cacheControl}`);
      }
    });

    const result = await optimizeExternalCoverImages(database, dependencies, {
      apply: true,
      maxBytes: 100 * 1024
    });

    expect(calls).toEqual([
      'download:https://cf.geekdo-images.com/coffee.jpg',
      'optimize:150000:102400',
      'upload:80000:ludora:boardgame/10-coffeerush.en.webp:image/webp:public, max-age=31536000, immutable'
    ]);
    const update = queries.find((query) => normalizeSql(query.sql).startsWith('update items'));
    expect(normalizeSql(update?.sql ?? '')).toContain('set image_url = $1');
    expect(normalizeSql(update?.sql ?? '')).toContain('updated_at = now()');
    expect(update?.params).toEqual(['https://ludora.s3.us-east-2.amazonaws.com/boardgame/10-coffeerush.en.webp', 10]);
    expect(result.summary.updatedRows).toBe(1);
    expect(result.optimized[0]).toMatchObject({
      applied: true,
      field: 'image_url',
      itemId: 10,
      optimizedSizeBytes: 80000,
      originalSizeBytes: 150000,
      newName: '10-coffeerush.en.webp',
      s3Key: 'boardgame/10-coffeerush.en.webp'
    });
  });
});

function fakeDependencies(
  overrides: Partial<ExternalCoverImageOptimizerDependencies> = {}
): ExternalCoverImageOptimizerDependencies {
  return {
    config: {
      publicBaseUrl: 'https://ludora.s3.us-east-2.amazonaws.com',
      s3Bucket: 'ludora',
      s3Prefix: 'boardgame',
      s3Region: 'us-east-2',
      workDir: 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame'
    },
    downloadImage: async (url) => {
      const inspection = inspectionByUrl(url);
      return Buffer.alloc(inspection.contentLength ?? 1);
    },
    inspectImage: async (url) => inspectionByUrl(url),
    optimizeImage: async (image, options) => Buffer.alloc(Math.min(image.length, options.maxBytes - 22400)),
    uploadImage: async () => undefined,
    ...overrides
  };
}

function inspectionByUrl(url: string): RemoteImageInspection {
  if (url.includes('coffee')) {
    return { contentLength: 150000, contentType: 'image/jpeg' };
  }
  if (url.includes('fiesta')) {
    return { contentLength: 180000, contentType: 'image/png' };
  }
  return { contentLength: 90000, contentType: 'image/jpeg' };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
