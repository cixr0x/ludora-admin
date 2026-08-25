import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import type { Database } from '../db.js';
import {
  ImageSimilarityServiceError,
  type ImageSimilarityResult,
  type ImageSimilarityService
} from '../imageSimilarity/imageSimilarityService.js';

const result: ImageSimilarityResult = {
  score: 78.4,
  method: 'sift_homography_v1',
  matched_region: null,
  diagnostics: {
    reference_dimensions: { width: 400, height: 500 },
    candidate_dimensions: { width: 1200, height: 900 },
    reference_keypoints: 120,
    candidate_keypoints: 280,
    tentative_matches: 32,
    inliers: 25,
    inlier_ratio: 0.78125,
    reference_hull_coverage: 0.34,
    reference_grid_coverage: 0.625,
    median_reprojection_error: 1.2,
    projected_area_ratio: 0.09,
    homography_valid: true
  }
};

function idleDatabase(): Database {
  return {
    query: vi.fn(async () => ({ rows: [] }))
  } as unknown as Database;
}

describe('POST /admin/image-similarity', () => {
  it('returns a similarity score and geometric diagnostics', async () => {
    const estimate = vi.fn(async () => result);
    const imageSimilarityService: ImageSimilarityService = { estimate };

    const response = await request(createApp({ database: idleDatabase(), imageSimilarityService }))
      .post('/admin/image-similarity')
      .send({
        reference_image_url: 'https://images.example/reference.jpg',
        candidate_image_url: 'https://images.example/scene.jpg'
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: result });
    expect(estimate).toHaveBeenCalledWith(
      'https://images.example/reference.jpg',
      'https://images.example/scene.jpg'
    );
  });

  it.each([
    [{ candidate_image_url: 'https://images.example/scene.jpg' }, 'reference_image_url'],
    [
      {
        reference_image_url: 'file:///tmp/reference.jpg',
        candidate_image_url: 'https://images.example/scene.jpg'
      },
      'reference_image_url'
    ],
    [
      {
        reference_image_url: 'https://images.example/reference.jpg',
        candidate_image_url: 'not-a-url'
      },
      'candidate_image_url'
    ]
  ])('rejects an invalid image URL', async (body, invalidField) => {
    const imageSimilarityService: ImageSimilarityService = { estimate: vi.fn() };

    const response = await request(createApp({ database: idleDatabase(), imageSimilarityService }))
      .post('/admin/image-similarity')
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain(invalidField);
    expect(imageSimilarityService.estimate).not.toHaveBeenCalled();
  });

  it('returns a processing failure as an unprocessable request', async () => {
    const imageSimilarityService: ImageSimilarityService = {
      estimate: vi.fn(async () => {
        throw new ImageSimilarityServiceError('Images could not be compared: invalid image', 422);
      })
    };

    const response = await request(createApp({ database: idleDatabase(), imageSimilarityService }))
      .post('/admin/image-similarity')
      .send({
        reference_image_url: 'https://images.example/reference.jpg',
        candidate_image_url: 'https://images.example/scene.jpg'
      });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: { message: 'Images could not be compared: invalid image' }
    });
  });
});
