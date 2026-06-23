import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AdminRecord, PagedRows, TableQuery } from '../api/client';
import type { DataTableState, SortDirection } from './DataTable';

const DEFAULT_ROWS_PER_PAGE = 100;
type ServerRowsLoadState = 'loading' | 'ready' | 'error';

export function useServerTableState(
  defaultSortColumnId: string,
  defaultSortDirection: SortDirection = 'asc',
  defaultFilters: Record<string, string> = {}
) {
  const [page, setPage] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [tableState, setTableState] = useState<DataTableState>({
    filters: defaultFilters,
    sortColumnId: defaultSortColumnId,
    sortDirection: defaultSortDirection
  });

  const query = useMemo<TableQuery>(
    () => ({
      filters: tableState.filters,
      page,
      pageSize: DEFAULT_ROWS_PER_PAGE,
      sortColumnId: tableState.sortColumnId,
      sortDirection: tableState.sortDirection
    }),
    [page, tableState]
  );

  return {
    handleLoadNextPage: () => {
      setPage((currentPage) => currentPage + 1);
    },
    page,
    query,
    refresh: () => {
      setPage(0);
      setRefreshToken((currentToken) => currentToken + 1);
    },
    refreshToken,
    tableState,
    handleTableStateChange: (nextTableState: DataTableState) => {
      setTableState(nextTableState);
      setPage(0);
    }
  };
}

type ServerTableControls = ReturnType<typeof useServerTableState>;

export function useInfiniteServerRows<Row extends AdminRecord>(
  table: ServerTableControls,
  fetchPage: (query: TableQuery) => Promise<PagedRows<Row>>
) {
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<ServerRowsLoadState>('loading');
  const [totalRows, setTotalRows] = useState(0);
  const loadMoreRequestedRef = useRef(false);

  useEffect(() => {
    let ignore = false;
    const isLoadingNextPage = table.page > 0;

    if (isLoadingNextPage) {
      setIsLoadingMore(true);
    } else {
      loadMoreRequestedRef.current = false;
      setState((current) => (current === 'ready' ? current : 'loading'));
    }

    fetchPage(table.query)
      .then((data) => {
        if (!ignore) {
          setRows((currentRows) => (isLoadingNextPage ? [...currentRows, ...data.rows] : data.rows));
          setTotalRows(data.total);
          setState('ready');
        }
      })
      .catch(() => {
        if (!ignore) {
          setState('error');
        }
      })
      .finally(() => {
        if (!ignore) {
          loadMoreRequestedRef.current = false;
          setIsLoadingMore(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [fetchPage, table.page, table.query, table.refreshToken]);

  const hasMore = rows.length < totalRows;
  const loadMore = useCallback(() => {
    if (loadMoreRequestedRef.current || isLoadingMore || state !== 'ready' || !hasMore) {
      return;
    }

    loadMoreRequestedRef.current = true;
    table.handleLoadNextPage();
  }, [hasMore, isLoadingMore, state, table]);

  return {
    hasMore,
    isLoadingMore,
    loadMore,
    rows,
    setRows,
    setTotalRows,
    state,
    totalRows
  };
}
