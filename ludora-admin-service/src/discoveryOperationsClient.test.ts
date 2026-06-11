import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscoveryApiError, createDiscoveryOperationsClient } from './discoveryOperationsClient.js';

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
      new DiscoveryApiError('Store discovery is already running', 409)
    );
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
});
