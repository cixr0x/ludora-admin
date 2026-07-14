import { Router } from 'express';

import {
  CoverFlatteningWorkflowError,
  type CoverFlatteningSourceField,
  type CoverFlatteningTargetField,
  type CoverFlatteningWorkflowManager
} from '../coverFlatteningWorkflow.js';

export function createCoverFlatteningWorkflowRouter(manager: CoverFlatteningWorkflowManager): Router {
  const router = Router();

  router.post('/admin/cover-flattening-workflows/store-items', async (request, response, next) => {
    try {
      const storeItemId = positiveInteger(request.body, 'store_item_id');
      response.status(201).json({ data: await manager.startFromStoreItem(storeItemId) });
    } catch (error) {
      next(asHttpError(error));
    }
  });

  router.post('/admin/cover-flattening-workflows/items', async (request, response, next) => {
    try {
      const itemId = positiveInteger(request.body, 'item_id');
      const sourceField = imageField(request.body, 'source_field') as CoverFlatteningSourceField;
      response.status(201).json({ data: await manager.startFromItem(itemId, sourceField) });
    } catch (error) {
      next(asHttpError(error));
    }
  });

  router.get('/admin/cover-flattening-workflows/:workflowId/source', async (request, response, next) => {
    try {
      const sourcePath = await manager.getSourceFile(request.params.workflowId);
      response.setHeader('Cache-Control', 'no-store');
      response.sendFile(sourcePath);
    } catch (error) {
      next(asHttpError(error));
    }
  });

  router.get('/admin/cover-flattening-workflows/:workflowId/candidates/:candidateIndex', async (request, response, next) => {
    try {
      const candidateIndex = positiveInteger(request.params, 'candidateIndex');
      const candidatePath = await manager.getCandidateFile(request.params.workflowId, candidateIndex);
      response.setHeader('Cache-Control', 'no-store');
      response.type('png').sendFile(candidatePath);
    } catch (error) {
      next(asHttpError(error));
    }
  });

  router.post('/admin/cover-flattening-workflows/:workflowId/manual-candidate', async (request, response, next) => {
    try {
      const points = normalizedCoverPoints(request.body, 'points');
      response.status(201).json({
        data: await manager.createManualCandidate(request.params.workflowId, points)
      });
    } catch (error) {
      next(asHttpError(error));
    }
  });

  router.post('/admin/cover-flattening-workflows/:workflowId/accept', async (request, response, next) => {
    try {
      const candidateIndex = positiveInteger(request.body, 'candidate_index');
      const targetField = imageField(request.body, 'target_field') as CoverFlatteningTargetField;
      const aspectRatio = optionalAspectRatio(request.body, 'aspect_ratio');
      response.json({
        data: await manager.accept(request.params.workflowId, candidateIndex, targetField, aspectRatio)
      });
    } catch (error) {
      next(asHttpError(error));
    }
  });

  router.delete('/admin/cover-flattening-workflows/:workflowId', async (request, response, next) => {
    try {
      await manager.cancel(request.params.workflowId);
      response.json({ data: { cancelled: true } });
    } catch (error) {
      next(asHttpError(error));
    }
  });

  return router;
}

function positiveInteger(source: unknown, key: string): number {
  const value = (source ?? {}) as Record<string, unknown>;
  const parsed = Number(value[key]);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw httpError(400, `${key} must be a positive integer`);
  }
  return parsed;
}

function imageField(source: unknown, key: string): 'image_url' | 'image_url_es' {
  const value = (source ?? {}) as Record<string, unknown>;
  if (value[key] === 'image_url' || value[key] === 'image_url_es') {
    return value[key];
  }
  throw httpError(400, `${key} must be image_url or image_url_es`);
}

function optionalAspectRatio(source: unknown, key: string): number | null {
  const value = (source ?? {}) as Record<string, unknown>;
  if (value[key] === undefined || value[key] === null || value[key] === '') {
    return null;
  }
  const parsed = Number(value[key]);
  if (!Number.isFinite(parsed) || parsed < 0.2 || parsed > 5) {
    throw httpError(400, `${key} must be between 0.2 and 5`);
  }
  return parsed;
}

function normalizedCoverPoints(source: unknown, key: string): Array<{ x: number; y: number }> {
  const value = (source ?? {}) as Record<string, unknown>;
  if (!Array.isArray(value[key]) || value[key].length !== 4) {
    throw httpError(400, `${key} must contain exactly four normalized points`);
  }
  return value[key].map((point) => {
    if (!point || typeof point !== 'object' || Array.isArray(point)) {
      throw httpError(400, `${key} must contain points with x and y coordinates between 0 and 1`);
    }
    const { x, y } = point as Record<string, unknown>;
    if (
      typeof x !== 'number'
      || typeof y !== 'number'
      || !Number.isFinite(x)
      || !Number.isFinite(y)
      || x < 0
      || x > 1
      || y < 0
      || y > 1
    ) {
      throw httpError(400, `${key} must contain points with x and y coordinates between 0 and 1`);
    }
    return { x, y };
  });
}

function asHttpError(error: unknown): unknown {
  if (error instanceof CoverFlatteningWorkflowError) {
    return httpError(error.status, error.message);
  }
  return error;
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
