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
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/operations/store-discovery-runs', {
      credentials: 'include',
      method: 'POST'
    });
  });

  it('starts item update for all stores and refreshes the update job log table', async () => {
    let jobRequests = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return new Response(JSON.stringify({ data: null }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }
      if (url.endsWith('/stores')) {
        return new Response(JSON.stringify({ data: [] }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }
      if (isStoreItemUpdateJobsUrl(url)) {
        jobRequests += 1;
        return jsonResponse({
          data:
            jobRequests > 1
              ? [
                  {
                    completed_at: '2026-06-08T20:02:00Z',
                    error: '',
                    id: 80,
                    run_id: 'run-3',
                    scanned_items: 12,
                    started_at: '2026-06-08T20:00:00Z',
                    status: 'completed',
                    updated_items: 8
                  }
                ]
              : [],
          meta: {
            page: 0,
            page_size: 100,
            total: jobRequests > 1 ? 1 : 0
          }
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

    await screen.findByRole('table', { name: /Store item update jobs/i });
    await userEvent.click(screen.getByRole('button', { name: /Run for all/i }));

    expect(await screen.findByText('run-3')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/operations/item-update-runs', {
      body: JSON.stringify({ all_stores: true }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('starts item update for selected stores from the checkbox list and refreshes the update job log table', async () => {
    let jobRequests = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return jsonResponse({ data: null });
      }
      if (url.endsWith('/stores')) {
        return jsonResponse({
          data: [
            {
              canonical_domain: 'alpha.mx',
              id: 12,
              name: 'Alpha Games',
              platform: 'shopify',
              website_url: 'https://alpha.mx/'
            },
            {
              canonical_domain: 'beta.mx',
              id: 34,
              name: 'Beta Games',
              platform: 'custom',
              website_url: 'https://beta.mx/'
            }
          ]
        });
      }
      if (isStoreItemUpdateJobsUrl(url)) {
        jobRequests += 1;
        return jsonResponse({
          data:
            jobRequests > 1
              ? [
                  {
                    completed_at: '2026-07-05T20:02:00Z',
                    error: '',
                    id: 30,
                    run_id: 'run-selected',
                    scanned_items: 9,
                    started_at: '2026-07-05T20:00:00Z',
                    status: 'completed',
                    updated_items: 3
                  }
                ]
              : [],
          meta: {
            page: 0,
            page_size: 100,
            total: jobRequests > 1 ? 1 : 0
          }
        });
      }
      if (url.endsWith('/admin/operations/item-update-runs') && init?.method === 'POST') {
        return jsonResponse(
          {
            data: {
              completed_at: '2026-07-05T20:02:00Z',
              error: null,
              id: 'run-selected',
              result: {
                updated_items: 3
              },
              started_at: '2026-07-05T20:00:00Z',
              status: 'completed',
              type: 'item_update'
            }
          },
          202
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OperationsPage operation="item_update" />);

    await screen.findByText('Alpha Games');
    await userEvent.click(screen.getByRole('checkbox', { name: /Alpha Games/i }));
    await userEvent.click(screen.getByRole('button', { name: /Run for selected stores/i }));

    expect(await screen.findByText('run-selected')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/operations/item-update-runs', {
      body: JSON.stringify({ store_ids: [12] }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('disables selected-store item update until at least one store is selected', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return jsonResponse({ data: null });
      }
      if (url.endsWith('/stores')) {
        return jsonResponse({
          data: [
            {
              canonical_domain: 'alpha.mx',
              id: 12,
              name: 'Alpha Games',
              platform: 'shopify',
              website_url: 'https://alpha.mx/'
            }
          ]
        });
      }
      if (isStoreItemUpdateJobsUrl(url)) {
        return emptyPagedRows();
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OperationsPage operation="item_update" />);

    await screen.findByText('Alpha Games');
    expect(screen.getByRole('button', { name: /Run for selected stores/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /Alpha Games/i }));
    expect(screen.getByRole('button', { name: /Run for selected stores/i })).toBeEnabled();
  });

  it('keeps run for all available when the store list fails to load', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return jsonResponse({ data: null });
      }
      if (url.endsWith('/stores')) {
        return new Response(JSON.stringify({ error: { message: 'store load failed' } }), {
          headers: { 'Content-Type': 'application/json' },
          status: 500
        });
      }
      if (isStoreItemUpdateJobsUrl(url)) {
        return emptyPagedRows();
      }
      if (url.endsWith('/admin/operations/item-update-runs') && init?.method === 'POST') {
        return jsonResponse(
          {
            data: {
              completed_at: null,
              error: null,
              id: 'run-all',
              result: null,
              started_at: '2026-07-05T20:00:00Z',
              status: 'running',
              type: 'item_update'
            }
          },
          202
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OperationsPage operation="item_update" />);

    expect(await screen.findByText('Stores could not be loaded for selection.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run for selected stores/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /Run for all/i }));

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/operations/item-update-runs', {
      body: JSON.stringify({ all_stores: true }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('renders store item discovery job logs instead of unrelated operation result columns', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return jsonResponse({ data: null });
      }
      if (isStoreItemDiscoveryJobsUrl(url)) {
        return jsonResponse({
          data: [
            {
              completed_at: '2026-07-05T20:03:00Z',
              error: '',
              id: 19,
              new_items: 7,
              run_id: 'run-discovery-19',
              started_at: '2026-07-05T20:00:00Z',
              status: 'completed',
              store_id: 12,
              website_url: 'https://store.example'
            }
          ],
          meta: {
            page: 0,
            page_size: 100,
            total: 1
          }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OperationsPage operation="item_discovery" />);

    expect(await screen.findByText('run-discovery-19')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Store ID' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Website URL' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'New items' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Accepted stores' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Embedding model' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4001/admin/operations/store-item-discovery-jobs?page=0&page_size=100&sort=started_at&sort_direction=desc',
      { credentials: 'include' }
    );
  });

  it('renders store item update job logs instead of unrelated operation result columns', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return jsonResponse({ data: null });
      }
      if (url.endsWith('/stores')) {
        return jsonResponse({ data: [] });
      }
      if (isStoreItemUpdateJobsUrl(url)) {
        return jsonResponse({
          data: [
            {
              completed_at: '2026-07-05T21:04:00Z',
              error: '',
              id: 27,
              run_id: 'run-update-27',
              scanned_items: 18,
              started_at: '2026-07-05T21:00:00Z',
              status: 'completed',
              store_id: 12,
              updated_items: 5
            }
          ],
          meta: {
            page: 0,
            page_size: 100,
            total: 1
          }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OperationsPage operation="item_update" />);

    expect(await screen.findByText('run-update-27')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Store ID' })).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Scanned items' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Updated items' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Candidate domains' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Selected embeddings' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4001/admin/operations/store-item-update-jobs?page=0&page_size=100&sort=started_at&sort_direction=desc',
      { credentials: 'include' }
    );
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
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/operations/item-embedding-runs', {
      body: JSON.stringify({ refresh_mode: 'missing' }),
      credentials: 'include',
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

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/operations/item-embedding-runs', {
      body: JSON.stringify({ refresh_mode: 'full' }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('runs external cover image optimization and renders the returned summary', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return jsonResponse({ data: null });
      }
      if (url.endsWith('/admin/operations/external-cover-image-optimizations') && init?.method === 'POST') {
        return jsonResponse(
          {
            data: {
              failures: [
                {
                  error: 'Could not download image: 404 Not Found',
                  field: 'image_url_es',
                  itemId: 88,
                  sourceUrl: 'https://cdn.example/missing.jpg'
                }
              ],
              optimized: [
                {
                  applied: true,
                  field: 'image_url',
                  itemId: 77,
                  newName: '77-coffeerush.en.webp',
                  optimizedSizeBytes: 84210,
                  originalSizeBytes: 180000,
                  publicUrl: 'https://ludora.s3.us-east-2.amazonaws.com/boardgame/77-coffeerush.en.webp',
                  s3Key: 'boardgame/77-coffeerush.en.webp',
                  sourceName: 'coffee.jpg',
                  sourceUrl: 'https://cf.geekdo-images.com/coffee.jpg'
                }
              ],
              skipped: [],
              summary: {
                downloadedImages: 1,
                failedImages: 1,
                imageFields: 4,
                itemsScanned: 2,
                optimizedImages: 1,
                skippedBlank: 0,
                skippedManaged: 0,
                skippedWithinLimit: 0,
                updatedRows: 1,
                uploadedImages: 1
              }
            }
          },
          202
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OperationsPage operation="image_optimization" />);

    await screen.findByRole('button', { name: /Optimize External Cover Images/i });
    await userEvent.click(screen.getByRole('button', { name: /Optimize External Cover Images/i }));

    expect(await screen.findByText('Image optimization summary')).toBeInTheDocument();
    expect(screen.getByText('Items scanned')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Optimized images')).toBeInTheDocument();
    expect(screen.getByText('Updated rows')).toBeInTheDocument();
    expect(screen.getByText('Could not download image: 404 Not Found')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/operations/external-cover-image-optimizations', {
      credentials: 'include',
      method: 'POST'
    });
  });

  it('starts store item discovery for all stores and refreshes the discovery job log table', async () => {
    let jobRequests = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return jsonResponse({ data: null });
      }
      if (url.endsWith('/stores')) {
        return jsonResponse({ data: [] });
      }
      if (isStoreItemDiscoveryJobsUrl(url)) {
        jobRequests += 1;
        return jsonResponse({
          data:
            jobRequests > 1
              ? [
                  {
                    completed_at: '2026-06-08T20:02:00Z',
                    error: '',
                    id: 40,
                    new_items: 4,
                    run_id: 'run-2',
                    started_at: '2026-06-08T20:00:00Z',
                    status: 'completed',
                    store_id: 12,
                    website_url: 'https://store.example'
                  }
                ]
              : [],
          meta: {
            page: 0,
            page_size: 100,
            total: jobRequests > 1 ? 1 : 0
          }
        });
      }
      if (url.endsWith('/admin/operations/item-discovery-runs') && init?.method === 'POST') {
        return jsonResponse(
          {
            data: {
              completed_at: '2026-06-08T20:02:00Z',
              error: null,
              id: 'run-2',
              result: {
                item_candidates: 4,
                new_items: 4,
                store_id: null,
                stores_scanned: 2,
                website_url: ''
              },
              started_at: '2026-06-08T20:00:00Z',
              status: 'completed',
              type: 'item_discovery'
            }
          },
          202
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OperationsPage operation="item_discovery" />);

    await screen.findByRole('table', { name: /Store item discovery jobs/i });
    await userEvent.click(screen.getByRole('button', { name: /Run for all/i }));

    expect(await screen.findByText('run-2')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/operations/item-discovery-runs', {
      body: JSON.stringify({ all_stores: true }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('starts store item discovery for selected stores from the checkbox list and refreshes the discovery job log table', async () => {
    let jobRequests = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return jsonResponse({ data: null });
      }
      if (url.endsWith('/stores')) {
        return jsonResponse({
          data: [
            {
              canonical_domain: 'alpha.mx',
              id: 12,
              name: 'Alpha Games',
              platform: 'shopify',
              website_url: 'https://alpha.mx/'
            },
            {
              canonical_domain: 'beta.mx',
              id: 34,
              name: 'Beta Games',
              platform: 'custom',
              website_url: 'https://beta.mx/'
            }
          ]
        });
      }
      if (isStoreItemDiscoveryJobsUrl(url)) {
        jobRequests += 1;
        return jsonResponse({
          data:
            jobRequests > 1
              ? [
                  {
                    completed_at: '2026-07-05T20:02:00Z',
                    error: '',
                    id: 31,
                    new_items: 5,
                    run_id: 'run-discovery-selected',
                    started_at: '2026-07-05T20:00:00Z',
                    status: 'completed',
                    store_id: 12,
                    website_url: 'https://alpha.mx/'
                  }
                ]
              : [],
          meta: {
            page: 0,
            page_size: 100,
            total: jobRequests > 1 ? 1 : 0
          }
        });
      }
      if (url.endsWith('/admin/operations/item-discovery-runs') && init?.method === 'POST') {
        return jsonResponse(
          {
            data: {
              completed_at: '2026-07-05T20:02:00Z',
              error: null,
              id: 'run-discovery-selected',
              result: {
                item_candidates: 5,
                new_items: 5,
                store_id: null,
                stores_scanned: 1,
                website_url: ''
              },
              started_at: '2026-07-05T20:00:00Z',
              status: 'completed',
              type: 'item_discovery'
            }
          },
          202
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OperationsPage operation="item_discovery" />);

    await screen.findByText('Alpha Games');
    await userEvent.click(screen.getByRole('checkbox', { name: /Alpha Games/i }));
    await userEvent.click(screen.getByRole('button', { name: /Run for selected stores/i }));

    expect(await screen.findByText('run-discovery-selected')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/operations/item-discovery-runs', {
      body: JSON.stringify({ store_ids: [12] }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('disables selected-store item discovery until at least one store is selected', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/admin/operations/store-discovery-runs/latest')) {
        return jsonResponse({ data: null });
      }
      if (url.endsWith('/stores')) {
        return jsonResponse({
          data: [
            {
              canonical_domain: 'alpha.mx',
              id: 12,
              name: 'Alpha Games',
              platform: 'shopify',
              website_url: 'https://alpha.mx/'
            }
          ]
        });
      }
      if (isStoreItemDiscoveryJobsUrl(url)) {
        return emptyPagedRows();
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OperationsPage operation="item_discovery" />);

    await screen.findByText('Alpha Games');
    expect(screen.getByRole('button', { name: /Run for selected stores/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /Alpha Games/i }));
    expect(screen.getByRole('button', { name: /Run for selected stores/i })).toBeEnabled();
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
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/operations/store-discovery-runs/run-active/cancel', {
      credentials: 'include',
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

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}

function emptyPagedRows() {
  return jsonResponse({
    data: [],
    meta: {
      page: 0,
      page_size: 100,
      total: 0
    }
  });
}

function isStoreItemDiscoveryJobsUrl(url: string) {
  return url.includes('/admin/operations/store-item-discovery-jobs?');
}

function isStoreItemUpdateJobsUrl(url: string) {
  return url.includes('/admin/operations/store-item-update-jobs?');
}
