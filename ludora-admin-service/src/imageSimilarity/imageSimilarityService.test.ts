import { describe, expect, it, vi } from 'vitest';

import {
  createImageSimilarityService,
  ImageSimilarityServiceError,
  type ImageSimilarityResult
} from './imageSimilarityService.js';

const result: ImageSimilarityResult = {
  score: 84.25,
  method: 'sift_homography_v1',
  matched_region: [
    { x: 0.1, y: 0.2 },
    { x: 0.7, y: 0.25 },
    { x: 0.65, y: 0.8 },
    { x: 0.15, y: 0.75 }
  ],
  diagnostics: {
    reference_dimensions: { width: 400, height: 500 },
    candidate_dimensions: { width: 1200, height: 900 },
    reference_keypoints: 200,
    candidate_keypoints: 600,
    tentative_matches: 50,
    inliers: 42,
    inlier_ratio: 0.84,
    reference_hull_coverage: 0.44,
    reference_grid_coverage: 0.75,
    median_reprojection_error: 0.8,
    projected_area_ratio: 0.12,
    homography_valid: true
  }
};

describe('image similarity service', () => {
  it('downloads both images and compares their bytes', async () => {
    const reference = Buffer.from('reference');
    const candidate = Buffer.from('candidate');
    const downloadImage = vi.fn(async (url: string) => (
      url.includes('reference') ? reference : candidate
    ));
    const compareImages = vi.fn(async () => result);
    const service = createImageSimilarityService({ compareImages, downloadImage });

    await expect(
      service.estimate('https://images.example/reference.jpg', 'https://images.example/candidate.jpg')
    ).resolves.toEqual(result);
    expect(downloadImage).toHaveBeenCalledTimes(2);
    expect(compareImages).toHaveBeenCalledWith(reference, candidate);
  });

  it('identifies which download failed', async () => {
    const service = createImageSimilarityService({
      compareImages: vi.fn(),
      downloadImage: vi.fn(async (url: string) => {
        if (url.includes('candidate')) {
          throw new Error('404 Not Found');
        }
        return Buffer.from('reference');
      })
    });

    await expect(
      service.estimate('https://images.example/reference.jpg', 'https://images.example/candidate.jpg')
    ).rejects.toEqual(
      new ImageSimilarityServiceError('Candidate image could not be downloaded: 404 Not Found', 422)
    );
  });

  it('turns image processing failures into an actionable service error', async () => {
    const service = createImageSimilarityService({
      compareImages: vi.fn(async () => {
        throw new Error('reference image has no descriptors');
      }),
      downloadImage: vi.fn(async () => Buffer.from('image'))
    });

    await expect(
      service.estimate('https://images.example/reference.jpg', 'https://images.example/candidate.jpg')
    ).rejects.toEqual(
      new ImageSimilarityServiceError(
        'Images could not be compared: reference image has no descriptors',
        422
      )
    );
  });
});
