import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationsPage } from './OperationsPage';

describe('OperationsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts store discovery and renders the returned summary', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return new Response(JSON.stringify({ data: null }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }
      if (url.endsWith('/admin/operations/store-discovery-runs') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              completed_at: '2026-05-25T20:01:00Z',
              error: null,
              id: 'run-1',
              result: {
                accepted_stores: 3,
                candidate_domains: 5,
                searched_queries: 2
              },
              started_at: '2026-05-25T20:00:00Z',
              status: 'completed',
              type: 'store_discovery'
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 202
          }
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OperationsPage />);

    await screen.findByText('No recent operation run.');
    await userEvent.click(screen.getByRole('button', { name: /Run Store Discovery/i }));

    expect(await screen.findByText('completed')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Filter Status'), 'completed');
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/store-discovery-runs', {
      method: 'POST'
    });
  });

  it('starts item update and renders the updated item count', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return new Response(JSON.stringify({ data: null }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }
      if (url.endsWith('/admin/operations/item-update-runs') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              completed_at: '2026-06-08T20:02:00Z',
              error: null,
              id: 'run-3',
              result: {
                updated_items: 8
              },
              started_at: '2026-06-08T20:00:00Z',
              status: 'completed',
              type: 'item_update'
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 202
          }
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OperationsPage />);

    await screen.findByText('No recent operation run.');
    await userEvent.click(screen.getByRole('button', { name: /Run Item Update/i }));

    expect(await screen.findByText('completed')).toBeInTheDocument();
    expect(screen.getByText('item_update')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/item-update-runs', {
      method: 'POST'
    });
  });

  it('renders failed operation errors in the operations table', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return new Response(
          JSON.stringify({
            data: {
              completed_at: '2026-06-04T06:43:56Z',
              error: 'relation "discovery_item_candidates" does not exist',
              id: 'run-failed',
              result: null,
              started_at: '2026-06-04T06:43:49Z',
              status: 'failed',
              type: 'item_discovery'
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OperationsPage />);

    expect(await screen.findByText('failed')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Error' })).toBeInTheDocument();
    expect(screen.getByText('relation "discovery_item_candidates" does not exist')).toBeInTheDocument();
  });
});
