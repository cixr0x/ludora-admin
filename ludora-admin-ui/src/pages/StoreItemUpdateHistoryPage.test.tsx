import { render, screen, within } from '@testing-library/react';
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
                created_at: '2026-07-11T20:00:00Z',
                field_name: 'availability',
                id: 90,
                new_value: 'in_stock',
                old_value: 'unknown',
                run_id: 'older-run',
                store_item_id: 501,
                store_item_title: 'Coffee Rush',
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
              }
            ],
            job: {
              id: 27,
              run_id: 'run-update-27',
              status: 'running',
              store_id: 12,
              store_name: 'Alpha Games'
            }
          }
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      )
    );

    const view = render(<StoreItemUpdateHistoryPage runId="run-update-27" onBack={() => undefined} />);

    expect(await screen.findByRole('table', { name: 'Store item update history' })).toBeInTheDocument();
    const dataRows = screen.getAllByRole('row').slice(2);
    expect(within(dataRows[0]).getByText('Catan')).toBeInTheDocument();
    expect(within(dataRows[1]).getByText('Coffee Rush')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '502' })).toHaveAttribute('href', '#listings?id=502');
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4001/admin/operations/store-item-update-jobs/run-update-27/changes',
      { credentials: 'include' }
    );

    view.unmount();
  });
});
