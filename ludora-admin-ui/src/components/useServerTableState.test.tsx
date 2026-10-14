import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdminRecord, PagedRows, TableQuery } from '../api/client';
import { useInfiniteServerRows, useServerTableState } from './useServerTableState';

describe('useInfiniteServerRows', () => {
  it('restarts from page zero after resuming without duplicating rows or losing remaining pages', async () => {
    const fetchPage = vi.fn(async (query: TableQuery) => ({
      page: query.page,
      pageSize: 100,
      rows: [{ id: String(query.page + 1) }],
      total: 3
    }));
    const { result, rerender } = renderHook(({ enabled }) => {
      const table = useServerTableState('last_updated', 'desc');
      return { table, ...useInfiniteServerRows(table, fetchPage, { enabled }) };
    }, { initialProps: { enabled: true } });

    await waitFor(() => expect(result.current.rows).toEqual([{ id: '1' }]));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows).toEqual([{ id: '1' }, { id: '2' }]));
    expect(result.current.hasMore).toBe(true);

    rerender({ enabled: false });
    act(() => result.current.loadMore());
    expect(fetchPage).toHaveBeenCalledTimes(2);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.rows).toEqual([{ id: '1' }]));
    expect(fetchPage.mock.calls.map(([query]) => query.page)).toEqual([0, 1, 0]);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows).toEqual([{ id: '1' }, { id: '2' }]));
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]));
    expect(result.current.hasMore).toBe(false);
  });

  it('ignores an in-flight page invalidated by disabling after a fresh resume', async () => {
    let resolveStalePage!: (data: PagedRows<AdminRecord>) => void;
    let resolveFreshPage!: (data: PagedRows<AdminRecord>) => void;
    let requestedStalePage = false;
    let firstPageRequests = 0;
    const fetchPage = vi.fn(async (query: TableQuery): Promise<PagedRows<AdminRecord>> => {
      if (query.page === 1 && !requestedStalePage) {
        requestedStalePage = true;
        return new Promise((resolve) => { resolveStalePage = resolve; });
      }
      if (query.page === 0) {
        firstPageRequests += 1;
        if (firstPageRequests === 2) {
          return new Promise((resolve) => { resolveFreshPage = resolve; });
        }
      }
      return {
        page: query.page,
        pageSize: 100,
        rows: [{ id: String(query.page + 1), ...(query.page === 0 ? { version: firstPageRequests } : {}) }],
        total: 3
      };
    });
    const { result, rerender } = renderHook(({ enabled }) => {
      const table = useServerTableState('last_updated', 'desc');
      return { table, ...useInfiniteServerRows(table, fetchPage, { enabled }) };
    }, { initialProps: { enabled: true } });

    await waitFor(() => expect(result.current.rows).toEqual([{ id: '1', version: 1 }]));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.isLoadingMore).toBe(true));
    rerender({ enabled: false });
    expect(result.current.isLoadingMore).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    rerender({ enabled: true });
    await waitFor(() => expect(fetchPage.mock.calls.map(([query]) => query.page)).toEqual([0, 1, 0]));
    expect(result.current.state).toBe('loading');
    act(() => result.current.loadMore());
    expect(fetchPage).toHaveBeenCalledTimes(3);
    await act(async () => resolveFreshPage({ page: 0, pageSize: 100, rows: [{ id: '1', version: 2 }], total: 3 }));
    expect(result.current.rows).toEqual([{ id: '1', version: 2 }]);

    await act(async () => resolveStalePage({ page: 1, pageSize: 100, rows: [{ id: 'stale' }], total: 1 }));
    expect(result.current.rows).toEqual([{ id: '1', version: 2 }]);
    expect(result.current.totalRows).toBe(3);
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows).toEqual([{ id: '1', version: 2 }, { id: '2' }]));
  });

  it('does not fetch while disabled, including refresh and query changes, and loads when enabled', async () => {
    const fetchPage = vi.fn(async () => ({ page: 0, pageSize: 100, rows: [{ id: '920' }], total: 1 }));
    const { result, rerender } = renderHook(({ enabled }) => {
      const table = useServerTableState('last_updated', 'desc');
      return { table, ...useInfiniteServerRows(table, fetchPage, { enabled }) };
    }, { initialProps: { enabled: false } });

    expect(fetchPage).not.toHaveBeenCalled();
    act(() => result.current.table.refresh());
    act(() => result.current.table.handleTableStateChange({ filters: { title: 'cafe' }, sortColumnId: 'title', sortDirection: 'asc' }));
    expect(fetchPage).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.current.rows).toEqual([{ id: '920' }]);
  });

  it('preserves default loading, pagination append and refresh replacement', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ page: 0, pageSize: 100, rows: [{ id: '1' }], total: 2 })
      .mockResolvedValueOnce({ page: 1, pageSize: 100, rows: [{ id: '2' }], total: 2 })
      .mockResolvedValueOnce({ page: 0, pageSize: 100, rows: [{ id: '3' }], total: 1 });
    const { result } = renderHook(() => {
      const table = useServerTableState('last_updated', 'desc');
      return { table, ...useInfiniteServerRows(table, fetchPage) };
    });

    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.rows).toEqual([{ id: '1' }]));
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows).toEqual([{ id: '1' }, { id: '2' }]));
    expect(result.current.hasMore).toBe(false);
    expect(fetchPage.mock.calls[1][0]).toMatchObject({ page: 1, pageSize: 100, sortColumnId: 'last_updated', sortDirection: 'desc' });
    act(() => result.current.table.refresh());
    await waitFor(() => expect(result.current.rows).toEqual([{ id: '3' }]));
    expect(result.current.totalRows).toBe(1);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });
});
