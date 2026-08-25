import { Router } from 'express';

import {
  ImageSimilarityServiceError,
  type ImageSimilarityService
} from '../imageSimilarity/imageSimilarityService.js';

export function createImageSimilarityRouter(service: ImageSimilarityService): Router {
  const router = Router();

  router.post('/admin/image-similarity', async (request, response, next) => {
    try {
      const referenceImageUrl = requiredHttpUrl(request.body, 'reference_image_url');
      const candidateImageUrl = requiredHttpUrl(request.body, 'candidate_image_url');
      response.json({ data: await service.estimate(referenceImageUrl, candidateImageUrl) });
    } catch (error) {
      next(asHttpError(error));
    }
  });

  return router;
}

function requiredHttpUrl(source: unknown, key: string): string {
  const value = (source ?? {}) as Record<string, unknown>;
  if (typeof value[key] !== 'string' || !value[key].trim()) {
    throw httpError(400, `${key} must be an HTTP(S) URL`);
  }
  const rawUrl = value[key].trim();
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Unsupported protocol');
    }
  } catch {
    throw httpError(400, `${key} must be an HTTP(S) URL`);
  }
  return rawUrl;
}

function asHttpError(error: unknown): unknown {
  if (error instanceof ImageSimilarityServiceError) {
    return httpError(error.status, error.message);
  }
  return error;
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
