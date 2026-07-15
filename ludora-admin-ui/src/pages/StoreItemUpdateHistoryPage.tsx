import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Alert, Button, CircularProgress, Link, Paper, Stack, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, type AdminRecord, type TableQuery } from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { useInfiniteServerRows, useServerTableState } from '../components/useServerTableState';

const REFRESH_INTERVAL_MS = 10_000;

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

  const storeName = recordText(job, 'store_name', 'Multiple stores');

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
          <Button startIcon={<RefreshIcon />} variant="contained" onClick={table.refresh}>
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
