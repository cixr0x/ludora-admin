import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  Link,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Typography
} from '@mui/material';
import { useEffect, useState } from 'react';
import {
  adminApi,
  type AdminRecord,
  type ExternalCoverImageOptimizationResult,
  type FailedCoverImage,
  type ItemDiscoveryRunScope,
  type ItemEmbeddingRunResult,
  type ItemDiscoveryRunResult,
  type ItemUpdateRunScope,
  type ItemUpdateRunResult,
  type StoreDiscoveryRun,
  type StoreDiscoveryRunResult
} from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { useInfiniteServerRows, useServerTableState } from '../components/useServerTableState';

type LoadState = 'loading' | 'ready' | 'error';
export type OperationPageMode = 'image_optimization' | 'item_discovery' | 'item_embeddings' | 'item_update' | 'store_discovery';
type StartingOperation = OperationPageMode | '';

const operationPageContent: Record<OperationPageMode, { description: string; title: string }> = {
  image_optimization: {
    description: 'Optimize oversized external item cover images and update catalog image URLs.',
    title: 'Image Optimization'
  },
  item_discovery: {
    description: 'Discover store items for selected stores or all stores.',
    title: 'Store Item Discovery'
  },
  item_embeddings: {
    description: 'Generate semantic search embeddings for catalog items.',
    title: 'Item Embeddings'
  },
  item_update: {
    description: 'Refresh confirmed boardgame store items from their product pages.',
    title: 'Store Item Update'
  },
  store_discovery: {
    description: 'Search for Mexican boardgame stores and persist dirty candidates.',
    title: 'Store Discovery'
  }
};

const operationRunColumns: DataTableColumn<StoreDiscoveryRun>[] = [
  {
    filterValue: (run) => run.type,
    id: 'type',
    label: 'Type',
    minWidth: 150,
    render: (run) => run.type,
    sortValue: (run) => run.type
  },
  {
    filterValue: (run) => run.status,
    id: 'status',
    label: 'Status',
    minWidth: 140,
    render: (run) => <Chip label={run.status} size="small" />,
    sortValue: (run) => run.status
  },
  {
    filterValue: (run) => run.error ?? '-',
    id: 'error',
    label: 'Error',
    minWidth: 360,
    render: (run) =>
      run.error ? (
        <Typography color="error" sx={{ whiteSpace: 'pre-wrap' }} variant="body2">
          {run.error}
        </Typography>
      ) : (
        '-'
      ),
    sortValue: (run) => run.error ?? ''
  },
  {
    filterValue: (run) => run.started_at,
    id: 'started',
    label: 'Started',
    minWidth: 190,
    render: (run) => run.started_at,
    sortValue: (run) => run.started_at
  },
  {
    filterValue: (run) => run.completed_at ?? '-',
    id: 'completed',
    label: 'Completed',
    minWidth: 190,
    render: (run) => run.completed_at ?? '-',
    sortValue: (run) => run.completed_at ?? ''
  },
  {
    filterValue: (run) => storeDiscoveryResult(run)?.accepted_stores ?? '-',
    id: 'accepted_stores',
    label: 'Accepted stores',
    minWidth: 160,
    render: (run) => storeDiscoveryResult(run)?.accepted_stores ?? '-',
    sortValue: (run) => storeDiscoveryResult(run)?.accepted_stores ?? null
  },
  {
    filterValue: (run) => storeDiscoveryResult(run)?.candidate_domains ?? '-',
    id: 'candidate_domains',
    label: 'Candidate domains',
    minWidth: 170,
    render: (run) => storeDiscoveryResult(run)?.candidate_domains ?? '-',
    sortValue: (run) => storeDiscoveryResult(run)?.candidate_domains ?? null
  },
  {
    filterValue: (run) => storeDiscoveryResult(run)?.searched_queries ?? '-',
    id: 'searched_queries',
    label: 'Searched queries',
    minWidth: 160,
    render: (run) => storeDiscoveryResult(run)?.searched_queries ?? '-',
    sortValue: (run) => storeDiscoveryResult(run)?.searched_queries ?? null
  },
  {
    filterValue: (run) => itemDiscoveryResult(run)?.item_candidates ?? '-',
    id: 'item_candidates',
    label: 'New items',
    minWidth: 130,
    render: (run) => itemDiscoveryResult(run)?.item_candidates ?? '-',
    sortValue: (run) => itemDiscoveryResult(run)?.item_candidates ?? null
  },
  {
    filterValue: (run) => itemUpdateResult(run)?.updated_items ?? '-',
    id: 'updated_items',
    label: 'Updated items',
    minWidth: 150,
    render: (run) => itemUpdateResult(run)?.updated_items ?? '-',
    sortValue: (run) => itemUpdateResult(run)?.updated_items ?? null
  },
  {
    filterValue: (run) => itemEmbeddingResult(run)?.selected_items ?? '-',
    id: 'selected_embeddings',
    label: 'Selected embeddings',
    minWidth: 190,
    render: (run) => itemEmbeddingResult(run)?.selected_items ?? '-',
    sortValue: (run) => itemEmbeddingResult(run)?.selected_items ?? null
  },
  {
    filterValue: (run) => itemEmbeddingResult(run)?.embedded_items ?? '-',
    id: 'embedded_items',
    label: 'Embedded items',
    minWidth: 170,
    render: (run) => itemEmbeddingResult(run)?.embedded_items ?? '-',
    sortValue: (run) => itemEmbeddingResult(run)?.embedded_items ?? null
  },
  {
    filterValue: (run) => itemEmbeddingResult(run)?.model ?? '-',
    id: 'embedding_model',
    label: 'Embedding model',
    minWidth: 220,
    render: (run) => itemEmbeddingResult(run)?.model ?? '-',
    sortValue: (run) => itemEmbeddingResult(run)?.model ?? ''
  }
];

function storeDiscoveryResult(run: StoreDiscoveryRun): StoreDiscoveryRunResult | null {
  return run.type === 'store_discovery' ? (run.result as StoreDiscoveryRunResult | null) : null;
}

function itemDiscoveryResult(run: StoreDiscoveryRun): ItemDiscoveryRunResult | null {
  return run.type === 'item_discovery' ? (run.result as ItemDiscoveryRunResult | null) : null;
}

function itemUpdateResult(run: StoreDiscoveryRun): ItemUpdateRunResult | null {
  return run.type === 'item_update' ? (run.result as ItemUpdateRunResult | null) : null;
}

function itemEmbeddingResult(run: StoreDiscoveryRun): ItemEmbeddingRunResult | null {
  return run.type === 'item_embeddings' ? (run.result as ItemEmbeddingRunResult | null) : null;
}

const imageOptimizationSummaryItems: Array<{
  key: keyof ExternalCoverImageOptimizationResult['summary'];
  label: string;
}> = [
  { key: 'itemsScanned', label: 'Items scanned' },
  { key: 'imageFields', label: 'Image fields' },
  { key: 'downloadedImages', label: 'Downloaded images' },
  { key: 'optimizedImages', label: 'Optimized images' },
  { key: 'uploadedImages', label: 'Uploaded images' },
  { key: 'updatedRows', label: 'Updated rows' },
  { key: 'failedImages', label: 'Failed images' },
  { key: 'skippedManaged', label: 'Skipped managed' },
  { key: 'skippedWithinLimit', label: 'Skipped within limit' },
  { key: 'skippedBlank', label: 'Skipped blank' }
];

function optionalRecordText(record: AdminRecord, key: string): string {
  const value = record[key];
  return value === null || value === undefined ? '' : String(value);
}

function recordText(record: AdminRecord, key: string, fallback = '-') {
  return optionalRecordText(record, key) || fallback;
}

function storeIdFor(record: AdminRecord): number | null {
  const value = Number(record.id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function errorCell(value: string) {
  return value ? (
    <Typography color="error" sx={{ whiteSpace: 'pre-wrap' }} variant="body2">
      {value}
    </Typography>
  ) : (
    '-'
  );
}

function websiteLink(record: AdminRecord) {
  const url = optionalRecordText(record, 'website_url');
  return url ? (
    <Link href={url} rel="noreferrer" target="_blank">
      {url}
    </Link>
  ) : (
    '-'
  );
}

const storeItemDiscoveryJobColumns: DataTableColumn<AdminRecord>[] = [
  {
    filterValue: (row) => recordText(row, 'id'),
    id: 'id',
    label: 'ID',
    minWidth: 90,
    render: (row) => {
      const id = recordText(row, 'id');
      return (
        <Link href={`#operations-store-item-discovery?job_id=${encodeURIComponent(id)}`}>
          {id}
        </Link>
      );
    },
    sortValue: (row) => recordText(row, 'id')
  },
  {
    filterValue: (row) => recordText(row, 'run_id'),
    id: 'run_id',
    label: 'Run ID',
    minWidth: 180,
    render: (row) => recordText(row, 'run_id'),
    sortValue: (row) => recordText(row, 'run_id')
  },
  {
    filterValue: (row) => recordText(row, 'store_id'),
    id: 'store_id',
    label: 'Store ID',
    minWidth: 110,
    render: (row) => recordText(row, 'store_id'),
    sortValue: (row) => recordText(row, 'store_id')
  },
  {
    filterValue: (row) => recordText(row, 'website_url'),
    id: 'website_url',
    label: 'Website URL',
    minWidth: 240,
    render: websiteLink,
    sortValue: (row) => recordText(row, 'website_url')
  },
  {
    filterValue: (row) => recordText(row, 'status'),
    id: 'status',
    label: 'Status',
    minWidth: 130,
    render: (row) => <Chip label={recordText(row, 'status')} size="small" />,
    sortValue: (row) => recordText(row, 'status')
  },
  {
    filterValue: (row) => optionalRecordText(row, 'error'),
    id: 'error',
    label: 'Error',
    minWidth: 280,
    render: (row) => errorCell(optionalRecordText(row, 'error')),
    sortValue: (row) => optionalRecordText(row, 'error')
  },
  {
    filterValue: (row) => recordText(row, 'started_at'),
    id: 'started_at',
    label: 'Started at',
    minWidth: 190,
    render: (row) => recordText(row, 'started_at'),
    sortValue: (row) => recordText(row, 'started_at')
  },
  {
    filterValue: (row) => recordText(row, 'completed_at'),
    id: 'completed_at',
    label: 'Completed at',
    minWidth: 190,
    render: (row) => recordText(row, 'completed_at'),
    sortValue: (row) => recordText(row, 'completed_at')
  },
  {
    filterValue: (row) => recordText(row, 'new_items'),
    id: 'new_items',
    label: 'New items',
    minWidth: 130,
    render: (row) => recordText(row, 'new_items'),
    sortValue: (row) => recordText(row, 'new_items')
  },
  {
    filterValue: (row) => recordText(row, 'created_at'),
    id: 'created_at',
    label: 'Created at',
    minWidth: 190,
    render: (row) => recordText(row, 'created_at'),
    sortValue: (row) => recordText(row, 'created_at')
  },
  {
    filterValue: (row) => recordText(row, 'updated_at'),
    id: 'updated_at',
    label: 'Updated at',
    minWidth: 190,
    render: (row) => recordText(row, 'updated_at'),
    sortValue: (row) => recordText(row, 'updated_at')
  }
];

const storeItemUpdateJobColumns: DataTableColumn<AdminRecord>[] = [
  {
    filterValue: (row) => recordText(row, 'id'),
    id: 'id',
    label: 'ID',
    minWidth: 90,
    render: (row) => recordText(row, 'id'),
    sortValue: (row) => recordText(row, 'id')
  },
  {
    filterValue: (row) => recordText(row, 'run_id'),
    id: 'run_id',
    label: 'Run ID',
    minWidth: 180,
    render: (row) => recordText(row, 'run_id'),
    sortValue: (row) => recordText(row, 'run_id')
  },
  {
    filterValue: (row) => recordText(row, 'store_id'),
    id: 'store_id',
    label: 'Store ID',
    minWidth: 110,
    render: (row) => recordText(row, 'store_id'),
    sortValue: (row) => recordText(row, 'store_id')
  },
  {
    filterValue: (row) => recordText(row, 'status'),
    id: 'status',
    label: 'Status',
    minWidth: 130,
    render: (row) => <Chip label={recordText(row, 'status')} size="small" />,
    sortValue: (row) => recordText(row, 'status')
  },
  {
    filterValue: (row) => optionalRecordText(row, 'error'),
    id: 'error',
    label: 'Error',
    minWidth: 280,
    render: (row) => errorCell(optionalRecordText(row, 'error')),
    sortValue: (row) => optionalRecordText(row, 'error')
  },
  {
    filterValue: (row) => recordText(row, 'started_at'),
    id: 'started_at',
    label: 'Started at',
    minWidth: 190,
    render: (row) => recordText(row, 'started_at'),
    sortValue: (row) => recordText(row, 'started_at')
  },
  {
    filterValue: (row) => recordText(row, 'completed_at'),
    id: 'completed_at',
    label: 'Completed at',
    minWidth: 190,
    render: (row) => recordText(row, 'completed_at'),
    sortValue: (row) => recordText(row, 'completed_at')
  },
  {
    filterValue: (row) => recordText(row, 'scanned_items'),
    id: 'scanned_items',
    label: 'Scanned items',
    minWidth: 150,
    render: (row) => recordText(row, 'scanned_items'),
    sortValue: (row) => recordText(row, 'scanned_items')
  },
  {
    filterValue: (row) => recordText(row, 'updated_items'),
    id: 'updated_items',
    label: 'Updated items',
    minWidth: 150,
    render: (row) => recordText(row, 'updated_items'),
    sortValue: (row) => recordText(row, 'updated_items')
  },
  {
    filterValue: (row) => recordText(row, 'created_at'),
    id: 'created_at',
    label: 'Created at',
    minWidth: 190,
    render: (row) => recordText(row, 'created_at'),
    sortValue: (row) => recordText(row, 'created_at')
  },
  {
    filterValue: (row) => recordText(row, 'updated_at'),
    id: 'updated_at',
    label: 'Updated at',
    minWidth: 190,
    render: (row) => recordText(row, 'updated_at'),
    sortValue: (row) => recordText(row, 'updated_at')
  }
];

function StoreItemDiscoveryJobsTable({ refreshKey }: { refreshKey: number }) {
  const table = useServerTableState('started_at', 'desc');
  const { hasMore, isLoadingMore, loadMore, rows, state, totalRows } = useInfiniteServerRows(
    table,
    adminApi.getStoreItemDiscoveryJobsPage
  );

  useEffect(() => {
    if (refreshKey > 0) {
      table.refresh();
    }
  }, [refreshKey]);

  if (state === 'loading') {
    return <JobTableLoading label="Loading store item discovery jobs" />;
  }
  if (state === 'error') {
    return <Alert severity="error">Store item discovery jobs could not be loaded.</Alert>;
  }

  return (
    <DataTable
      ariaLabel="Store item discovery jobs"
      columns={storeItemDiscoveryJobColumns}
      defaultSortColumnId="started_at"
      getRowKey={(row, index) => recordText(row, 'id', String(index))}
      infiniteScroll={{
        hasMore,
        isLoading: isLoadingMore,
        loadedCount: rows.length,
        onLoadMore: loadMore,
        totalCount: totalRows
      }}
      minWidth={1980}
      rows={rows}
      serverSide
      tableState={table.tableState}
      onTableStateChange={table.handleTableStateChange}
    />
  );
}

function StoreItemUpdateJobsTable({ refreshKey }: { refreshKey: number }) {
  const table = useServerTableState('started_at', 'desc');
  const { hasMore, isLoadingMore, loadMore, rows, state, totalRows } = useInfiniteServerRows(
    table,
    adminApi.getStoreItemUpdateJobsPage
  );

  useEffect(() => {
    if (refreshKey > 0) {
      table.refresh();
    }
  }, [refreshKey]);

  if (state === 'loading') {
    return <JobTableLoading label="Loading store item update jobs" />;
  }
  if (state === 'error') {
    return <Alert severity="error">Store item update jobs could not be loaded.</Alert>;
  }

  return (
    <DataTable
      ariaLabel="Store item update jobs"
      columns={storeItemUpdateJobColumns}
      defaultSortColumnId="started_at"
      getRowKey={(row, index) => recordText(row, 'id', String(index))}
      infiniteScroll={{
        hasMore,
        isLoading: isLoadingMore,
        loadedCount: rows.length,
        onLoadMore: loadMore,
        totalCount: totalRows
      }}
      minWidth={1860}
      rows={rows}
      serverSide
      tableState={table.tableState}
      onTableStateChange={table.handleTableStateChange}
    />
  );
}

function JobTableLoading({ label }: { label: string }) {
  return (
    <Stack alignItems="center" direction="row" spacing={1.5}>
      <CircularProgress size={18} />
      <Typography variant="body2">{label}</Typography>
    </Stack>
  );
}

function ImageOptimizationSummary({ result }: { result: ExternalCoverImageOptimizationResult }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography sx={{ fontWeight: 700 }} variant="subtitle1">
          Image optimization summary
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gap: 1,
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))'
          }}
        >
          {imageOptimizationSummaryItems.map((item) => (
            <Box key={item.key} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.25 }}>
              <Typography color="text.secondary" variant="caption">
                {item.label}
              </Typography>
              <Typography sx={{ fontWeight: 700 }} variant="h6">
                {result.summary[item.key]}
              </Typography>
            </Box>
          ))}
        </Box>
        {result.failures.length > 0 ? (
          <Stack spacing={1}>
            <Typography sx={{ fontWeight: 700 }} variant="subtitle2">
              Failures
            </Typography>
            {result.failures.map((failure) => (
              <ImageOptimizationFailure failure={failure} key={`${failure.itemId}-${failure.field}-${failure.sourceUrl}`} />
            ))}
          </Stack>
        ) : null}
      </Stack>
    </Paper>
  );
}

function ImageOptimizationFailure({ failure }: { failure: FailedCoverImage }) {
  return (
    <Alert severity="warning">
      <Stack spacing={0.5}>
        <Typography sx={{ fontWeight: 700 }} variant="body2">
          Item {failure.itemId} {failure.field}
        </Typography>
        <Typography variant="body2">{failure.error}</Typography>
        <Link href={failure.sourceUrl} rel="noreferrer" target="_blank">
          {failure.sourceUrl}
        </Link>
      </Stack>
    </Alert>
  );
}

export function OperationsPage({ operation = 'store_discovery' }: { operation?: OperationPageMode }) {
  const [imageOptimizationResult, setImageOptimizationResult] = useState<ExternalCoverImageOptimizationResult | null>(null);
  const [run, setRun] = useState<StoreDiscoveryRun | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [embeddingRefreshMode, setEmbeddingRefreshMode] = useState<'full' | 'missing'>('missing');
  const [storeItemDiscoveryJobsRefreshKey, setStoreItemDiscoveryJobsRefreshKey] = useState(0);
  const [storeItemUpdateJobsRefreshKey, setStoreItemUpdateJobsRefreshKey] = useState(0);
  const [stores, setStores] = useState<AdminRecord[]>([]);
  const [storeLoadState, setStoreLoadState] = useState<LoadState>('ready');
  const [selectedStoreIds, setSelectedStoreIds] = useState<number[]>([]);
  const [startingOperation, setStartingOperation] = useState<StartingOperation>('');
  const [stoppingOperation, setStoppingOperation] = useState(false);
  const [error, setError] = useState('');
  const pageContent = operationPageContent[operation];
  const usesJobLogTable = operation === 'item_discovery' || operation === 'item_update';
  const usesRunTable = operation !== 'image_optimization' && !usesJobLogTable;

  useEffect(() => {
    let ignore = false;

    adminApi
      .getLatestStoreDiscoveryRun()
      .then((latestRun) => {
        if (!ignore) {
          setRun(latestRun);
          setLoadState('ready');
        }
      })
      .catch(() => {
        if (!ignore) {
          setError('Operations status could not be loaded.');
          setLoadState('error');
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (operation !== 'item_discovery' && operation !== 'item_update') {
      return undefined;
    }
    let ignore = false;
    setStoreLoadState('loading');
    setStores([]);
    setSelectedStoreIds([]);

    adminApi
      .getStores()
      .then((rows) => {
        if (!ignore) {
          setStores(rows);
          setStoreLoadState('ready');
        }
      })
      .catch(() => {
        if (!ignore) {
          setStoreLoadState('error');
        }
      });

    return () => {
      ignore = true;
    };
  }, [operation]);

  useEffect(() => {
    if (run?.status !== 'running' && run?.status !== 'cancelling') {
      return undefined;
    }

    const timer = window.setInterval(() => {
      adminApi
        .getLatestStoreDiscoveryRun()
        .then((latestRun) => {
          if (latestRun) {
            setRun(latestRun);
          }
          if (operation === 'item_discovery' && latestRun?.type === 'item_discovery') {
            setStoreItemDiscoveryJobsRefreshKey((currentKey) => currentKey + 1);
          }
          if (operation === 'item_update' && latestRun?.type === 'item_update') {
            setStoreItemUpdateJobsRefreshKey((currentKey) => currentKey + 1);
          }
        })
        .catch(() => {
          setError('Operations status could not be refreshed.');
        });
    }, 3000);

    return () => window.clearInterval(timer);
  }, [operation, run?.status]);

  const runIsActive = run?.status === 'running' || run?.status === 'cancelling';

  async function handleStartStoreDiscovery() {
    setStartingOperation('store_discovery');
    setError('');
    try {
      const startedRun = await adminApi.startStoreDiscoveryRun();
      setRun(startedRun);
      setLoadState('ready');
    } catch {
      setError('Store discovery could not be started.');
    } finally {
      setStartingOperation('');
    }
  }

  async function handleStartItemUpdate(scope: ItemUpdateRunScope) {
    setStartingOperation('item_update');
    setError('');
    try {
      const startedRun = await adminApi.startItemUpdateRun(scope);
      setRun(startedRun);
      setLoadState('ready');
      setStoreItemUpdateJobsRefreshKey((currentKey) => currentKey + 1);
    } catch {
      setError('Item update could not be started.');
    } finally {
      setStartingOperation('');
    }
  }

  async function handleOptimizeExternalCoverImages() {
    setStartingOperation('image_optimization');
    setImageOptimizationResult(null);
    setError('');
    try {
      const result = await adminApi.optimizeExternalCoverImages();
      setImageOptimizationResult(result);
      setLoadState('ready');
    } catch {
      setError('External cover image optimization could not be started.');
    } finally {
      setStartingOperation('');
    }
  }

  function handleStoreSelection(storeId: number, checked: boolean) {
    setSelectedStoreIds((currentStoreIds) =>
      checked ? [...currentStoreIds, storeId] : currentStoreIds.filter((currentStoreId) => currentStoreId !== storeId)
    );
  }

  async function handleStartStoreItemDiscovery(scope: ItemDiscoveryRunScope) {
    setStartingOperation('item_discovery');
    setError('');
    try {
      const startedRun = await adminApi.startStoreItemDiscoveryRun(scope);
      setRun(startedRun);
      setLoadState('ready');
      setStoreItemDiscoveryJobsRefreshKey((currentKey) => currentKey + 1);
    } catch {
      setError('Store item discovery could not be started.');
    } finally {
      setStartingOperation('');
    }
  }

  async function handleStartItemEmbeddings() {
    setStartingOperation('item_embeddings');
    setError('');
    try {
      const startedRun = await adminApi.startItemEmbeddingRun(embeddingRefreshMode);
      setRun(startedRun);
      setLoadState('ready');
    } catch {
      setError('Item embeddings could not be started.');
    } finally {
      setStartingOperation('');
    }
  }

  async function handleStopOperation() {
    if (!run || !runIsActive) {
      return;
    }
    setStoppingOperation(true);
    setError('');
    try {
      const cancelledRun = await adminApi.cancelStoreDiscoveryRun(run.id);
      setRun(cancelledRun);
      setLoadState('ready');
    } catch {
      setError('Operation could not be stopped.');
    } finally {
      setStoppingOperation(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
          {pageContent.title}
        </Typography>
        <Typography color="text.secondary" variant="body2">
          {pageContent.description}
        </Typography>
      </Box>

      {error ? <Alert severity="error">{error}</Alert> : null}

      {runIsActive ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction={{ sm: 'row', xs: 'column' }} justifyContent="space-between" spacing={2}>
            <Box>
              <Typography sx={{ fontWeight: 700 }} variant="subtitle1">
                Active operation
              </Typography>
              <Typography color="text.secondary" variant="body2">
                {run?.type} is {run?.status}.
              </Typography>
            </Box>
            <Button
              color="error"
              disabled={stoppingOperation || run?.status === 'cancelling'}
              startIcon={stoppingOperation || run?.status === 'cancelling' ? <CircularProgress color="inherit" size={16} /> : <StopCircleIcon />}
              sx={{ alignSelf: { sm: 'center', xs: 'stretch' } }}
              variant="outlined"
              onClick={handleStopOperation}
            >
              Stop Operation
            </Button>
          </Stack>
        </Paper>
      ) : null}

      {operation === 'store_discovery' ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction={{ sm: 'row', xs: 'column' }} justifyContent="space-between" spacing={2}>
            <Box>
              <Typography sx={{ fontWeight: 700 }} variant="subtitle1">
                Store discovery
              </Typography>
              <Typography color="text.secondary" variant="body2">
                Search for Mexican boardgame stores and persist dirty candidates.
              </Typography>
            </Box>
            <Button
              disabled={Boolean(startingOperation) || runIsActive}
              startIcon={
                startingOperation === 'store_discovery' || runIsActive ? (
                  <CircularProgress color="inherit" size={16} />
                ) : (
                  <PlayArrowIcon />
                )
              }
              sx={{ alignSelf: { sm: 'center', xs: 'stretch' } }}
              variant="contained"
              onClick={handleStartStoreDiscovery}
            >
              Run Store Discovery
            </Button>
          </Stack>
        </Paper>
      ) : null}

      {operation === 'item_discovery' ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={2}>
            <Stack direction={{ md: 'row', xs: 'column' }} justifyContent="space-between" spacing={2}>
              <Box>
                <Typography sx={{ fontWeight: 700 }} variant="subtitle1">
                  Store item discovery
                </Typography>
                <Typography color="text.secondary" variant="body2">
                  Crawl selected stores and persist discovered store item candidates.
                </Typography>
              </Box>
              <Stack
                direction={{ sm: 'row', xs: 'column' }}
                spacing={1}
                sx={{ alignSelf: { md: 'center', xs: 'stretch' } }}
              >
                <Button
                  disabled={
                    Boolean(startingOperation) ||
                    runIsActive ||
                    selectedStoreIds.length === 0 ||
                    storeLoadState !== 'ready'
                  }
                  startIcon={
                    startingOperation === 'item_discovery' || runIsActive ? (
                      <CircularProgress color="inherit" size={16} />
                    ) : (
                      <PlayArrowIcon />
                    )
                  }
                  variant="contained"
                  onClick={() => handleStartStoreItemDiscovery({ store_ids: selectedStoreIds })}
                >
                  Run for selected stores
                </Button>
                <Button
                  disabled={Boolean(startingOperation) || runIsActive}
                  startIcon={
                    startingOperation === 'item_discovery' || runIsActive ? (
                      <CircularProgress color="inherit" size={16} />
                    ) : (
                      <PlayArrowIcon />
                    )
                  }
                  variant="outlined"
                  onClick={() => handleStartStoreItemDiscovery({ all_stores: true })}
                >
                  Run for all
                </Button>
              </Stack>
            </Stack>
            {storeLoadState === 'loading' ? (
              <Stack alignItems="center" direction="row" spacing={1.5}>
                <CircularProgress size={18} />
                <Typography variant="body2">Loading stores</Typography>
              </Stack>
            ) : null}
            {storeLoadState === 'error' ? <Alert severity="error">Stores could not be loaded for selection.</Alert> : null}
            {storeLoadState === 'ready' ? (
              <Stack spacing={1}>
                {stores.length === 0 ? <Typography variant="body2">No stores available for selection.</Typography> : null}
                {stores.map((store) => {
                  const storeId = storeIdFor(store);
                  if (storeId === null) {
                    return null;
                  }
                  const name = optionalRecordText(store, 'name') || `Store ${storeId}`;
                  const domain = optionalRecordText(store, 'canonical_domain');
                  const websiteUrl = optionalRecordText(store, 'website_url');
                  const platform = optionalRecordText(store, 'platform');
                  const details = [domain, websiteUrl, platform].filter(Boolean).join(' | ');
                  return (
                    <Paper key={storeId} variant="outlined" sx={{ p: 1.25 }}>
                      <FormControlLabel
                        control={
                          <Checkbox
                            checked={selectedStoreIds.includes(storeId)}
                            onChange={(event) => handleStoreSelection(storeId, event.target.checked)}
                          />
                        }
                        label={
                          <Box>
                            <Typography variant="body2" sx={{ fontWeight: 700 }}>
                              {name}
                            </Typography>
                            {details ? (
                              <Typography color="text.secondary" variant="caption">
                                {details}
                              </Typography>
                            ) : null}
                          </Box>
                        }
                      />
                    </Paper>
                  );
                })}
              </Stack>
            ) : null}
          </Stack>
        </Paper>
      ) : null}

      {operation === 'item_update' ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={2}>
            <Stack direction={{ md: 'row', xs: 'column' }} justifyContent="space-between" spacing={2}>
              <Box>
                <Typography sx={{ fontWeight: 700 }} variant="subtitle1">
                  Item update
                </Typography>
                <Typography color="text.secondary" variant="body2">
                  Refresh confirmed boardgame store items from their product pages.
                </Typography>
              </Box>
              <Stack
                direction={{ sm: 'row', xs: 'column' }}
                spacing={1}
                sx={{ alignSelf: { md: 'center', xs: 'stretch' } }}
              >
                <Button
                  disabled={
                    Boolean(startingOperation) ||
                    runIsActive ||
                    selectedStoreIds.length === 0 ||
                    storeLoadState !== 'ready'
                  }
                  startIcon={
                    startingOperation === 'item_update' || runIsActive ? (
                      <CircularProgress color="inherit" size={16} />
                    ) : (
                      <PlayArrowIcon />
                    )
                  }
                  variant="contained"
                  onClick={() => handleStartItemUpdate({ store_ids: selectedStoreIds })}
                >
                  Run for selected stores
                </Button>
                <Button
                  disabled={Boolean(startingOperation) || runIsActive}
                  startIcon={
                    startingOperation === 'item_update' || runIsActive ? (
                      <CircularProgress color="inherit" size={16} />
                    ) : (
                      <PlayArrowIcon />
                    )
                  }
                  variant="outlined"
                  onClick={() => handleStartItemUpdate({ all_stores: true })}
                >
                  Run for all
                </Button>
              </Stack>
            </Stack>
            {storeLoadState === 'loading' ? (
              <Stack alignItems="center" direction="row" spacing={1.5}>
                <CircularProgress size={18} />
                <Typography variant="body2">Loading stores</Typography>
              </Stack>
            ) : null}
            {storeLoadState === 'error' ? <Alert severity="error">Stores could not be loaded for selection.</Alert> : null}
            {storeLoadState === 'ready' ? (
              <Stack spacing={1}>
                {stores.length === 0 ? <Typography variant="body2">No stores available for selection.</Typography> : null}
                {stores.map((store) => {
                  const storeId = storeIdFor(store);
                  if (storeId === null) {
                    return null;
                  }
                  const name = optionalRecordText(store, 'name') || `Store ${storeId}`;
                  const domain = optionalRecordText(store, 'canonical_domain');
                  const websiteUrl = optionalRecordText(store, 'website_url');
                  const platform = optionalRecordText(store, 'platform');
                  const details = [domain, websiteUrl, platform].filter(Boolean).join(' | ');
                  return (
                    <Paper key={storeId} variant="outlined" sx={{ p: 1.25 }}>
                      <FormControlLabel
                        control={
                          <Checkbox
                            checked={selectedStoreIds.includes(storeId)}
                            onChange={(event) => handleStoreSelection(storeId, event.target.checked)}
                          />
                        }
                        label={
                          <Box>
                            <Typography variant="body2" sx={{ fontWeight: 700 }}>
                              {name}
                            </Typography>
                            {details ? (
                              <Typography color="text.secondary" variant="caption">
                                {details}
                              </Typography>
                            ) : null}
                          </Box>
                        }
                      />
                    </Paper>
                  );
                })}
              </Stack>
            ) : null}
          </Stack>
        </Paper>
      ) : null}

      {operation === 'item_embeddings' ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction={{ sm: 'row', xs: 'column' }} justifyContent="space-between" spacing={2}>
            <Box>
              <Typography sx={{ fontWeight: 700 }} variant="subtitle1">
                Item embeddings
              </Typography>
              <Typography color="text.secondary" variant="body2">
                Generate semantic search embeddings from item names, descriptions, and taxonomy.
              </Typography>
              <RadioGroup
                row
                value={embeddingRefreshMode}
                onChange={(event) => setEmbeddingRefreshMode(event.target.value === 'full' ? 'full' : 'missing')}
              >
                <FormControlLabel control={<Radio size="small" />} label="Missing only" value="missing" />
                <FormControlLabel control={<Radio size="small" />} label="Full refresh" value="full" />
              </RadioGroup>
            </Box>
            <Button
              disabled={Boolean(startingOperation) || runIsActive}
              startIcon={
                startingOperation === 'item_embeddings' || runIsActive ? (
                  <CircularProgress color="inherit" size={16} />
                ) : (
                  <PlayArrowIcon />
                )
              }
              sx={{ alignSelf: { sm: 'center', xs: 'stretch' } }}
              variant="contained"
              onClick={handleStartItemEmbeddings}
            >
              Run Item Embeddings
            </Button>
          </Stack>
        </Paper>
      ) : null}

      {operation === 'image_optimization' ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction={{ sm: 'row', xs: 'column' }} justifyContent="space-between" spacing={2}>
            <Box>
              <Typography sx={{ fontWeight: 700 }} variant="subtitle1">
                External cover images
              </Typography>
              <Typography color="text.secondary" variant="body2">
                Convert oversized external item covers to managed WebP assets.
              </Typography>
            </Box>
            <Button
              disabled={Boolean(startingOperation) || runIsActive}
              startIcon={
                startingOperation === 'image_optimization' || runIsActive ? (
                  <CircularProgress color="inherit" size={16} />
                ) : (
                  <PlayArrowIcon />
                )
              }
              sx={{ alignSelf: { sm: 'center', xs: 'stretch' } }}
              variant="contained"
              onClick={handleOptimizeExternalCoverImages}
            >
              Optimize External Cover Images
            </Button>
          </Stack>
        </Paper>
      ) : null}

      {imageOptimizationResult ? <ImageOptimizationSummary result={imageOptimizationResult} /> : null}

      {loadState === 'loading' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading operations status</Typography>
        </Stack>
      ) : null}

      {loadState === 'ready' && !run && usesRunTable ? <Alert severity="info">No recent operation run.</Alert> : null}

      {run && usesRunTable ? (
        <DataTable
          ariaLabel="Store discovery runs"
          columns={operationRunColumns}
          getRowKey={(row) => row.id}
          minWidth={2380}
          rows={[run]}
        />
      ) : null}
      {operation === 'item_discovery' ? (
        <StoreItemDiscoveryJobsTable refreshKey={storeItemDiscoveryJobsRefreshKey} />
      ) : null}
      {operation === 'item_update' ? <StoreItemUpdateJobsTable refreshKey={storeItemUpdateJobsRefreshKey} /> : null}
    </Stack>
  );
}
