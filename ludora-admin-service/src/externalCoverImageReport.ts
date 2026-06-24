import type { ExternalCoverImageOptimizerResult } from './externalCoverImageOptimizer.js';

export type ExternalCoverImageReportOptions = {
  applied: boolean;
  generatedAt?: string;
};

export function createExternalCoverImageReport(
  result: ExternalCoverImageOptimizerResult,
  options: ExternalCoverImageReportOptions
) {
  return {
    applied: options.applied,
    failures: result.failures,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    optimized_images: result.optimized.map((image) => ({
      applied: image.applied,
      field: image.field,
      item_id: image.itemId,
      image_name: image.sourceName,
      new_name: image.newName,
      new_size_bytes: image.optimizedSizeBytes,
      new_source: image.publicUrl,
      original_size_bytes: image.originalSizeBytes,
      original_source: image.sourceUrl,
      s3_key: image.s3Key
    })),
    skipped: result.skipped,
    summary: result.summary
  };
}
