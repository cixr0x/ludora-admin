import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { Alert, Box, Button, Chip, CircularProgress, FormControlLabel, Paper, Radio, RadioGroup, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import {
  adminApi,
  type ItemEmbeddingRunResult,
  type ItemDiscoveryRunResult,
  type ItemUpdateRunResult,
  type StoreDiscoveryRun,
  type StoreDiscoveryRunResult
} from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';

type LoadState = 'loading' | 'ready' | 'error';

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

export function OperationsPage() {
  const [run, setRun] = useState<StoreDiscoveryRun | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [embeddingRefreshMode, setEmbeddingRefreshMode] = useState<'full' | 'missing'>('missing');
  const [startingOperation, setStartingOperation] = useState<'item_embeddings' | 'item_update' | 'store_discovery' | ''>('');
  const [error, setError] = useState('');

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
    if (run?.status !== 'running') {
      return undefined;
    }

    const timer = window.setInterval(() => {
      adminApi
        .getLatestStoreDiscoveryRun()
        .then((latestRun) => {
          if (latestRun) {
            setRun(latestRun);
          }
        })
        .catch(() => {
          setError('Operations status could not be refreshed.');
        });
    }, 3000);

    return () => window.clearInterval(timer);
  }, [run?.status]);

  const runIsActive = run?.status === 'running';

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

  async function handleStartItemUpdate() {
    setStartingOperation('item_update');
    setError('');
    try {
      const startedRun = await adminApi.startItemUpdateRun();
      setRun(startedRun);
      setLoadState('ready');
    } catch {
      setError('Item update could not be started.');
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

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
          Operations
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Run operational discovery processes from admin.
        </Typography>
      </Box>

      {error ? <Alert severity="error">{error}</Alert> : null}

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

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ sm: 'row', xs: 'column' }} justifyContent="space-between" spacing={2}>
          <Box>
            <Typography sx={{ fontWeight: 700 }} variant="subtitle1">
              Item update
            </Typography>
            <Typography color="text.secondary" variant="body2">
              Refresh confirmed boardgame store items from their product pages.
            </Typography>
          </Box>
          <Button
            disabled={Boolean(startingOperation) || runIsActive}
            startIcon={
              startingOperation === 'item_update' || runIsActive ? (
                <CircularProgress color="inherit" size={16} />
              ) : (
                <PlayArrowIcon />
              )
            }
            sx={{ alignSelf: { sm: 'center', xs: 'stretch' } }}
            variant="contained"
            onClick={handleStartItemUpdate}
          >
            Run Item Update
          </Button>
        </Stack>
      </Paper>

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

      {loadState === 'loading' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading operations status</Typography>
        </Stack>
      ) : null}

      {loadState === 'ready' && !run ? <Alert severity="info">No recent operation run.</Alert> : null}

      {run ? (
        <DataTable
          ariaLabel="Store discovery runs"
          columns={operationRunColumns}
          getRowKey={(row) => row.id}
          minWidth={2380}
          rows={[run]}
        />
      ) : null}
    </Stack>
  );
}
