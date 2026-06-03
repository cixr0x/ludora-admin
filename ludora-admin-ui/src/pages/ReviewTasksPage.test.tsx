import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewTasksPage } from './ReviewTasksPage';

describe('ReviewTasksPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sorts and filters review tasks', async () => {
    const user = userEvent.setup();
    const storeTask = {
      entity_id: 'store-2',
      id: 'task-2',
      status: 'closed',
      task_type: 'store_candidate',
      updated_at: '2026-05-25T11:00:00.000Z'
    };
    const listingTask = {
      entity_id: 'listing-1',
      id: 'task-1',
      status: 'open',
      task_type: 'listing_candidate',
      updated_at: '2026-05-25T10:00:00.000Z'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const rows = url.includes('filter_status=')
        ? [listingTask]
        : url.includes('sort=task')
          ? [listingTask, storeTask]
          : [storeTask, listingTask];

      return new Response(
        JSON.stringify({
          data: rows,
          meta: { page: 0, page_size: 100, total: rows.length }
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        }
      );
    });

    render(<ReviewTasksPage />);

    expect(await screen.findByText('store_candidate')).toBeInTheDocument();
    expect(screen.getByText('listing_candidate')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Task' }));

    await waitFor(() => {
      const firstDataRow = screen.getAllByRole('row')[2];
      expect(firstDataRow).toHaveTextContent('listing_candidate');
    });

    await user.type(screen.getByLabelText('Filter Status'), 'open');

    await waitFor(() => {
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('filter_status=open');
    });
    expect(screen.queryByText('store_candidate')).not.toBeInTheDocument();
    expect(screen.getByText('listing_candidate')).toBeInTheDocument();
  });
});
