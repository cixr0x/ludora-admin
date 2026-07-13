import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreItemUpdateHistoryPage } from './StoreItemUpdateHistoryPage';

describe('StoreItemUpdateHistoryPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows store-scoped changes newest first and schedules a ten-second refresh', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            changes: [
              {
                created_at: '2026-07-11T20:03:00Z',
                field_name: 'store_active',
                id: 92,
                new_value: false,
                old_value: true,
                run_id: 'run-update-27',
                store_item_id: 503,
                store_item_title: 'Azul',
                store_name: 'Alpha Games'
              },
              {
                created_at: '2026-07-11T20:02:00Z',
                field_name: 'price',
                id: 91,
                new_value: 799,
                old_value: 899,
                run_id: 'run-update-27',
                store_item_id: 502,
                store_item_title: 'Catan',
                store_name: 'Alpha Games'
              },
              {
                created_at: '2026-07-11T20:00:00Z',
                field_name: 'availability',
                id: 90,
                new_value: 'in_stock',
                old_value: 'unknown',
                run_id: 'older-run',
                store_item_id: 501,
                store_item_title: 'Coffee Rush',
                store_name: 'Alpha Games'
              }
            ],
            job: {
              id: 27,
              run_id: 'run-update-27',
              status: 'running',
              store_id: 12,
              store_name: 'Alpha Games'
            }
          },
          meta: { page: 0, page_size: 100, total: 3 }
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      )
    );

    const view = render(<StoreItemUpdateHistoryPage runId="run-update-27" onBack={() => undefined} />);

    expect(await screen.findByRole('table', { name: 'Store item update history' })).toBeInTheDocument();
    const dataRows = screen.getAllByRole('row').slice(2);
    expect(within(dataRows[0]).getByText('Azul')).toBeInTheDocument();
    expect(within(dataRows[0]).getByText('Item deactivated')).toBeInTheDocument();
    expect(within(dataRows[0]).getByText('store_active')).toBeInTheDocument();
    expect(within(dataRows[1]).getByText('Catan')).toBeInTheDocument();
    expect(within(dataRows[2]).getByText('Coffee Rush')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '502' })).toHaveAttribute('href', '#listings?id=502');
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4001/admin/operations/store-item-update-jobs/run-update-27/changes?page=0&page_size=100&sort=created_at&sort_direction=desc',
      { credentials: 'include' }
    );

    view.unmount();
  });

  it('appends the next history page when the table scrolls near the bottom', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const page = new URL(String(input)).searchParams.get('page');
      const changes =
        page === '1'
          ? [
              {
                created_at: '2026-07-11T20:00:00Z',
                field_name: 'availability',
                id: 90,
                new_value: 'available',
                old_value: 'unknown',
                run_id: 'run-update-27',
                store_item_id: 501,
                store_item_title: 'Second Page Item',
                store_name: 'Alpha Games'
              }
            ]
          : [
              {
                created_at: '2026-07-11T20:01:00Z',
                field_name: 'price',
                id: 91,
                new_value: 799,
                old_value: 899,
                run_id: 'run-update-27',
                store_item_id: 502,
                store_item_title: 'First Page Item',
                store_name: 'Alpha Games'
              }
            ];

      return new Response(
        JSON.stringify({
          data: {
            changes,
            job: { id: 27, run_id: 'run-update-27', store_id: 12, store_name: 'Alpha Games' }
          },
          meta: { page: Number(page ?? 0), page_size: 100, total: 2 }
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      );
    });

    render(<StoreItemUpdateHistoryPage runId="run-update-27" onBack={() => undefined} />);

    expect(await screen.findByText('First Page Item')).toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();

    const scrollArea = screen.getByLabelText('Store item update history scroll area');
    Object.defineProperty(scrollArea, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scrollArea, 'scrollTop', { configurable: true, value: 620 });
    fireEvent.scroll(scrollArea);

    expect(await screen.findByText('Second Page Item')).toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:4001/admin/operations/store-item-update-jobs/run-update-27/changes?page=1&page_size=100&sort=created_at&sort_direction=desc',
      { credentials: 'include' }
    );

    const refreshCallback = setIntervalSpy.mock.calls[0]?.[0];
    if (typeof refreshCallback === 'function') {
      refreshCallback();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
