import { Alert, Box, CircularProgress, Stack, Typography } from '@mui/material';
import { adminApi, type AdminRecord } from '../api/client';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { useInfiniteServerRows, useServerTableState } from '../components/useServerTableState';

function read(record: AdminRecord, keys: string[], fallback = '-') {
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  return value === undefined ? fallback : String(value);
}

const reviewTaskColumns: DataTableColumn<AdminRecord>[] = [
  {
    filterValue: (row) => read(row, ['task_type', 'type', 'title']),
    id: 'task',
    label: 'Task',
    minWidth: 180,
    render: (row) => read(row, ['task_type', 'type', 'title']),
    sortValue: (row) => read(row, ['task_type', 'type', 'title'])
  },
  {
    filterValue: (row) => read(row, ['entity_type', 'entity_id']),
    id: 'entity',
    label: 'Entity',
    minWidth: 180,
    render: (row) => read(row, ['entity_type', 'entity_id']),
    sortValue: (row) => read(row, ['entity_type', 'entity_id'])
  },
  {
    filterValue: (row) => read(row, ['status', 'state']),
    id: 'status',
    label: 'Status',
    minWidth: 130,
    render: (row) => read(row, ['status', 'state']),
    sortValue: (row) => read(row, ['status', 'state'])
  },
  {
    filterValue: (row) => read(row, ['updated_at', 'created_at']),
    id: 'updated',
    label: 'Updated',
    minWidth: 190,
    render: (row) => read(row, ['updated_at', 'created_at']),
    sortValue: (row) => read(row, ['updated_at', 'created_at'])
  }
];

export function ReviewTasksPage() {
  const table = useServerTableState('updated', 'desc');
  const { hasMore, isLoadingMore, loadMore, rows, state, totalRows } = useInfiniteServerRows(
    table,
    adminApi.getReviewTasksPage
  );

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700 }}>
          Review Tasks
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Admin review queue ordered by latest activity.
        </Typography>
      </Box>

      {state === 'loading' ? (
        <Stack alignItems="center" direction="row" spacing={1.5}>
          <CircularProgress size={18} />
          <Typography variant="body2">Loading review tasks</Typography>
        </Stack>
      ) : null}

      {state === 'error' ? <Alert severity="error">Review tasks could not be loaded.</Alert> : null}

      {state === 'ready' ? (
        <DataTable
          ariaLabel="Review tasks"
          columns={reviewTaskColumns}
          getRowKey={(row, index) => read(row, ['id'], String(index))}
          minWidth={680}
          serverSide
          tableState={table.tableState}
          onTableStateChange={table.handleTableStateChange}
          infiniteScroll={{
            hasMore,
            isLoading: isLoadingMore,
            loadedCount: rows.length,
            onLoadMore: loadMore,
            totalCount: totalRows
          }}
          rows={rows}
        />
      ) : null}
    </Stack>
  );
}
