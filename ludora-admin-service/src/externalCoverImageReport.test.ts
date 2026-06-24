import { describe, expect, it } from 'vitest';

import { createExternalCoverImageReport } from './externalCoverImageReport.js';
import type { ExternalCoverImageOptimizerResult } from './externalCoverImageOptimizer.js';

describe('external cover image report', () => {
  it('formats optimized images with original and new names, sources, and sizes', () => {
    const result: ExternalCoverImageOptimizerResult = {
      failures: [],
      optimized: [
        {
          applied: false,
          field: 'image_url',
          itemId: 10,
          newName: '10-coffeerush.en.webp',
          optimizedSizeBytes: 80000,
          originalSizeBytes: 150000,
          publicUrl: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/10-coffeerush.en.webp',
          s3Key: 'boardgame/10-coffeerush.en.webp',
          sourceName: 'coffee.jpg',
          sourceUrl: 'https://cf.geekdo-images.com/coffee.jpg'
        }
      ],
      skipped: [],
      summary: {
        downloadedImages: 1,
        failedImages: 0,
        imageFields: 2,
        itemsScanned: 1,
        optimizedImages: 1,
        skippedBlank: 1,
        skippedManaged: 0,
        skippedWithinLimit: 0,
        updatedRows: 0,
        uploadedImages: 0
      }
    };

    expect(
      createExternalCoverImageReport(result, {
        applied: false,
        generatedAt: '2026-06-24T12:00:00.000Z'
      })
    ).toEqual({
      applied: false,
      failures: [],
      generated_at: '2026-06-24T12:00:00.000Z',
      optimized_images: [
        {
          applied: false,
          field: 'image_url',
          item_id: 10,
          image_name: 'coffee.jpg',
          new_name: '10-coffeerush.en.webp',
          new_size_bytes: 80000,
          new_source: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/10-coffeerush.en.webp',
          original_size_bytes: 150000,
          original_source: 'https://cf.geekdo-images.com/coffee.jpg',
          s3_key: 'boardgame/10-coffeerush.en.webp'
        }
      ],
      skipped: [],
      summary: result.summary
    });
  });
});
