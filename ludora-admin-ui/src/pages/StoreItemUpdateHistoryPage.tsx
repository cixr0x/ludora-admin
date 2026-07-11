import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Alert, Button, CircularProgress, Link, Paper, Stack, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, type AdminRecord } from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';

const REFRESH_INTERVAL_MS = 10_000;

type LoadState = 'loading' | 'ready' | 'error';

const updateChangeColumns: DataTableColumn<AdminRecord>[] = [
  {
    filterValue: (row) => recordText(row, 'created_at'),
    id: 'created_at',
    label: 'Date',
    minWidth: 190,
    render: (row) => recordText(row, 'created_at'),
    sortValue: (row) => recordText(row, 'created_at')
  },
  {
    filterValue: (row) => recordText(row, 'store_name', 'Unknown store'),
    id: 'store_name',
    label: 'Store',
    minWidth: 180,
    render: (row) => recordText(row, 'store_name', 'Unknown store'),
    sortValue: (row) => recordText(row, 'store_name')
  },
  {
    filterValue: (row) => recordText(row, 'store_item_id'),
    id: 'store_item_id',
    label: 'Store item ID',
    minWidth: 130,
    render: (row) => {
      const id = recordText(row, 'store_item_id');
      return <Link href={`#listings?id=${encodeURIComponent(id)}`}>{id}</Link>;
    },
    sortValue: (row) => recordText(row, 'store_item_id')
  },
  {
    filterValue: (row) => recordText(row, 'store_item_title'),
    id: 'store_item_title',
    label: 'Store item',
    minWidth: 260,
    render: (row) => recordText(row, 'store_item_title', '-'),
    sortValue: (row) => recordText(row, 'store_item_title')
  },
  {
    filterValue: (row) => recordText(row, 'field_name'),
    id: 'field_name',
    label: 'Field',
    minWidth: 170,
    render: (row) => recordText(row, 'field_name'),
    sortValue: (row) => recordText(row, 'field_name')
  },
  {
    filterValue: (row) => formatValue(row.old_value),
    id: 'old_value',
    label: 'Old value',
    minWidth: 220,
    render: (row) => formatValue(row.old_value),
    sortValue: (row) => formatValue(row.old_value)
  },
  {
    filterValue: (row) => formatValue(row.new_value),
    id: 'new_value',
    label: 'New value',
    minWidth: 220,
    render: (row) => formatValue(row.new_value),
    sortValue: (row) => formatValue(row.new_value)
  },
  {
    filterValue: (row) => recordText(row, 'run_id'),
    id: 'run_id',
    label: 'Run ID',
    minWidth: 220,
    render: (row) => recordText(row, 'run_id'),
    sortValue: (row) => recordText(row, 'run_id')
  }
];

export function StoreItemUpdateHistoryPage({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [state, setState] = useState<LoadState>('loading');
  const [job, setJob] = useState<AdminRecord | null>(null);
  const [changes, setChanges] = useState<AdminRecord[]>([]);
  const [error, setError] = useState('');
  const requestInFlightRef = useRef(false);

  const loadHistory = useCallback(async () => {
    if (requestInFlightRef.current) {
      return;
    }
    requestInFlightRef.current = true;
    try {
      const result = await adminApi.getStoreItemUpdateHistory(runId);
      setJob(result.job);
      setChanges(result.changes);
      setError('');
      setState('ready');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Store item update history could not be loaded.');
      setState('error');
    } finally {
      requestInFlightRef.current = false;
    }
  }, [runId]);

  useEffect(() => {
    setState('loading');
    setJob(null);
    setChanges([]);
    void loadHistory();
    const timer = window.setInterval(() => void loadHistory(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadHistory]);

  const storeName = recordText(job, 'store_name', 'Multiple stores');

  return (
    <Stack spacing={2.5}>
      <Stack alignItems={{ sm: 'center' }} direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={2}>
        <Stack spacing={0.5}>
          <Typography component="h1" variant="h4">
            Store Item Update History
          </Typography>
          <Typography color="text.secondary" variant="body2">
            {storeName} · Run {runId}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button startIcon={<ArrowBackIcon />} variant="outlined" onClick={onBack}>
            Back to update jobs
          </Button>
          <Button startIcon={<RefreshIcon />} variant="contained" onClick={() => void loadHistory()}>
            Refresh
          </Button>
        </Stack>
      </Stack>

      {state === 'loading' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={20} />
          <Typography variant="body2">Loading update history</Typography>
        </Stack>
      ) : null}
      {state === 'error' ? <Alert severity="error">{error}</Alert> : null}

      {state === 'ready' ? (
        changes.length ? (
          <DataTable
            ariaLabel="Store item update history"
            columns={updateChangeColumns}
            defaultSortColumnId="created_at"
            defaultSortDirection="desc"
            getRowKey={(row, index) => recordText(row, 'id', String(index))}
            minWidth={1590}
            rows={changes}
          />
        ) : (
          <Paper variant="outlined" sx={{ p: 3 }}>
            <Typography color="text.secondary">No store item changes have been recorded for this store.</Typography>
          </Paper>
        )
      ) : null}

      <Typography color="text.secondary" variant="caption">
        Automatically refreshes every 10 seconds. Newest changes are shown first.
      </Typography>
    </Stack>
  );
}

function recordText(record: AdminRecord | null, key: string, fallback = ''): string {
  const value = record?.[key];
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function formatValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined || value === '') {
    return '-';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}
