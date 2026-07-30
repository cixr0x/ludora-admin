import { Router } from 'express';

import type { StoreItemTranslateAndApproveWorkflow } from '../storeItemReview/storeItemTranslateAndApproveWorkflow.js';

export function createStoreItemReviewRouter(workflow?: StoreItemTranslateAndApproveWorkflow): Router {
  const router = Router();

  router.post('/discovery/listings/:id/translate-and-approve', async (request, response, next) => {
    try {
      if (!workflow) {
        throw httpError(503, 'Description generation service is not configured');
      }

      const candidateId = integerPathParam(request.params.id);
      const result = await workflow.start(candidateId);
      response.status(202).json({
        data: {
          candidate_id: result.candidateId,
          status: result.status
        }
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function integerPathParam(value: string | string[] | undefined): number {
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  const parsed = Number(normalizedValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw httpError(400, 'id must be a positive integer');
  }
  return parsed;
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
