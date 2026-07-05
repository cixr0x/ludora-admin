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

    render(<OperationsPage operation="item_update" />);

    await screen.findByText('No recent operation run.');
    await userEvent.click(screen.getByRole('button', { name: /Run Item Update/i }));

    expect(await screen.findByText('completed')).toBeInTheDocument();
    expect(screen.getByText('item_update')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/item-update-runs', {
      method: 'POST'
    });
  });

  it('starts item embeddings for missing rows and renders the embedded count', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return new Response(JSON.stringify({ data: null }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }
      if (url.endsWith('/admin/operations/item-embedding-runs') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              completed_at: '2026-06-13T20:03:00Z',
              error: null,
              id: 'run-4',
              result: {
                embedded_items: 8,
                model: 'text-embedding-3-small',
                refresh_mode: 'missing',
                selected_items: 8
              },
              started_at: '2026-06-13T20:00:00Z',
              status: 'completed',
              type: 'item_embeddings'
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

    render(<OperationsPage operation="item_embeddings" />);

    await screen.findByText('No recent operation run.');
    await userEvent.click(screen.getByRole('button', { name: /Run Item Embeddings/i }));

    expect(await screen.findByText('completed')).toBeInTheDocument();
    expect(screen.getByText('item_embeddings')).toBeInTheDocument();
    expect(screen.getAllByText('8').length).toBeGreaterThan(0);
    expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/item-embedding-runs', {
      body: JSON.stringify({ refresh_mode: 'missing' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('starts a full item embedding refresh when full refresh is selected', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return new Response(JSON.stringify({ data: null }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }
      if (url.endsWith('/admin/operations/item-embedding-runs') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              completed_at: null,
              error: null,
              id: 'run-5',
              result: null,
              started_at: '2026-06-13T20:00:00Z',
              status: 'running',
              type: 'item_embeddings'
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

    render(<OperationsPage operation="item_embeddings" />);

    await screen.findByText('No recent operation run.');
    await userEvent.click(screen.getByRole('radio', { name: /Full refresh/i }));
    await userEvent.click(screen.getByRole('button', { name: /Run Item Embeddings/i }));

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/item-embedding-runs', {
      body: JSON.stringify({ refresh_mode: 'full' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('starts store item discovery for the requested store id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return new Response(JSON.stringify({ data: null }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }
      if (url.endsWith('/admin/operations/stores/12/item-discovery-runs') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              completed_at: '2026-06-08T20:02:00Z',
              error: null,
              id: 'run-2',
              result: {
                item_candidates: 4,
                store_id: 12,
                website_url: 'https://store.example'
              },
              started_at: '2026-06-08T20:00:00Z',
              status: 'completed',
              type: 'item_discovery'
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

    render(<OperationsPage operation="item_discovery" />);

    await screen.findByText('No recent operation run.');
    await userEvent.type(screen.getByLabelText('Store ID'), '12');
    await userEvent.click(screen.getByRole('button', { name: /Run Store Item Discovery/i }));

    expect(await screen.findByText('completed')).toBeInTheDocument();
    expect(screen.getByText('item_discovery')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/stores/12/item-discovery-runs', {
      method: 'POST'
    });
  });

  it('requires a store id before starting store item discovery', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return new Response(JSON.stringify({ data: null }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OperationsPage operation="item_discovery" />);

    await screen.findByText('No recent operation run.');
    await userEvent.click(screen.getByRole('button', { name: /Run Store Item Discovery/i }));

    expect(await screen.findByText('Store ID is required.')).toBeInTheDocument();
  });

  it('cancels a running operation from the operations page', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return new Response(
          JSON.stringify({
            data: {
              completed_at: null,
              error: null,
              id: 'run-active',
              result: null,
              started_at: '2026-06-27T08:00:00Z',
              status: 'running',
              type: 'item_discovery'
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }
      if (url.endsWith('/admin/operations/store-discovery-runs/run-active/cancel') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              completed_at: null,
              error: null,
              id: 'run-active',
              result: null,
              started_at: '2026-06-27T08:00:00Z',
              status: 'cancelling',
              type: 'item_discovery'
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

    await screen.findByText('running');
    await userEvent.click(screen.getByRole('button', { name: /Stop Operation/i }));

    expect(await screen.findByText('cancelling')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/store-discovery-runs/run-active/cancel', {
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
