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

const MAX_LOG_CHUNK_ROWS = 1_000;

const storeItemDiscoveryJobSelect = `
  jobs.id, jobs.run_id, jobs.store_id, stores.name as store_name, jobs.website_url,
  jobs.status, jobs.error, jobs.started_at, jobs.completed_at, jobs.new_items,
  jobs.created_at, jobs.updated_at
`;

const storeItemUpdateJobSelect = `
  jobs.id, jobs.run_id, jobs.store_id, stores.name as store_name, jobs.status,
  jobs.error, jobs.started_at, jobs.completed_at, jobs.scanned_items,
  jobs.updated_items, jobs.created_at, jobs.updated_at
`;

const storeItemUpdateChangeSelect = `
  changes.id, changes.job_id, changes.run_id, changes.store_item_id,
  store_items.store_id, stores.name as store_name, store_items.title as store_item_title,
  store_items.source_url, changes.field_name, changes.old_value, changes.new_value,
  changes.created_at
`;

const storeItemUpdateEventSql = `case
  when changes.field_name = 'store_active' and changes.new_value = 'false'::jsonb then 'Item deactivated'
  when changes.field_name = 'store_active' and changes.new_value = 'true'::jsonb then 'Item activated'
  when changes.field_name = '' then 'Item updated'
  else initcap(replace(changes.field_name, '_', ' ')) || ' changed'
end`;

const storeItemUpdateChangesTableConfig: TableQueryConfig = {
  columns: {
    created_at: columnSql('changes.created_at'),
    event: columnSql(storeItemUpdateEventSql),
    field_name: columnSql('changes.field_name'),
    new_value: columnSql('changes.new_value'),
    old_value: columnSql('changes.old_value'),
    run_id: columnSql('changes.run_id'),
    store_item_id: columnSql('changes.store_item_id'),
    store_item_title: columnSql('store_items.title'),
    store_name: columnSql('stores.name')
  },
  defaultSortColumnId: 'created_at',
  defaultSortDirection: 'desc',
  fromSql: `from store_item_update_change_log changes
    join store_items on store_items.id = changes.store_item_id
    left join stores on stores.id = store_items.store_id`,
  selectSql: storeItemUpdateChangeSelect
};

const storeItemDiscoveryJobsTableConfig: TableQueryConfig = {
  columns: {
    completed_at: columnSql('jobs.completed_at'),
    created_at: columnSql('jobs.created_at'),
    error: columnSql('jobs.error'),
    id: columnSql('jobs.id'),
    new_items: columnSql('jobs.new_items'),
    run_id: columnSql('jobs.run_id'),
    started_at: columnSql('jobs.started_at'),
    status: columnSql('jobs.status'),
    store_id: columnSql('jobs.store_id'),
    store_name: columnSql('stores.name'),
    updated_at: columnSql('jobs.updated_at'),
    website_url: columnSql('jobs.website_url')
  },
  defaultSortColumnId: 'started_at',
  defaultSortDirection: 'desc',
  fromSql: 'from job_store_item_discovery_log jobs left join stores on stores.id = jobs.store_id',
  selectSql: storeItemDiscoveryJobSelect
};

const storeItemUpdateJobsTableConfig: TableQueryConfig = {
  columns: {
    completed_at: columnSql('jobs.completed_at'),
    created_at: columnSql('jobs.created_at'),
    error: columnSql('jobs.error'),
    id: columnSql('jobs.id'),
    run_id: columnSql('jobs.run_id'),
    scanned_items: columnSql('jobs.scanned_items'),
    started_at: columnSql('jobs.started_at'),
    status: columnSql('jobs.status'),
    store_id: columnSql('jobs.store_id'),
    store_name: columnSql('stores.name'),
    updated_at: columnSql('jobs.updated_at'),
    updated_items: columnSql('jobs.updated_items')
  },
  defaultSortColumnId: 'started_at',
  defaultSortDirection: 'desc',
  fromSql: 'from job_store_item_update_log jobs left join stores on stores.id = jobs.store_id',
  selectSql: storeItemUpdateJobSelect
};

export function createOperationsRouter(
  operationsClient: DiscoveryOperationsClient,
  database: Database,
  externalCoverImageOptimizer?: ExternalCoverImageOptimizerRunner
): Router {
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
      const afterId = nonNegativeIntegerQueryField(request.query.after_id, 'after_id');
      const result = await database.query(
        `select ${storeItemDiscoveryJobSelect}
         from job_store_item_discovery_log jobs
         left join stores on stores.id = jobs.store_id
         where jobs.id = $1`,
        [jobId]
      );
      const job = result.rows[0] as Record<string, unknown> | undefined;
      if (!job) {
        throw httpError(404, 'Store item discovery job not found');
      }

      const runId = String(job.run_id ?? '').trim();
      const trace = runId ? await readDiscoveryTraceEntries(database, runId, afterId) : emptyDiscoveryTrace(afterId);
      response.json({
        data: {
          ...trace,
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

  router.get('/admin/operations/store-item-update-jobs/:runId/changes', async (request, response, next) => {
    try {
      const runId = request.params.runId.trim();
      if (!runId) {
        throw httpError(400, 'Run ID is required');
      }
      const jobResult = await database.query(
        `select ${storeItemUpdateJobSelect}
         from job_store_item_update_log jobs
         left join stores on stores.id = jobs.store_id
         where jobs.run_id = $1`,
        [runId]
      );
      const job = jobResult.rows[0] as Record<string, unknown> | undefined;
      if (!job) {
        throw httpError(404, 'Store item update job not found');
      }

      const storeId = optionalPositiveInteger(job.store_id);
      const scopeSql = storeId === null ? 'changes.run_id = $1' : 'store_items.store_id = $1';
      const scopeValue = storeId === null ? runId : storeId;
      const pagination = parsePagination(request.query);
      const tableQuery = parseTableQuery(request.query, storeItemUpdateChangesTableConfig);
      const whereClause = buildScopedWhereClause(tableQuery.filters, scopeSql, scopeValue);
      const limitParam = whereClause.params.length + 1;
      const offsetParam = whereClause.params.length + 2;
      const changesResult = await database.query(
        `select ${storeItemUpdateChangesTableConfig.selectSql}
         ${storeItemUpdateChangesTableConfig.fromSql}
         ${whereClause.sql}
         order by ${tableQuery.sortSql} ${tableQuery.sortDirection}, changes.id ${tableQuery.sortDirection}
         limit $${limitParam} offset $${offsetParam}`,
        [...whereClause.params, pagination.pageSize, pagination.page * pagination.pageSize]
      );
      const countResult = await database.query(
        `select count(*)::int as total
         ${storeItemUpdateChangesTableConfig.fromSql}
         ${whereClause.sql}`,
        whereClause.params
      );
      const total = numberField((countResult.rows[0] ?? {}) as Record<string, unknown>, 'total');

      response.json({
        data: {
          changes: changesResult.rows,
          job
        },
        meta: {
          page: pagination.page,
          page_size: pagination.pageSize,
          total
        }
      });
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

function buildScopedWhereClause(
  filters: Array<{ column: TableColumnConfig; value: string }>,
  scopeSql: string,
  scopeValue: number | string
): { params: Array<number | string>; sql: string } {
  const params: Array<number | string> = [scopeValue];
  const predicates = [scopeSql];

  for (const filter of filters) {
    params.push(likePattern(filter.value));
    predicates.push(`${filter.column.filterSql} ilike $${params.length} escape '\\'`);
  }

  return {
    params,
    sql: `where ${predicates.join(' and ')}`
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
  const rawValue = stringQueryField(value).trim();
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number(rawValue);
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

async function readDiscoveryTraceEntries(database: Database, runId: string, afterId: number) {
  const result = await database.query(
    `select id, run_id, source, event, payload, created_at
     from store_item_discovery_trace_log
     where run_id = $1 and id > $2
     order by id
     limit $3`,
    [runId, afterId, MAX_LOG_CHUNK_ROWS + 1]
  );
  const rows = result.rows as Array<Record<string, unknown>>;
  const entries = rows.slice(0, MAX_LOG_CHUNK_ROWS).map((row) => ({
    created_at: row.created_at,
    event: row.event,
    id: Number(row.id),
    payload: isRecord(row.payload) ? row.payload : {},
    run_id: row.run_id,
    source: row.source
  }));
  const lastEntry = entries.at(-1);
  return {
    entries,
    has_more: rows.length > MAX_LOG_CHUNK_ROWS,
    next_cursor: lastEntry?.id ?? afterId
  };
}

function emptyDiscoveryTrace(afterId: number) {
  return {
    entries: [],
    has_more: false,
    next_cursor: afterId
  };
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (field === '' || field === null || field === undefined) {
    return 0;
  }

  const parsed = typeof field === 'number' ? field : Number(field);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
