import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useInfiniteServerRows, useServerTableState } from './useServerTableState';

describe('useInfiniteServerRows', () => {
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
