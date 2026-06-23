import { Router } from 'express';

import { LocalCoverWorkflowError, type LocalCoverWorkflowManager } from '../localCoverWorkflow.js';

export function createLocalCoverWorkflowRouter(localCoverWorkflowManager: LocalCoverWorkflowManager): Router {
  const router = Router();

  router.get('/admin/local-cover-workflows/current', (_request, response) => {
    response.json({ data: localCoverWorkflowManager.getCurrent() });
  });

  router.post('/admin/local-cover-workflows', async (request, response, next) => {
    try {
      const storeItemId = positiveIntegerBodyField(request.body, 'store_item_id');
      const workflow = await localCoverWorkflowManager.start(storeItemId);
      response.status(202).json({ data: workflow });
    } catch (error) {
      if (error instanceof LocalCoverWorkflowError) {
        next(httpError(error.status, error.message));
        return;
      }
      next(error);
    }
  });

  router.post('/admin/local-cover-workflows/items', async (request, response, next) => {
    try {
      const itemId = positiveIntegerBodyField(request.body, 'item_id');
      const workflow = await localCoverWorkflowManager.startFromItem(itemId);
      response.status(202).json({ data: workflow });
    } catch (error) {
      if (error instanceof LocalCoverWorkflowError) {
        next(httpError(error.status, error.message));
        return;
      }
      next(error);
    }
  });

  return router;
}

function positiveIntegerBodyField(body: unknown, key: string): number {
  const value = (body ?? {}) as Record<string, unknown>;
  const field = value[key];
  const parsed = typeof field === 'number' ? field : typeof field === 'string' ? Number(field.trim()) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw httpError(400, `${key} must be a positive integer`);
  }
  return parsed;
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
