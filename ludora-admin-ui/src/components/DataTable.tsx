import {
  Box,
  Button,
  CircularProgress,
  Collapse,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
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
  useMediaQuery,
  useTheme,
  type SxProps,
  type Theme
} from '@mui/material';
import { type UIEvent, type ReactNode, useId, useMemo, useState } from 'react';

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
  mobilePreview?: boolean;
  minWidth?: number;
  render: (row: Row) => ReactNode;
  sortable?: boolean;
  sortValue?: (row: Row) => SortValue;
};

type DataTableProps<Row> = {
  ariaLabel: string;
  columns: DataTableColumn<Row>[];
  defaultSortColumnId?: string;
  defaultSortDirection?: SortDirection;
  getRowKey: (row: Row, index: number) => string;
  mobileActionLabel?: (row: Row) => string;
  minWidth?: number;
  onRowClick?: (row: Row) => void;
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
const MOBILE_PREVIEW_COLUMN_COUNT = 4;
const STICKY_HEADER_ROW_HEIGHT_PX = 42;

export function DataTable<Row>({
  ariaLabel,
  columns,
  defaultSortColumnId = '',
  defaultSortDirection = 'asc',
  getRowKey,
  mobileActionLabel,
  minWidth = 960,
  onRowClick,
  onRowDoubleClick,
  onTableStateChange,
  infiniteScroll,
  rows,
  serverSide = false,
  tableState
}: DataTableProps<Row>) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const mobileControlId = useId();
  const mobileFilterColumnLabelId = `${mobileControlId}-filter-column-label`;
  const mobileSortColumnLabelId = `${mobileControlId}-sort-column-label`;
  const mobileSortDirectionLabelId = `${mobileControlId}-sort-direction-label`;
  const [currentTableState, setCurrentTableState] = useState<DataTableState>(
    tableState ?? {
      filters: {},
      sortColumnId: defaultSortColumnId,
      sortDirection: defaultSortDirection
    }
  );
  const [expandedMobileRows, setExpandedMobileRows] = useState<Set<string>>(() => new Set());
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [mobileFilterColumnId, setMobileFilterColumnId] = useState(
    () => columns.find((column) => column.filterable !== false)?.id ?? ''
  );
  const { filters, sortColumnId, sortDirection } = currentTableState;
  const filterableColumns = columns.filter((column) => column.filterable !== false);
  const sortableColumns = columns.filter((column) => column.sortable !== false);
  const activeFilterCount = Object.values(filters).filter((value) => value.trim()).length;
  const activeMobileFilterColumnId = filterableColumns.some((column) => column.id === mobileFilterColumnId)
    ? mobileFilterColumnId
    : (filterableColumns[0]?.id ?? '');
  const prioritizedMobileColumns = useMemo(() => {
    const selectedIds = new Set(columns.filter((column) => column.mobilePreview).map((column) => column.id));
    const previewCount = Math.max(MOBILE_PREVIEW_COLUMN_COUNT, selectedIds.size);

    for (const column of columns) {
      if (selectedIds.size >= previewCount) {
        break;
      }
      selectedIds.add(column.id);
    }

    return {
      details: columns.filter((column) => !selectedIds.has(column.id)),
      preview: columns.filter((column) => selectedIds.has(column.id))
    };
  }, [columns]);

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
    const next = updater(currentTableState);
    setCurrentTableState(next);
    onTableStateChange?.(next);
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

  const hasRowAction = Boolean(onRowClick || onRowDoubleClick);

  return (
    <Paper variant="outlined" sx={{ maxWidth: '100%', overflow: 'hidden' }}>
      {isMobile ? (
        <Box>
          <Box sx={{ borderBottom: 1, borderColor: 'divider', p: 1.5 }}>
            <Button
              aria-expanded={mobileControlsOpen}
              fullWidth
              size="large"
              variant="outlined"
              onClick={() => setMobileControlsOpen((current) => !current)}
            >
              Filter and sort{activeFilterCount ? ` (${activeFilterCount})` : ''}
            </Button>
            <Collapse in={mobileControlsOpen}>
              <Stack spacing={1.5} sx={{ pt: 1.5 }}>
                {filterableColumns.length ? (
                  <>
                    <FormControl fullWidth size="small">
                      <InputLabel id={mobileFilterColumnLabelId}>Filter field</InputLabel>
                      <Select
                        label="Filter field"
                        labelId={mobileFilterColumnLabelId}
                        value={activeMobileFilterColumnId}
                        onChange={(event) => setMobileFilterColumnId(event.target.value)}
                      >
                        {filterableColumns.map((column) => (
                          <MenuItem key={column.id} value={column.id}>
                            {column.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <TextField
                      fullWidth
                      inputProps={{ 'aria-label': 'Filter value' }}
                      label={
                        filterableColumns.find((column) => column.id === activeMobileFilterColumnId)?.label ?? 'Filter'
                      }
                      size="small"
                      value={filters[activeMobileFilterColumnId] ?? ''}
                      onChange={(event) => handleFilterChange(activeMobileFilterColumnId, event.target.value)}
                    />
                  </>
                ) : null}
                {sortableColumns.length ? (
                  <Stack direction={{ sm: 'row', xs: 'column' }} spacing={1.5}>
                    <FormControl fullWidth size="small">
                      <InputLabel id={mobileSortColumnLabelId}>Sort by</InputLabel>
                      <Select
                        label="Sort by"
                        labelId={mobileSortColumnLabelId}
                        value={sortableColumns.some((column) => column.id === sortColumnId) ? sortColumnId : ''}
                        onChange={(event) => {
                          const nextColumn = sortableColumns.find((column) => column.id === event.target.value);
                          updateTableState((current) => ({
                            ...current,
                            sortColumnId: nextColumn?.id ?? '',
                            sortDirection: nextColumn && current.sortColumnId !== nextColumn.id ? 'asc' : current.sortDirection
                          }));
                        }}
                      >
                        <MenuItem value="">
                          <em>Default order</em>
                        </MenuItem>
                        {sortableColumns.map((column) => (
                          <MenuItem key={column.id} value={column.id}>
                            {column.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <FormControl fullWidth size="small">
                      <InputLabel id={mobileSortDirectionLabelId}>Direction</InputLabel>
                      <Select
                        label="Direction"
                        labelId={mobileSortDirectionLabelId}
                        value={sortDirection}
                        onChange={(event) => {
                          const nextDirection = event.target.value as SortDirection;
                          updateTableState((current) => ({ ...current, sortDirection: nextDirection }));
                        }}
                      >
                        <MenuItem value="asc">Ascending</MenuItem>
                        <MenuItem value="desc">Descending</MenuItem>
                      </Select>
                    </FormControl>
                  </Stack>
                ) : null}
                {activeFilterCount ? (
                  <Button
                    size="small"
                    onClick={() => updateTableState((current) => ({ ...current, filters: {} }))}
                  >
                    Clear all filters
                  </Button>
                ) : null}
              </Stack>
            </Collapse>
          </Box>
          <Stack
            aria-label={`${ariaLabel} cards`}
            component="div"
            role="list"
            spacing={1.5}
            sx={{
              maxHeight: infiniteScroll ? 'calc(100vh - 240px)' : undefined,
              overflowY: infiniteScroll ? 'auto' : undefined,
              p: 1.5,
              '@supports (height: 100dvh)': {
                maxHeight: infiniteScroll ? 'calc(100dvh - 240px)' : undefined
              }
            }}
            onScroll={handleScroll}
          >
            {visibleRows.length ? (
              visibleRows.map((row, index) => {
                const rowKey = getRowKey(row, index);
                const isExpanded = expandedMobileRows.has(rowKey);
                const previewColumns = prioritizedMobileColumns.preview;
                const detailColumns = prioritizedMobileColumns.details;

                return (
                  <Paper
                    component="article"
                    key={rowKey}
                    role="listitem"
                    variant="outlined"
                    sx={{ flexShrink: 0, overflow: 'hidden' }}
                  >
                    <Stack component="dl" spacing={1.25} sx={{ m: 0, p: 1.5 }}>
                      {previewColumns.map((column) => mobileField(column, row))}
                      <Collapse in={isExpanded}>
                        <Stack spacing={1.25}>{detailColumns.map((column) => mobileField(column, row))}</Stack>
                      </Collapse>
                      {detailColumns.length ? (
                        <Button
                          aria-expanded={isExpanded}
                          size="small"
                          onClick={() => {
                            setExpandedMobileRows((current) => {
                              const next = new Set(current);
                              if (next.has(rowKey)) {
                                next.delete(rowKey);
                              } else {
                                next.add(rowKey);
                              }
                              return next;
                            });
                          }}
                        >
                          {isExpanded ? 'Hide fields' : `Show ${detailColumns.length} more fields`}
                        </Button>
                      ) : null}
                      {hasRowAction ? (
                        <Button
                          aria-label={mobileActionLabel?.(row) ?? 'Open record'}
                          fullWidth
                          size="large"
                          variant="contained"
                          onClick={() => (onRowClick ?? onRowDoubleClick)?.(row)}
                        >
                          {mobileActionLabel?.(row) ?? 'Open record'}
                        </Button>
                      ) : null}
                    </Stack>
                  </Paper>
                );
              })
            ) : (
              <Typography color="text.secondary" role="status" variant="body2">
                No matching records.
              </Typography>
            )}
          </Stack>
        </Box>
      ) : (
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
                    hover={hasRowAction}
                    key={getRowKey(row, index)}
                    sx={hasRowAction ? { cursor: 'pointer' } : undefined}
                    onClick={() => onRowClick?.(row)}
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
      )}
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

function mobileField<Row>(column: DataTableColumn<Row>, row: Row) {
  return (
    <Box
      key={column.id}
      sx={{
        alignItems: 'start',
        display: 'grid',
        gap: 1,
        gridTemplateColumns: 'minmax(88px, 0.8fr) minmax(0, 1.4fr)'
      }}
    >
      <Typography color="text.secondary" component="dt" sx={{ fontSize: '0.75rem', fontWeight: 700 }}>
        {column.label}
      </Typography>
      <Box
        component="dd"
        sx={{
          m: 0,
          minWidth: 0,
          overflowWrap: 'anywhere',
          textAlign: column.align === 'right' ? 'right' : 'left',
          '& img': { maxWidth: '100%' },
          '& .MuiIconButton-root': { minHeight: 44, minWidth: 44 }
        }}
      >
        {column.render(row)}
      </Box>
    </Box>
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
