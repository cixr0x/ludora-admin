import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
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
  Stack,
  Typography
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, type AdminRecord, type StoreItemUpdateTraceEntry, type TableQuery } from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { useInfiniteServerRows, useServerTableState } from '../components/useServerTableState';

const REFRESH_INTERVAL_MS = 10_000;
const TRACE_POLL_INTERVAL_MS = 2_000;
const TERMINAL_STATUSES = new Set(['cancelled', 'completed', 'failed']);

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
    filterValue: (row) => changeEventLabel(row),
    id: 'event',
    label: 'Event',
    minWidth: 190,
    render: (row) => changeEventLabel(row),
    sortValue: (row) => changeEventLabel(row)
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
  const [job, setJob] = useState<AdminRecord | null>(null);
  const [traceEntries, setTraceEntries] = useState<StoreItemUpdateTraceEntry[]>([]);
  const [traceError, setTraceError] = useState('');
  const [traceHasMore, setTraceHasMore] = useState(false);
  const [isFollowingTrace, setIsFollowingTrace] = useState(true);
  const traceConsoleRef = useRef<HTMLDivElement | null>(null);
  const traceCursorRef = useRef(0);
  const traceRequestInFlightRef = useRef(false);
  const table = useServerTableState('created_at', 'desc');
  const fetchHistoryPage = useCallback(async (query: TableQuery) => {
    const result = await adminApi.getStoreItemUpdateHistoryPage(runId, query);
    setJob(result.job);
    return result;
  }, [runId]);
  const { hasMore, isLoadingMore, loadMore, rows: changes, state, totalRows } = useInfiniteServerRows(
    table,
    fetchHistoryPage
  );
  const refreshRef = useRef(table.refresh);
  const currentPageRef = useRef(table.page);
  refreshRef.current = table.refresh;
  currentPageRef.current = table.page;

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (currentPageRef.current === 0) {
        refreshRef.current();
      }
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [runId]);

  const loadTrace = useCallback(async () => {
    if (traceRequestInFlightRef.current) {
      return;
    }
    traceRequestInFlightRef.current = true;
    try {
      const result = await adminApi.getStoreItemUpdateJobLog(runId, traceCursorRef.current);
      setJob(result.job);
      setTraceHasMore(result.has_more);
      setTraceEntries((current) => [...current, ...result.entries]);
      traceCursorRef.current = result.next_cursor;
      setTraceError('');
    } catch (loadError) {
      setTraceError(loadError instanceof Error ? loadError.message : 'Store item update trace could not be loaded.');
    } finally {
      traceRequestInFlightRef.current = false;
    }
  }, [runId]);

  useEffect(() => {
    setTraceEntries([]);
    setTraceError('');
    setTraceHasMore(false);
    traceCursorRef.current = 0;
    void loadTrace();
  }, [loadTrace, runId]);

  const jobStatus = recordText(job, 'status').toLowerCase();
  const shouldPollTrace = !traceError && (!TERMINAL_STATUSES.has(jobStatus) || jobStatus === '' || traceHasMore);

  useEffect(() => {
    if (!shouldPollTrace) {
      return;
    }
    const timer = window.setInterval(() => void loadTrace(), TRACE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadTrace, shouldPollTrace]);

  const formattedTrace = useMemo(() => traceEntries.map(formatTraceEntry).join('\n'), [traceEntries]);

  useEffect(() => {
    if (isFollowingTrace && traceConsoleRef.current) {
      traceConsoleRef.current.scrollTop = traceConsoleRef.current.scrollHeight;
    }
  }, [formattedTrace, isFollowingTrace]);

  const storeName = recordText(job, 'store_name', 'Multiple stores');
  const refreshAll = () => {
    table.refresh();
    void loadTrace();
  };

  return (
    <Stack spacing={2.5}>
      <Stack
        alignItems={{ sm: 'center', xs: 'stretch' }}
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        spacing={2}
      >
        <Stack spacing={0.5}>
          <Typography component="h1" variant="h4" sx={{ fontSize: { sm: '2.125rem', xs: '1.5rem' } }}>
            Store Item Update History
          </Typography>
          <Typography color="text.secondary" variant="body2">
            {storeName} · Run {runId}
          </Typography>
        </Stack>
        <Stack
          alignItems={{ sm: 'center', xs: 'stretch' }}
          direction={{ sm: 'row', xs: 'column' }}
          spacing={1}
          sx={{ width: { sm: 'auto', xs: '100%' } }}
        >
          <Button startIcon={<ArrowBackIcon />} variant="outlined" onClick={onBack}>
            Back to update jobs
          </Button>
          <Button startIcon={<RefreshIcon />} variant="contained" onClick={refreshAll}>
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
      {state === 'error' ? <Alert severity="error">Store item update history could not be loaded.</Alert> : null}
      {traceError ? <Alert severity="error">{traceError}</Alert> : null}

      {job ? (
        <Paper variant="outlined">
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: {
                md: 'repeat(5, minmax(140px, 1fr))',
                sm: 'repeat(2, minmax(140px, 1fr))',
                xs: '1fr'
              },
              p: 2
            }}
          >
            <LogDetail label="Status" value={<Chip label={recordText(job, 'status', 'unknown')} size="small" />} />
            <LogDetail label="Store" value={storeName} />
            <LogDetail label="Started" value={recordText(job, 'started_at', '-')} />
            <LogDetail label="Scanned items" value={recordText(job, 'scanned_items', '0')} />
            <LogDetail label="Updated items" value={recordText(job, 'updated_items', '0')} />
          </Box>
        </Paper>
      ) : null}

      <Paper variant="outlined">
        <Stack
          alignItems="center"
          direction="row"
          justifyContent="space-between"
          sx={{ bgcolor: '#161b22', borderBottom: '1px solid #30363d', color: '#c9d1d9', px: 2, py: 1 }}
        >
          <Typography sx={{ fontFamily: 'monospace' }} variant="body2">
            Update trace
          </Typography>
          <FormControlLabel
            control={
              <Checkbox
                checked={isFollowingTrace}
                size="small"
                sx={{ color: '#8b949e', '&.Mui-checked': { color: '#58a6ff' } }}
                onChange={(event) => setIsFollowingTrace(event.target.checked)}
              />
            }
            label="Follow log"
            sx={{ m: 0, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
          />
        </Stack>
        <Box
          ref={traceConsoleRef}
          aria-label={`Update trace for run ${runId}`}
          role="log"
          sx={{
            bgcolor: '#0d1117',
            color: '#c9d1d9',
            fontFamily: 'Consolas, Monaco, monospace',
            fontSize: 13,
            lineHeight: 1.6,
            maxHeight: 420,
            minHeight: 220,
            overflow: 'auto',
            p: 2,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {formattedTrace || 'No update trace entries are available for this job yet.'}
        </Box>
      </Paper>

      {state === 'ready' ? (
        changes.length ? (
          <DataTable
            ariaLabel="Store item update history"
            columns={updateChangeColumns}
            defaultSortColumnId="created_at"
            defaultSortDirection="desc"
            getRowKey={(row, index) => recordText(row, 'id', String(index))}
            infiniteScroll={{
              hasMore,
              isLoading: isLoadingMore,
              loadedCount: changes.length,
              onLoadMore: loadMore,
              totalCount: totalRows
            }}
            minWidth={1780}
            rows={changes}
            serverSide
            tableState={table.tableState}
            onTableStateChange={table.handleTableStateChange}
          />
        ) : (
          <Paper variant="outlined" sx={{ p: 3 }}>
            <Typography color="text.secondary">No store item changes have been recorded for this store.</Typography>
          </Paper>
        )
      ) : null}

      <Typography color="text.secondary" variant="caption">
        Loads more changes as you scroll. The first page refreshes every 10 seconds; manual refresh returns to the newest changes.
      </Typography>
    </Stack>
  );
}

function LogDetail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Stack spacing={0.25} sx={{ minWidth: 140 }}>
      <Typography color="text.secondary" variant="caption">
        {label}
      </Typography>
      <Box>{value}</Box>
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

function changeEventLabel(row: AdminRecord): string {
  const fieldName = recordText(row, 'field_name');
  if (fieldName === 'store_active') {
    if (row.new_value === false || row.new_value === 'false') {
      return 'Item deactivated';
    }
    if (row.new_value === true || row.new_value === 'true') {
      return 'Item activated';
    }
  }

  const readableField = fieldName.replaceAll('_', ' ').trim();
  if (!readableField) {
    return 'Item updated';
  }
  return `${readableField.charAt(0).toUpperCase()}${readableField.slice(1)} changed`;
}

function formatTraceEntry(entry: StoreItemUpdateTraceEntry): string {
  const elapsed = typeof entry.payload.elapsed_ms === 'number' ? ` +${entry.payload.elapsed_ms}ms` : '';
  const message = typeof entry.payload.message === 'string' ? entry.payload.message : entry.event;
  const details = Object.fromEntries(
    Object.entries(entry.payload).filter(([key]) => key !== 'elapsed_ms' && key !== 'message')
  );
  const detailText = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  return `${entry.created_at}${elapsed}  ${message}${detailText}`.trim();
}
