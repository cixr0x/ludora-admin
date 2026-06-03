import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { Alert, Box, Button, Chip, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { adminApi, type StoreDiscoveryRun, type StoreDiscoveryRunResult } from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';

type LoadState = 'loading' | 'ready' | 'error';

const operationRunColumns: DataTableColumn<StoreDiscoveryRun>[] = [
  {
    filterValue: (run) => run.status,
    id: 'status',
    label: 'Status',
    minWidth: 140,
    render: (run) => <Chip label={run.status} size="small" />,
    sortValue: (run) => run.status
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
  }
];

function storeDiscoveryResult(run: StoreDiscoveryRun): StoreDiscoveryRunResult | null {
  return run.type === 'store_discovery' ? (run.result as StoreDiscoveryRunResult | null) : null;
}

export function OperationsPage() {
  const [run, setRun] = useState<StoreDiscoveryRun | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [isStarting, setIsStarting] = useState(false);
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
    setIsStarting(true);
    setError('');
    try {
      const startedRun = await adminApi.startStoreDiscoveryRun();
      setRun(startedRun);
      setLoadState('ready');
    } catch {
      setError('Store discovery could not be started.');
    } finally {
      setIsStarting(false);
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
            disabled={isStarting || runIsActive}
            startIcon={isStarting || runIsActive ? <CircularProgress color="inherit" size={16} /> : <PlayArrowIcon />}
            sx={{ alignSelf: { sm: 'center', xs: 'stretch' } }}
            variant="contained"
            onClick={handleStartStoreDiscovery}
          >
            Run Store Discovery
          </Button>
        </Stack>
      </Paper>

      {loadState === 'loading' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading operations status</Typography>
        </Stack>
      ) : null}

      {loadState === 'ready' && !run ? <Alert severity="info">No recent store discovery run.</Alert> : null}

      {run ? (
        <DataTable
          ariaLabel="Store discovery runs"
          columns={operationRunColumns}
          getRowKey={(row) => row.id}
          minWidth={1010}
          rows={[run]}
        />
      ) : null}
    </Stack>
  );
}
