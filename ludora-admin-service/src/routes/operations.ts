import { Router } from 'express';

import type { Database } from '../db.js';
import type { DiscoveryOperationsClient } from '../discoveryOperations.js';

export function createOperationsRouter(operationsClient: DiscoveryOperationsClient, database: Database): Router {
  const router = Router();

  router.post('/admin/operations/store-discovery-runs', async (_request, response, next) => {
    try {
      const run = await operationsClient.startStoreDiscoveryRun();
      response.status(202).json({ data: run });
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/operations/store-discovery-runs/latest', async (_request, response, next) => {
    try {
      const run = await operationsClient.getLatestStoreDiscoveryRun();
      response.json({ data: run });
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/operations/store-discovery-runs/:runId', async (request, response, next) => {
    try {
      const run = await operationsClient.getStoreDiscoveryRun(request.params.runId);
      response.json({ data: run });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/operations/store-discovery-runs/:runId/cancel', async (request, response, next) => {
    try {
      const run = await operationsClient.cancelStoreDiscoveryRun(request.params.runId);
      response.status(202).json({ data: run });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/operations/stores/:storeId/item-discovery-runs', async (request, response, next) => {
    try {
      const result = await database.query('select id, website_url from stores where id = $1', [request.params.storeId]);
      const store = result.rows[0] as { id?: number; website_url?: string } | undefined;
      if (!store) {
        throw httpError(404, 'Store not found');
      }

      const run = await operationsClient.startItemDiscoveryRun(Number(store.id), String(store.website_url ?? ''));
      response.status(202).json({ data: run });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/operations/item-update-runs', async (_request, response, next) => {
    try {
      const run = await operationsClient.startItemUpdateRun();
      response.status(202).json({ data: run });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/operations/item-embedding-runs', async (request, response, next) => {
    try {
      const refreshMode = parseEmbeddingRefreshMode(request.body);
      const run = await operationsClient.startItemEmbeddingRun(refreshMode);
      response.status(202).json({ data: run });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function parseEmbeddingRefreshMode(body: unknown): 'full' | 'missing' {
  const value = typeof body === 'object' && body !== null && 'refresh_mode' in body ? String(body.refresh_mode) : 'missing';
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === 'full' || normalizedValue === 'missing') {
    return normalizedValue;
  }
  throw httpError(400, 'refresh_mode must be full or missing');
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
