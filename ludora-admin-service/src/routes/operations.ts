import { Router } from 'express';

import type { Database } from '../db.js';
import type { DiscoveryOperationsClient, ItemUpdateRunScope } from '../discoveryOperations.js';

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
      const result = await database.query('select id, name, website_url, platform from stores where id = $1', [request.params.storeId]);
      const store = result.rows[0] as { id?: number; name?: string; platform?: string; website_url?: string } | undefined;
      if (!store) {
        throw httpError(404, 'Store not found');
      }

      const run = await operationsClient.startItemDiscoveryRun(
        Number(store.id),
        String(store.website_url ?? ''),
        String(store.platform ?? ''),
        String(store.name ?? '')
      );
      response.status(202).json({ data: run });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/operations/item-update-runs', async (request, response, next) => {
    try {
      const run = await operationsClient.startItemUpdateRun(parseItemUpdateRunScope(request.body));
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

function parseItemUpdateRunScope(body: unknown): ItemUpdateRunScope | undefined {
  if (!body) {
    return undefined;
  }
  if (!isRecord(body)) {
    throw httpError(400, 'Item update scope must be an object');
  }
  if (Object.keys(body).length === 0) {
    return undefined;
  }

  const hasAllStoresProperty = Object.hasOwn(body, 'all_stores');
  const hasAllStores = body.all_stores === true;
  const hasStoreIds = Object.hasOwn(body, 'store_ids');
  if (hasAllStores && hasStoreIds) {
    throw httpError(400, 'Specify either all_stores or store_ids, not both');
  }
  if (hasAllStores) {
    return { all_stores: true };
  }
  if (hasAllStoresProperty) {
    throw httpError(400, 'all_stores must be true when provided');
  }
  if (!hasStoreIds) {
    throw httpError(400, 'Item update scope must include all_stores or store_ids');
  }
  if (!Array.isArray(body.store_ids) || body.store_ids.length === 0) {
    throw httpError(400, 'store_ids must be a non-empty array');
  }
  if (body.store_ids.some((value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
    throw httpError(400, 'store_ids must contain positive integers');
  }
  const storeIds = body.store_ids;
  if (new Set(storeIds).size !== storeIds.length) {
    throw httpError(400, 'store_ids must not contain duplicates');
  }
  return { store_ids: storeIds };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
