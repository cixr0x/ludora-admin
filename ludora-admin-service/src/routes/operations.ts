import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import type { Database } from '../db.js';
import type {
  ContinuousItemUpdateWorkerControlStatus,
  ContinuousItemUpdateWorkerManager
} from '../continuousItemUpdateWorkerManager.js';
import type { DiscoveryOperationsClient, ItemDiscoveryRunScope, ItemUpdateRunScope } from '../discoveryOperations.js';
import type { ExternalCoverImageOptimizerOptions, ExternalCoverImageOptimizerResult } from '../externalCoverImageOptimizer.js';
import type { StoreItemUpdateScheduleManager } from '../storeItemUpdateScheduleManager.js';
import { StoreItemUpdateScheduleConflictError } from '../storeItemUpdateScheduleService.js';

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

export type ExternalCoverImageOptimizationRunStatus = 'completed' | 'failed' | 'running';

export type ExternalCoverImageOptimizationRun = {
  completed_at: string | null;
  error: string | null;
  id: string;
  result: ExternalCoverImageOptimizerResult | null;
  started_at: string;
  status: ExternalCoverImageOptimizationRunStatus;
};

const MAX_LOG_CHUNK_ROWS = 1_000;

const storeItemDiscoveryJobSelect = `
  jobs.id, jobs.run_id, jobs.store_id, stores.name as store_name, jobs.website_url,
  jobs.status, jobs.error, jobs.started_at, jobs.completed_at, jobs.new_items,
  jobs.items_discovered, jobs.confirmed_boardgames, jobs.confirmed_non_boardgames,
  jobs.unconfirmed_boardgames, jobs.unconfirmed_non_boardgames,
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
    confirmed_boardgames: columnSql('jobs.confirmed_boardgames'),
    confirmed_non_boardgames: columnSql('jobs.confirmed_non_boardgames'),
    id: columnSql('jobs.id'),
    items_discovered: columnSql('jobs.items_discovered'),
    new_items: columnSql('jobs.new_items'),
    run_id: columnSql('jobs.run_id'),
    started_at: columnSql('jobs.started_at'),
    status: columnSql('jobs.status'),
    store_id: columnSql('jobs.store_id'),
    store_name: columnSql('stores.name'),
    unconfirmed_boardgames: columnSql('jobs.unconfirmed_boardgames'),
    unconfirmed_non_boardgames: columnSql('jobs.unconfirmed_non_boardgames'),
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
  externalCoverImageOptimizer?: ExternalCoverImageOptimizerRunner,
  continuousItemUpdateWorkerManager?: ContinuousItemUpdateWorkerManager,
  storeItemUpdateScheduleManager?: StoreItemUpdateScheduleManager
): Router {
  const router = Router();
  let latestExternalCoverImageOptimizationRun: ExternalCoverImageOptimizationRun | null = null;

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
      const trace = runId ? await readDiscoveryTraceEntries(database, runId, afterId) : emptyTrace(afterId);
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

  router.post('/admin/operations/store-item-update-worker/pause', (_request, response, next) => {
    try {
      if (!continuousItemUpdateWorkerManager) {
        throw httpError(409, 'Continuous item update worker is not configured');
      }
      response.json({ data: { status: continuousItemUpdateWorkerManager.pause() } });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/operations/store-item-update-worker/resume', (_request, response, next) => {
    try {
      if (!continuousItemUpdateWorkerManager) {
        throw httpError(409, 'Continuous item update worker is not configured');
      }
      response.json({ data: { status: continuousItemUpdateWorkerManager.resume() } });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/operations/store-item-update-schedule/run', async (_request, response, next) => {
    try {
      if (!storeItemUpdateScheduleManager) {
        throw httpError(409, 'Store item update scheduling is not configured');
      }
      response.json({ data: await storeItemUpdateScheduleManager.runManual() });
    } catch (error) {
      next(
        error instanceof StoreItemUpdateScheduleConflictError
          ? httpError(409, 'A store item update schedule run is already in progress')
          : error
      );
    }
  });

  router.get('/admin/operations/store-item-update-monitor', async (request, response, next) => {
    try {
      const rangeHours = integerQueryField(request.query.hours, 48, 24, 168);
      const histogramStoreId = Object.hasOwn(request.query, 'histogram_store_id')
        ? positiveIntegerQueryField(request.query.histogram_store_id, 'histogram_store_id')
        : null;
      response.json({
        data: await loadStoreItemUpdateMonitor(
          database,
          rangeHours,
          histogramStoreId,
          continuousItemUpdateWorkerManager?.getStatus() ?? 'unavailable'
        )
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/operations/store-item-update-failures', async (request, response, next) => {
    try {
      const storeId = positiveIntegerQueryField(request.query.store_id, 'store_id');
      const hours = integerQueryField(request.query.hours, 24, 1, 168);
      const hasPlatformFilter = Object.hasOwn(request.query, 'platform');
      const platform = stringQueryField(request.query.platform).trim().toLowerCase();
      const platformPredicate = hasPlatformFilter ? 'and attempts.platform = $3' : '';
      const params: Array<number | string> = hasPlatformFilter ? [storeId, hours, platform] : [storeId, hours];
      const result = await database.query(
        `select
           attempts.id, attempts.store_item_id, attempts.store_id,
           coalesce(stores.name, 'Unknown store') as store_name,
           store_items.title as store_item_title, store_items.source_url,
           attempts.platform, attempts.status, attempts.http_status, attempts.error,
           attempts.started_at, attempts.completed_at, attempts.duration_ms
         from store_item_update_attempt_log attempts
         join store_items on store_items.id = attempts.store_item_id
         left join stores on stores.id = attempts.store_id
         where attempts.store_id = $1
           and attempts.started_at >= now() - make_interval(hours => $2)
           and attempts.status in ('failed', 'lease_lost')
           ${platformPredicate}
         order by attempts.started_at desc
         limit 100`,
        params
      );
      response.json({ data: result.rows });
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

  router.get('/admin/operations/store-item-update-jobs/:runId/log', async (request, response, next) => {
    try {
      const runId = request.params.runId.trim();
      if (!runId) {
        throw httpError(400, 'Run ID is required');
      }
      const afterId = nonNegativeIntegerQueryField(request.query.after_id, 'after_id');
      const result = await database.query(
        `select ${storeItemUpdateJobSelect}
         from job_store_item_update_log jobs
         left join stores on stores.id = jobs.store_id
         where jobs.run_id = $1`,
        [runId]
      );
      const job = result.rows[0] as Record<string, unknown> | undefined;
      if (!job) {
        throw httpError(404, 'Store item update job not found');
      }

      const jobId = numberField(job, 'id');
      const trace = jobId > 0 ? await readUpdateTraceEntries(database, jobId, afterId) : emptyTrace(afterId);
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

  router.get('/admin/operations/external-cover-image-optimizations/latest', (_request, response, next) => {
    try {
      if (!externalCoverImageOptimizer) {
        throw httpError(404, 'External cover image optimizer is not configured');
      }
      response.json({ data: latestExternalCoverImageOptimizationRun });
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/operations/external-cover-image-optimizations/:runId', (request, response, next) => {
    try {
      if (!externalCoverImageOptimizer) {
        throw httpError(404, 'External cover image optimizer is not configured');
      }
      if (!latestExternalCoverImageOptimizationRun || latestExternalCoverImageOptimizationRun.id !== request.params.runId) {
        throw httpError(404, 'Cover image optimization run not found');
      }
      response.json({ data: latestExternalCoverImageOptimizationRun });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/operations/external-cover-image-optimizations', (_request, response, next) => {
    try {
      if (!externalCoverImageOptimizer) {
        throw httpError(404, 'External cover image optimizer is not configured');
      }
      if (latestExternalCoverImageOptimizationRun?.status === 'running') {
        throw httpError(409, 'Cover image optimization is already running');
      }

      const run: ExternalCoverImageOptimizationRun = {
        completed_at: null,
        error: null,
        id: randomUUID(),
        result: null,
        started_at: new Date().toISOString(),
        status: 'running'
      };
      latestExternalCoverImageOptimizationRun = run;

      void Promise.resolve()
        .then(() => externalCoverImageOptimizer.run({ apply: true }))
        .then((result) => {
          run.completed_at = new Date().toISOString();
          run.result = result;
          run.status = 'completed';
        })
        .catch((error: unknown) => {
          run.completed_at = new Date().toISOString();
          run.error = error instanceof Error ? error.message : String(error);
          run.status = 'failed';
        });

      response.status(202).json({ data: run });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

async function loadStoreItemUpdateMonitor(
  database: Database,
  rangeHours: number,
  histogramStoreId: number | null,
  controlStatus: ContinuousItemUpdateWorkerControlStatus | 'unavailable'
) {
  const workerResult = await database.query(
    `select
       worker.worker_name, worker.worker_id, worker.status, worker.poll_seconds,
       worker.heartbeat_at, worker.started_at, worker.current_store_item_id,
       current_item.update_lease_expires_at as current_lease_expires_at,
       worker.last_attempt_at, worker.last_success_at, worker.last_failure_at,
       worker.last_error, worker.shopify_blocked_until,
       worker.shopify_consecutive_429s, worker.updated_at
     from store_item_update_worker_state worker
     left join store_items current_item on current_item.id = worker.current_store_item_id
     where worker.worker_name = 'continuous'`
  );
  const workerRow = workerResult.rows[0] as Record<string, unknown> | undefined;
  const pollSeconds = workerRow ? numberField(workerRow, 'poll_seconds') || 5 : 5;

  const platformCooldownsResult = await database.query(
    `select
       platform, blocked_until, consecutive_429s,
       (blocked_until > now()) as active
     from store_item_update_platform_cooldown
     where worker_name = 'continuous'
     order by platform`
  );

  const summaryResult = await database.query(
    `with eligible as (
       select store_items.*
       from store_items
       join stores on stores.id = store_items.store_id
       where stores.active = true
         and store_items.is_boardgame = true
         and store_items.is_boardgame_confirmed = true
         and store_items.item_id is not null
         and store_items.source_url <> ''
         and store_items.listing_status = 'LISTED'
         and store_items.store_active = true
     )
     select
       count(*)::int as eligible_items,
       count(*) filter (where next_update_at is null)::int as unscheduled_items,
       count(*) filter (where next_update_at is not null)::int as scheduled_items,
       count(*) filter (where next_update_at > now())::int as scheduled_later_items,
       count(*) filter (where next_update_at <= now())::int as due_items,
       count(*) filter (where refreshed_date >= now() - interval '24 hours')::int as fresh_items,
       count(*) filter (where refreshed_date < now() - interval '24 hours')::int as stale_items,
       count(*) filter (
         where update_lease_token is not null and update_lease_expires_at > now()
       )::int as leased_items,
       coalesce(max(extract(epoch from (now() - refreshed_date)) / 3600), 0)::float8 as oldest_staleness_hours,
       coalesce(max(extract(epoch from (now() - next_update_at)) / 3600)
         filter (where next_update_at <= now()), 0)::float8 as oldest_due_hours,
       min(next_update_at) as next_due_at,
       (select count(*)::int
        from store_item_update_attempt_log
        where started_at >= now() - interval '24 hours') as attempts_24h,
       (select count(*)::int
        from store_item_update_attempt_log
        where started_at >= now() - interval '24 hours'
          and status in ('succeeded', 'deactivated')) as successes_24h,
       (select count(*)::int
        from store_item_update_attempt_log
        where started_at >= now() - interval '24 hours'
          and status in ('failed', 'lease_lost')) as failures_24h,
       (select count(*)::int
        from store_item_update_attempt_log
        where started_at >= now() - interval '24 hours'
          and http_status = 429) as rate_limited_24h
     from eligible`
  );
  const summaryRow = (summaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const eligibleItems = numberField(summaryRow, 'eligible_items');
  const freshItems = numberField(summaryRow, 'fresh_items');
  const successes24h = numberField(summaryRow, 'successes_24h');
  const failures24h = numberField(summaryRow, 'failures_24h');
  const completed24h = successes24h + failures24h;
  const dailyCapacity = 86_400 / pollSeconds;
  const projectedDailyDemand = eligibleItems;
  const scheduleWindowHours = 20;
  const scheduleWindowCapacity = Math.floor((scheduleWindowHours * 3_600) / pollSeconds);
  const scheduleUtilizationPercent = scheduleWindowCapacity > 0
    ? (eligibleItems / scheduleWindowCapacity) * 100
    : 0;

  const scheduleRunsResult = await database.query(
    `select
       (select row_to_json(latest_run) from (
         select * from store_item_update_schedule_runs
         where status = 'COMPLETED'
         order by completed_at desc, id desc limit 1
       ) latest_run) as latest_schedule_run,
       (select row_to_json(latest_attempt) from (
         select * from store_item_update_schedule_runs
         order by started_at desc, id desc limit 1
       ) latest_attempt) as latest_schedule_attempt,
       (select row_to_json(latest_automatic) from (
         select * from store_item_update_schedule_runs
         where trigger = 'AUTOMATIC' and status = 'COMPLETED'
         order by automatic_schedule_date desc, id desc limit 1
       ) latest_automatic) as latest_automatic_schedule_run`
  );
  const scheduleRunsRow = (scheduleRunsResult.rows[0] ?? {}) as Record<string, unknown>;

  const histogramResult = await database.query(
    `with eligible as (
       select greatest(0, floor(extract(epoch from (now() - store_items.refreshed_date)) / 3600))::int as staleness_hour
       from store_items
       join stores on stores.id = store_items.store_id
       where stores.active = true
         and ($2::bigint is null or store_items.store_id = $2::bigint)
         and store_items.is_boardgame = true
         and store_items.is_boardgame_confirmed = true
         and store_items.item_id is not null
         and store_items.source_url <> ''
         and store_items.listing_status = 'LISTED'
         and store_items.store_active = true
     ), hourly as (
       select staleness_hour, count(*)::int as item_count
       from eligible
       where staleness_hour < $1
       group by staleness_hour
     )
     select hours.hour as staleness_hour, coalesce(hourly.item_count, 0)::int as item_count, false as overflow
     from generate_series(0, $1 - 1) hours(hour)
     left join hourly on hourly.staleness_hour = hours.hour
     union all
     select $1, count(*)::int, true
     from eligible
     where staleness_hour >= $1
     order by staleness_hour`,
    [rangeHours, histogramStoreId]
  );

  const storeStatisticsResult = await database.query(
    `with active_stores as (
       select
         stores.id,
         stores.name,
         coalesce(
           nullif(lower(trim(stores.platform)), ''),
           case when exists (
             select 1
             from store_items platform_items
             where platform_items.store_id = stores.id
               and platform_items.raw_payload::text ilike '%shopify%'
           ) then 'shopify' end,
           'unknown'
         ) as platform
       from stores
       where stores.active = true
     ), eligible_items as (
       select store_items.store_id, count(*)::int as item_count
       from store_items
       where store_items.is_boardgame = true
         and store_items.is_boardgame_confirmed = true
         and store_items.item_id is not null
         and store_items.source_url <> ''
         and store_items.listing_status = 'LISTED'
         and store_items.store_active = true
       group by store_items.store_id
     )
     select
       stores.id as store_id,
       stores.name as store_name,
       stores.platform,
       coalesce(eligible_items.item_count, 0)::int as eligible_items,
       count(attempts.id)::int as attempts,
       count(attempts.id) filter (
         where attempts.status in ('succeeded', 'deactivated')
       )::int as successes,
       count(attempts.id) filter (
         where attempts.status in ('failed', 'lease_lost')
       )::int as failures,
       count(attempts.id) filter (where attempts.http_status = 429)::int as rate_limited,
       case when count(attempts.id) filter (
         where attempts.status in ('succeeded', 'deactivated', 'failed', 'lease_lost')
       ) > 0 then round(
         100.0 * count(attempts.id) filter (
           where attempts.status in ('succeeded', 'deactivated')
         ) / count(attempts.id) filter (
           where attempts.status in ('succeeded', 'deactivated', 'failed', 'lease_lost')
         ),
         1
       )::float8 else 0::float8 end as success_rate_percent,
       max(attempts.started_at) as last_attempt_at,
       max(attempts.completed_at) filter (
         where attempts.status in ('failed', 'lease_lost')
       ) as last_failure_at,
       (array_agg(attempts.error order by attempts.completed_at desc) filter (
         where attempts.status in ('failed', 'lease_lost')
       ))[1] as last_error
     from active_stores stores
     left join eligible_items on eligible_items.store_id = stores.id
     left join store_item_update_attempt_log attempts
       on attempts.store_id = stores.id
      and attempts.started_at >= now() - interval '24 hours'
     group by stores.id, stores.name, stores.platform, eligible_items.item_count
     order by failures desc, attempts desc, stores.name asc`
  );

  const recentAttemptsResult = await database.query(
    `select
       attempts.id, attempts.store_item_id, attempts.store_id,
       coalesce(stores.name, 'Unknown store') as store_name,
       store_items.title as store_item_title, attempts.platform, attempts.status,
       attempts.changed, attempts.http_status, attempts.error, attempts.started_at,
       attempts.completed_at, attempts.duration_ms
     from store_item_update_attempt_log attempts
     join store_items on store_items.id = attempts.store_item_id
     left join stores on stores.id = attempts.store_id
     order by attempts.started_at desc
     limit 25`
  );

  return {
    control_status: controlStatus,
    store_statistics: storeStatisticsResult.rows,
    generated_at: new Date().toISOString(),
    histogram: histogramResult.rows.map((row) => {
      const record = row as Record<string, unknown>;
      const stalenessHour = numberField(record, 'staleness_hour');
      return {
        item_count: numberField(record, 'item_count'),
        label: record.overflow ? `${stalenessHour}h+` : `${stalenessHour}h`,
        overflow: Boolean(record.overflow),
        staleness_hour: stalenessHour
      };
    }),
    histogram_store_id: histogramStoreId,
    latest_automatic_schedule_run: scheduleRunsRow.latest_automatic_schedule_run ?? null,
    latest_schedule_attempt: scheduleRunsRow.latest_schedule_attempt ?? null,
    latest_schedule_run: scheduleRunsRow.latest_schedule_run ?? null,
    platform_cooldowns: platformCooldownsResult.rows,
    range_hours: rangeHours,
    recent_attempts: recentAttemptsResult.rows,
    summary: {
      attempts_24h: numberField(summaryRow, 'attempts_24h'),
      daily_capacity: Math.floor(dailyCapacity),
      due_items: numberField(summaryRow, 'due_items'),
      eligible_items: eligibleItems,
      failures_24h: failures24h,
      fresh_items: freshItems,
      fresh_percent: eligibleItems > 0 ? (freshItems / eligibleItems) * 100 : 100,
      leased_items: numberField(summaryRow, 'leased_items'),
      next_due_at: summaryRow.next_due_at ?? null,
      oldest_due_hours: numberField(summaryRow, 'oldest_due_hours'),
      oldest_staleness_hours: numberField(summaryRow, 'oldest_staleness_hours'),
      projected_daily_demand: projectedDailyDemand,
      projected_utilization_percent: dailyCapacity > 0 ? (projectedDailyDemand / dailyCapacity) * 100 : 0,
      rate_limited_24h: numberField(summaryRow, 'rate_limited_24h'),
      scheduled_items: numberField(summaryRow, 'scheduled_items'),
      scheduled_later_items: numberField(summaryRow, 'scheduled_later_items'),
      schedule_utilization_percent: scheduleUtilizationPercent,
      schedule_window_capacity: scheduleWindowCapacity,
      schedule_window_hours: scheduleWindowHours,
      stale_items: numberField(summaryRow, 'stale_items'),
      success_rate_percent: completed24h > 0 ? (successes24h / completed24h) * 100 : 100,
      successes_24h: successes24h,
      unscheduled_items: numberField(summaryRow, 'unscheduled_items')
    },
    worker: workerRow
      ? {
          ...workerRow,
          health: workerHealth(workerRow, pollSeconds),
          shopify_is_blocked: isFutureDate(workerRow.shopify_blocked_until)
        }
      : null
  };
}

function workerHealth(worker: Record<string, unknown>, pollSeconds: number): 'healthy' | 'stale' | 'stopped' {
  if (worker.status === 'stopped') {
    return 'stopped';
  }
  if (worker.status === 'error') {
    return 'stale';
  }
  const heartbeatAt = new Date(String(worker.heartbeat_at ?? '')).getTime();
  const maximumAgeMs = Math.max(30, pollSeconds * 3) * 1_000;
  const activeLease = worker.status === 'running' && isFutureDate(worker.current_lease_expires_at);
  return activeLease || (Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= maximumAgeMs) ? 'healthy' : 'stale';
}

function isFutureDate(value: unknown): boolean {
  if (!value) {
    return false;
  }
  const timestamp = new Date(String(value)).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
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

function positiveIntegerQueryField(value: unknown, label: string): number {
  const rawValue = stringQueryField(value);
  const parsed = Number(rawValue);
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

async function readUpdateTraceEntries(database: Database, jobId: number, afterId: number) {
  const result = await database.query(
    `select id, job_id, run_id, source, event, payload, created_at
     from store_item_update_trace_log
     where job_id = $1 and id > $2
     order by id
     limit $3`,
    [jobId, afterId, MAX_LOG_CHUNK_ROWS + 1]
  );
  const rows = result.rows as Array<Record<string, unknown>>;
  const entries = rows.slice(0, MAX_LOG_CHUNK_ROWS).map((row) => ({
    created_at: row.created_at,
    event: row.event,
    id: Number(row.id),
    job_id: Number(row.job_id),
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

function emptyTrace(afterId: number) {
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
