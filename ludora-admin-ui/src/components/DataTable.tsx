import {
  Box,
  CircularProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  type TableCellProps,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Typography,
  type SxProps,
  type Theme
} from '@mui/material';
import { type UIEvent, type ReactNode, useMemo, useState } from 'react';

export type SortDirection = 'asc' | 'desc';
type SortValue = boolean | number | string | null | undefined;

export type DataTableState = {
  filters: Record<string, string>;
  sortColumnId: string;
  sortDirection: SortDirection;
};

export type DataTableColumn<Row> = {
  align?: TableCellProps['align'];
  cellSx?: SxProps<Theme>;
  filterValue?: (row: Row) => SortValue;
  filterable?: boolean;
  id: string;
  label: string;
  minWidth?: number;
  render: (row: Row) => ReactNode;
  sortable?: boolean;
  sortValue?: (row: Row) => SortValue;
};

type DataTableProps<Row> = {
  ariaLabel: string;
  columns: DataTableColumn<Row>[];
  defaultSortColumnId?: string;
  getRowKey: (row: Row, index: number) => string;
  minWidth?: number;
  onRowDoubleClick?: (row: Row) => void;
  onTableStateChange?: (state: DataTableState) => void;
  infiniteScroll?: {
    hasMore: boolean;
    isLoading: boolean;
    loadedCount: number;
    onLoadMore: () => void;
    totalCount: number;
  };
  rows: Row[];
  serverSide?: boolean;
  tableState?: DataTableState;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const LOAD_MORE_DISTANCE_PX = 240;
const STICKY_HEADER_ROW_HEIGHT_PX = 42;

export function DataTable<Row>({
  ariaLabel,
  columns,
  defaultSortColumnId = '',
  getRowKey,
  minWidth = 960,
  onRowDoubleClick,
  onTableStateChange,
  infiniteScroll,
  rows,
  serverSide = false,
  tableState
}: DataTableProps<Row>) {
  const [currentTableState, setCurrentTableState] = useState<DataTableState>(
    tableState ?? {
      filters: {},
      sortColumnId: defaultSortColumnId,
      sortDirection: 'asc'
    }
  );
  const { filters, sortColumnId, sortDirection } = currentTableState;

  const visibleRows = useMemo(() => {
    if (serverSide) {
      return rows;
    }

    const filteredRows = rows.filter((row) =>
      columns.every((column) => {
        const filter = filters[column.id]?.trim().toLocaleLowerCase();
        if (!filter || column.filterable === false) {
          return true;
        }

        return filterText(column, row).includes(filter);
      })
    );

    const activeColumn = columns.find((column) => column.id === sortColumnId);
    if (!activeColumn || activeColumn.sortable === false) {
      return filteredRows;
    }

    return [...filteredRows].sort((left, right) => {
      const comparison = compareValues(sortValue(activeColumn, left), sortValue(activeColumn, right));
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [columns, filters, rows, serverSide, sortColumnId, sortDirection]);

  function handleSort(column: DataTableColumn<Row>) {
    if (column.sortable === false) {
      return;
    }

    if (sortColumnId === column.id) {
      updateTableState((current) => ({
        ...current,
        sortDirection: current.sortDirection === 'asc' ? 'desc' : 'asc'
      }));
      return;
    }

    updateTableState((current) => ({
      ...current,
      sortColumnId: column.id,
      sortDirection: 'asc'
    }));
  }

  function handleFilterChange(columnId: string, value: string) {
    updateTableState((current) => ({
      ...current,
      filters: {
        ...current.filters,
        [columnId]: value
      }
    }));
  }

  function updateTableState(updater: (current: DataTableState) => DataTableState) {
    setCurrentTableState((current) => {
      const next = updater(current);
      onTableStateChange?.(next);
      return next;
    });
  }

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    if (!infiniteScroll?.hasMore || infiniteScroll.isLoading) {
      return;
    }

    const { clientHeight, scrollHeight, scrollTop } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight <= LOAD_MORE_DISTANCE_PX) {
      infiniteScroll.onLoadMore();
    }
  }

  return (
    <Paper variant="outlined" sx={{ maxWidth: '100%', overflow: 'hidden' }}>
      <TableContainer
        aria-label={`${ariaLabel} scroll area`}
        sx={{
          maxHeight: infiniteScroll ? 'calc(100vh - 260px)' : undefined,
          maxWidth: '100%',
          overflow: infiniteScroll ? 'auto' : undefined,
          overflowX: 'auto'
        }}
        onScroll={handleScroll}
      >
        <Table aria-label={ariaLabel} size="small" stickyHeader={Boolean(infiniteScroll)} sx={{ minWidth }}>
          <TableHead>
            <TableRow>
              {columns.map((column) => {
                const isActive = sortColumnId === column.id && column.sortable !== false;

                return (
                  <TableCell
                    align={column.align}
                    key={column.id}
                    sortDirection={isActive ? sortDirection : false}
                    sx={[
                      { minWidth: column.minWidth },
                      infiniteScroll
                        ? {
                            bgcolor: 'background.paper',
                            height: STICKY_HEADER_ROW_HEIGHT_PX,
                            top: 0,
                            zIndex: 4
                          }
                        : null
                    ]}
                  >
                    {column.sortable === false ? (
                      column.label
                    ) : (
                      <TableSortLabel
                        active={isActive}
                        direction={isActive ? sortDirection : 'asc'}
                        hideSortIcon={false}
                        onClick={() => handleSort(column)}
                        sx={{
                          '& .MuiTableSortLabel-icon': {
                            opacity: isActive ? 1 : 0.35
                          }
                        }}
                      >
                        {column.label}
                      </TableSortLabel>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
            <TableRow>
              {columns.map((column) => (
                <TableCell
                  align={column.align}
                  key={`${column.id}-filter`}
                  sx={[
                    { minWidth: column.minWidth },
                    infiniteScroll
                      ? {
                          bgcolor: 'background.paper',
                          top: STICKY_HEADER_ROW_HEIGHT_PX,
                          zIndex: 3
                        }
                      : null
                  ]}
                >
                  {column.filterable === false ? null : (
                    <TextField
                      fullWidth
                      inputProps={{ 'aria-label': `Filter ${column.label}` }}
                      placeholder="Filter"
                      size="small"
                      value={filters[column.id] ?? ''}
                      variant="standard"
                      onChange={(event) => {
                        handleFilterChange(column.id, event.target.value);
                      }}
                    />
                  )}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {visibleRows.length > 0 ? (
              visibleRows.map((row, index) => (
                <TableRow
                  hover={Boolean(onRowDoubleClick)}
                  key={getRowKey(row, index)}
                  sx={onRowDoubleClick ? { cursor: 'pointer' } : undefined}
                  onDoubleClick={() => onRowDoubleClick?.(row)}
                >
                  {columns.map((column) => (
                    <TableCell align={column.align} key={column.id} sx={column.cellSx}>
                      {column.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  <Typography color="text.secondary" variant="body2">
                    No matching records.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {infiniteScroll ? (
        <Box
          sx={{
            alignItems: 'center',
            borderTop: 1,
            borderColor: 'divider',
            display: 'flex',
            gap: 1,
            justifyContent: 'space-between',
            minHeight: 42,
            px: 2,
            py: 1
          }}
        >
          <Typography color="text.secondary" variant="body2">
            {infiniteScroll.loadedCount} / {infiniteScroll.totalCount}
          </Typography>
          {infiniteScroll.isLoading ? <CircularProgress size={18} /> : null}
        </Box>
      ) : null}
    </Paper>
  );
}

function filterText<Row>(column: DataTableColumn<Row>, row: Row) {
  const value = column.filterValue ? column.filterValue(row) : sortValue(column, row);
  return stringify(value).toLocaleLowerCase();
}

function sortValue<Row>(column: DataTableColumn<Row>, row: Row) {
  return column.sortValue ? column.sortValue(row) : column.filterValue?.(row);
}

function compareValues(left: SortValue, right: SortValue) {
  const leftText = stringify(left);
  const rightText = stringify(right);

  if (!leftText && rightText) {
    return 1;
  }
  if (leftText && !rightText) {
    return -1;
  }

  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return collator.compare(leftText, rightText);
}

function stringify(value: SortValue) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}
