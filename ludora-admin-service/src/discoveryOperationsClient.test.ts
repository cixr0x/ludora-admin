import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscoveryOperationError } from './discoveryOperations.js';
import { createDiscoveryOperationsClient } from './discoveryOperationsClient.js';

describe('createDiscoveryOperationsClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts store discovery runs using a normalized API URL', async () => {
    const run = {
      completed_at: null,
      error: null,
      id: 'run-1',
      result: null,
      started_at: '2026-05-25T20:00:00Z',
      status: 'running',
      type: 'store_discovery'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: run }), {
        headers: { 'Content-Type': 'application/json' },
        status: 202
      })
    );

    await expect(createDiscoveryOperationsClient('http://localhost:8001/').startStoreDiscoveryRun()).resolves.toEqual(run);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8001/operations/store-discovery-runs', {
      method: 'POST'
    });
  });

  it('throws a status-bearing error when the discovery API returns an error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Store discovery is already running' } }), {
        headers: { 'Content-Type': 'application/json' },
        status: 409
      })
    );

    await expect(createDiscoveryOperationsClient('http://localhost:8001').startStoreDiscoveryRun()).rejects.toEqual(
      new DiscoveryOperationError('Store discovery is already running', 409)
    );
  });

  it('returns null when the discovery API cannot find a requested run', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Run not found' } }), {
        headers: { 'Content-Type': 'application/json' },
        status: 404
      })
    );

    await expect(createDiscoveryOperationsClient('http://localhost:8001').getStoreDiscoveryRun('missing')).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8001/operations/store-discovery-runs/missing', undefined);
  });

  it('starts item discovery runs for one clean store', async () => {
    const run = {
      completed_at: null,
      error: null,
      id: 'run-2',
      result: null,
      started_at: '2026-05-25T20:00:00Z',
      status: 'running',
      type: 'item_discovery'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: run }), {
        headers: { 'Content-Type': 'application/json' },
        status: 202
      })
    );

    await expect(
      createDiscoveryOperationsClient('http://localhost:8001/').startItemDiscoveryRun(12, 'https://example.mx/')
    ).resolves.toEqual(run);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8001/operations/stores/12/item-discovery-runs', {
      body: JSON.stringify({ website_url: 'https://example.mx/' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('starts item update runs', async () => {
    const run = {
      completed_at: null,
      error: null,
      id: 'run-3',
      result: null,
      started_at: '2026-06-08T20:00:00Z',
      status: 'running',
      type: 'item_update'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: run }), {
        headers: { 'Content-Type': 'application/json' },
        status: 202
      })
    );

    await expect(createDiscoveryOperationsClient('http://localhost:8001/').startItemUpdateRun()).resolves.toEqual(run);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8001/operations/item-update-runs', {
      method: 'POST'
    });
  });

  it('starts item embedding runs with a refresh mode', async () => {
    const run = {
      completed_at: null,
      error: null,
      id: 'run-4',
      result: null,
      started_at: '2026-06-13T20:00:00Z',
      status: 'running',
      type: 'item_embeddings'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: run }), {
        headers: { 'Content-Type': 'application/json' },
        status: 202
      })
    );

    await expect(createDiscoveryOperationsClient('http://localhost:8001/').startItemEmbeddingRun('full')).resolves.toEqual(run);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8001/operations/item-embedding-runs', {
      body: JSON.stringify({ refresh_mode: 'full' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('cancels a running discovery operation', async () => {
    const run = {
      completed_at: null,
      error: null,
      id: 'run-5',
      result: null,
      started_at: '2026-06-27T08:00:00Z',
      status: 'cancelling',
      type: 'item_discovery'
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: run }), {
        headers: { 'Content-Type': 'application/json' },
        status: 202
      })
    );

    await expect(createDiscoveryOperationsClient('http://localhost:8001/').cancelStoreDiscoveryRun('run-5')).resolves.toEqual(run);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8001/operations/store-discovery-runs/run-5/cancel', {
      method: 'POST'
    });
  });
});
