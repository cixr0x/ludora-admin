import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';
import { Router } from 'express';

import type { Database } from '../db.js';
import type { DiscoveryOperationsClient, ItemDiscoveryRunScope, ItemUpdateRunScope } from '../discoveryOperations.js';
import type { ExternalCoverImageOptimizerOptions, ExternalCoverImageOptimizerResult } from '../externalCoverImageOptimizer.js';

type SortDirection = 'asc' | 'desc';

type TableColumnConfig = {
  filterSql: string;
  sortSql: string;
};

type TableQueryConfig = {
  columns: Record<string, TableColumnConfig>;
  defaultSortColumnId: string;
  defaultSortDirection: SortDirection;
  fromSql: string;
  selectSql: string;
};

export type ExternalCoverImageOptimizerRunner = {
  run(options: ExternalCoverImageOptimizerOptions): Promise<ExternalCoverImageOptimizerResult>;
};

export type StoreItemDiscoveryLogOptions = {
  envFile: string;
  packageDir: string;
  traceDirectory?: string;
};

const MAX_LOG_CHUNK_BYTES = 512 * 1024;

const storeItemDiscoveryJobSelect = `
  id, run_id, store_id, website_url, status, error, started_at,
  completed_at, new_items, created_at, updated_at
`;

const storeItemUpdateJobSelect = `
  id, run_id, store_id, status, error, started_at, completed_at,
  scanned_items, updated_items, created_at, updated_at
`;

const storeItemDiscoveryJobsTableConfig: TableQueryConfig = {
  columns: {
    completed_at: columnSql('completed_at'),
    created_at: columnSql('created_at'),
    error: columnSql('error'),
    id: columnSql('id'),
    new_items: columnSql('new_items'),
    run_id: columnSql('run_id'),
    started_at: columnSql('started_at'),
    status: columnSql('status'),
    store_id: columnSql('store_id'),
    updated_at: columnSql('updated_at'),
    website_url: columnSql('website_url')
  },
  defaultSortColumnId: 'started_at',
  defaultSortDirection: 'desc',
  fromSql: 'from job_store_item_discovery_log',
  selectSql: storeItemDiscoveryJobSelect
};

const storeItemUpdateJobsTableConfig: TableQueryConfig = {
  columns: {
    completed_at: columnSql('completed_at'),
    created_at: columnSql('created_at'),
    error: columnSql('error'),
    id: columnSql('id'),
    run_id: columnSql('run_id'),
    scanned_items: columnSql('scanned_items'),
    started_at: columnSql('started_at'),
    status: columnSql('status'),
    store_id: columnSql('store_id'),
    updated_at: columnSql('updated_at'),
    updated_items: columnSql('updated_items')
  },
  defaultSortColumnId: 'started_at',
  defaultSortDirection: 'desc',
  fromSql: 'from job_store_item_update_log',
  selectSql: storeItemUpdateJobSelect
};

export function createOperationsRouter(
  operationsClient: DiscoveryOperationsClient,
  database: Database,
  externalCoverImageOptimizer?: ExternalCoverImageOptimizerRunner,
  discoveryLogOptions?: StoreItemDiscoveryLogOptions
): Router {
  const router = Router();
  const discoveryTraceDirectory = resolveDiscoveryTraceDirectory(discoveryLogOptions);

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

  router.get('/admin/operations/store-item-discovery-jobs', async (request, response, next) => {
    try {
      response.json(await queryTable(database, storeItemDiscoveryJobsTableConfig, request.query));
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/operations/store-item-discovery-jobs/:jobId/log', async (request, response, next) => {
    try {
      const jobId = positiveIntegerPathField(request.params.jobId, 'Job ID');
      const requestedOffset = nonNegativeIntegerQueryField(request.query.offset, 'offset');
      const result = await database.query(
        `select ${storeItemDiscoveryJobSelect}
         from job_store_item_discovery_log
         where id = $1`,
        [jobId]
      );
      const job = result.rows[0] as Record<string, unknown> | undefined;
      if (!job) {
        throw httpError(404, 'Store item discovery job not found');
      }

      const runId = String(job.run_id ?? '').trim();
      const chunk =
        discoveryTraceDirectory && runId
          ? await readDiscoveryLogChunk(discoveryTraceDirectory, runId, requestedOffset)
          : emptyLogChunk(requestedOffset);
      response.json({
        data: {
          ...chunk,
          job
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/operations/item-discovery-runs', async (request, response, next) => {
    try {
      const run = await operationsClient.startItemDiscoveryRun(parseItemDiscoveryRunScope(request.body));
      response.status(202).json({ data: run });
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/operations/store-item-update-jobs', async (request, response, next) => {
    try {
      response.json(await queryTable(database, storeItemUpdateJobsTableConfig, request.query));
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

  router.post('/admin/operations/external-cover-image-optimizations', async (_request, response, next) => {
    try {
      if (!externalCoverImageOptimizer) {
        throw httpError(404, 'External cover image optimizer is not configured');
      }
      const result = await externalCoverImageOptimizer.run({ apply: true });
      response.status(202).json({ data: result });
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
  return parseStoreRunScope(body, 'Item update');
}

function parseItemDiscoveryRunScope(body: unknown): ItemDiscoveryRunScope {
  const scope = parseStoreRunScope(body, 'Item discovery');
  if (!scope) {
    throw httpError(400, 'Item discovery scope must include all_stores or store_ids');
  }
  return scope;
}

function parseStoreRunScope(body: unknown, operationLabel: string): ItemDiscoveryRunScope | ItemUpdateRunScope | undefined {
  if (!body) {
    return undefined;
  }
  if (!isRecord(body)) {
    throw httpError(400, `${operationLabel} scope must be an object`);
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
    throw httpError(400, `${operationLabel} scope must include all_stores or store_ids`);
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

async function queryTable(database: Database, config: TableQueryConfig, query: Record<string, unknown>) {
  const pagination = parsePagination(query);
  const tableQuery = parseTableQuery(query, config);
  const whereClause = buildWhereClause(tableQuery.filters);
  const dataParams = [...whereClause.params, pagination.pageSize, pagination.page * pagination.pageSize];
  const limitParam = whereClause.params.length + 1;
  const offsetParam = whereClause.params.length + 2;

  const result = await database.query(
    `select ${config.selectSql}
     ${config.fromSql}
     ${whereClause.sql}
     order by ${tableQuery.sortSql} ${tableQuery.sortDirection}
     limit $${limitParam} offset $${offsetParam}`,
    dataParams
  );
  const countResult = await database.query(
    `select count(*)::int as total
     ${config.fromSql}
     ${whereClause.sql}`,
    whereClause.params
  );
  const total = numberField((countResult.rows[0] ?? {}) as Record<string, unknown>, 'total');

  return {
    data: result.rows,
    meta: {
      page: pagination.page,
      page_size: pagination.pageSize,
      total
    }
  };
}

function parseTableQuery(query: Record<string, unknown>, config: TableQueryConfig) {
  const requestedSort = stringQueryField(query.sort);
  const hasValidRequestedSort = Boolean(requestedSort && config.columns[requestedSort]);
  const sortColumn = hasValidRequestedSort ? config.columns[requestedSort] : config.columns[config.defaultSortColumnId];
  const requestedDirection = stringQueryField(query.sort_direction).toLowerCase();

  return {
    filters: tableFilters(query, config),
    sortDirection: (hasValidRequestedSort
      ? requestedDirection === 'desc'
        ? 'desc'
        : 'asc'
      : config.defaultSortDirection) as SortDirection,
    sortSql: sortColumn.sortSql
  };
}

function tableFilters(query: Record<string, unknown>, config: TableQueryConfig) {
  const filters: Array<{ column: TableColumnConfig; value: string }> = [];
  for (const [columnId, column] of Object.entries(config.columns)) {
    const value = stringQueryField(query[`filter_${columnId}`]).trim();
    if (value) {
      filters.push({ column, value });
    }
  }
  return filters;
}

function buildWhereClause(filters: Array<{ column: TableColumnConfig; value: string }>): { params: string[]; sql: string } {
  const params: string[] = [];
  const predicates: string[] = [];

  for (const filter of filters) {
    params.push(likePattern(filter.value));
    predicates.push(`${filter.column.filterSql} ilike $${params.length} escape '\\'`);
  }

  return {
    params,
    sql: predicates.length ? `where ${predicates.join(' and ')}` : ''
  };
}

function columnSql(columnName: string): TableColumnConfig {
  return {
    filterSql: textSql(columnName),
    sortSql: columnName
  };
}

function textSql(expression: string): string {
  return `coalesce((${expression})::text, '')`;
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function parsePagination(query: Record<string, unknown>) {
  return {
    page: integerQueryField(query.page, 0, 0, 100000),
    pageSize: integerQueryField(query.page_size, 25, 1, 200)
  };
}

function stringQueryField(value: unknown): string {
  const rawValue = Array.isArray(value) ? value[0] : value;
  return typeof rawValue === 'string' || typeof rawValue === 'number' ? String(rawValue) : '';
}

function integerQueryField(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(stringQueryField(value));
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function positiveIntegerPathField(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw httpError(400, `${label} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeIntegerQueryField(value: unknown, label: string): number {
  const rawValue = stringQueryField(value);
  if (!rawValue) {
    return 0;
  }
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw httpError(400, `${label} must be a non-negative integer`);
  }
  return parsed;
}

function resolveDiscoveryTraceDirectory(options?: StoreItemDiscoveryLogOptions): string | null {
  if (!options) {
    return null;
  }

  const configuredDirectory =
    options.traceDirectory?.trim() ||
    process.env.LUDORA_DISCOVERY_TRACE_DIR?.trim() ||
    readTraceDirectoryFromEnvFile(options.envFile);
  return configuredDirectory ? path.resolve(options.packageDir, configuredDirectory) : null;
}

function readTraceDirectoryFromEnvFile(envFile: string): string {
  try {
    return String(dotenv.parse(fs.readFileSync(envFile)).LUDORA_DISCOVERY_TRACE_DIR ?? '').trim();
  } catch {
    return '';
  }
}

async function readDiscoveryLogChunk(traceDirectory: string, runId: string, requestedOffset: number) {
  const tracePath = path.join(traceDirectory, `item-discovery-${safeFilename(runId)}.jsonl`);
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(tracePath, 'r');
    const size = (await handle.stat()).size;
    const reset = requestedOffset > size;
    const offset = reset ? 0 : requestedOffset;
    const buffer = Buffer.alloc(Math.min(MAX_LOG_CHUNK_BYTES, size - offset));
    if (buffer.length === 0) {
      return {
        available: true,
        content: '',
        has_more: false,
        next_offset: offset,
        reset
      };
    }

    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    const lastNewline = bytes.lastIndexOf(0x0a);
    const completeBytes = lastNewline >= 0 ? bytes.subarray(0, lastNewline + 1) : Buffer.alloc(0);
    const nextOffset = offset + completeBytes.length;
    return {
      available: true,
      content: completeBytes.toString('utf8'),
      has_more: nextOffset < size,
      next_offset: nextOffset,
      reset
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyLogChunk(requestedOffset);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function emptyLogChunk(requestedOffset: number) {
  return {
    available: false,
    content: '',
    has_more: false,
    next_offset: requestedOffset,
    reset: false
  };
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (field === '' || field === null || field === undefined) {
    return 0;
  }

  const parsed = typeof field === 'number' ? field : Number(field);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
