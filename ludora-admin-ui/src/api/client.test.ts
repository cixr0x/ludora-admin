import { afterEach, describe, expect, it, vi } from 'vitest';

async function importClient() {
  vi.resetModules();
  return import('./client');
}

describe('fetchRows', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns records from the backend data array', async () => {
    const records = [{ id: 'store-1', name: 'Downtown Games' }];
    const { fetchRows } = await importClient();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: records }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(fetchRows('/discovery/stores')).resolves.toEqual(records);
  });

  it('uses a single slash when the API base URL has a trailing slash', async () => {
    vi.stubEnv('VITE_ADMIN_API_URL', 'http://localhost:4001/');
    const { fetchRows } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await fetchRows('/discovery/stores');

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/stores');
  });

  it('rejects when the backend data field is missing', async () => {
    const { fetchRows } = await importClient();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(fetchRows('/discovery/stores')).rejects.toThrow('Invalid API response: data must be an array');
  });

  it('rejects when the backend data field is not an array', async () => {
    const { fetchRows } = await importClient();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'store-1' } }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(fetchRows('/discovery/stores')).rejects.toThrow('Invalid API response: data must be an array');
  });

  it('starts store discovery runs with a POST request', async () => {
    const run = {
      completed_at: null,
      error: null,
      id: 'run-1',
      result: null,
      started_at: '2026-05-25T20:00:00Z',
      status: 'running',
      type: 'store_discovery'
    };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: run }), {
        headers: { 'Content-Type': 'application/json' },
        status: 202
      })
    );

    await expect(adminApi.startStoreDiscoveryRun()).resolves.toEqual(run);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/store-discovery-runs', {
      method: 'POST'
    });
  });

  it('fetches paged store items with page metadata', async () => {
    const records = [{ id: 'item-candidate-51', title: 'Second page item' }];
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: records,
          meta: {
            page: 2,
            page_size: 25,
            total: 73
          }
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        }
      )
    );

    await expect(adminApi.getItemCandidatesPage({ page: 2, pageSize: 25 })).resolves.toEqual({
      page: 2,
      pageSize: 25,
      rows: records,
      total: 73
    });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/listings?page=2&page_size=25');
  });

  it('fetches paged catalog items with page metadata', async () => {
    const records = [{ canonical_name: 'Coffee Rush', id: '377061', item_type: 'base_game' }];
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: records,
          meta: {
            page: 1,
            page_size: 50,
            total: 70
          }
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        }
      )
    );

    await expect(adminApi.getItemsPage({ page: 1, pageSize: 50, sortColumnId: 'canonical_name' })).resolves.toEqual({
      page: 1,
      pageSize: 50,
      rows: records,
      total: 70
    });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/items?page=1&page_size=50&sort=canonical_name');
  });

  it('fetches item-linked candidates', async () => {
    const records = [{ id: '3365', item_id: '77', title: 'Coffee Rush' }];
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: records }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.getItemLinkedCandidates('77')).resolves.toEqual(records);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/items/77/candidates');
  });

  it('fetches item-linked store items', async () => {
    const records = [{ id: '3365', item_id: '77', title: 'Coffee Rush' }];
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: records }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.getItemStoreItems('77')).resolves.toEqual(records);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/items/77/store-items');
  });

  it('encodes table sort and filters in paged admin requests', async () => {
    const records = [{ canonical_domain: 'caravanagameshop.com', id: 'store-1' }];
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: records,
          meta: {
            page: 0,
            page_size: 25,
            total: 1
          }
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        }
      )
    );

    await expect(
      adminApi.getStoreCandidatesPage({
        filters: {
          canonical_domain: 'caravana',
          status: ''
        },
        page: 0,
        pageSize: 25,
        sortColumnId: 'canonical_domain',
        sortDirection: 'asc'
      })
    ).resolves.toEqual({
      page: 0,
      pageSize: 25,
      rows: records,
      total: 1
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4001/discovery/stores?page=0&page_size=25&sort=canonical_domain&sort_direction=asc&filter_canonical_domain=caravana'
    );
  });

  it('fetches store item reviews for linked store items', async () => {
    const records = [{ candidate_id: 920, candidate_name: 'Cafe Barista', item_name: 'Coffee Rush' }];
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: records }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.getOfferReviews()).resolves.toEqual(records);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/discovery/offer-reviews');
  });

  it('generates Spanish item descriptions with a JSON body', async () => {
    const result = {
      description_es: 'Una descripcion en espanol lista para Ludora.',
      metadata: { sourceBalance: 'mixed', warnings: [] },
      model: 'gpt-5.4-nano',
      prompt_version: 'description-generator-v1'
    };
    const payload = {
      boardgame_name: 'Cafe Barista',
      description_1: 'Complete customer orders to increase your ratings.',
      description_2: 'Vive la emocion de una cafeteria llena de pedidos.'
    };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: result }), {
        headers: { 'Content-Type': 'application/json' },
        status: 201
      })
    );

    await expect(adminApi.generateDescription(payload)).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/description-generations', {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('creates store candidates with a JSON body', async () => {
    const store = { id: 'store-1', store_name: 'New Store' };
    const payload = {
      canonical_domain: 'newstore.mx',
      evidence: ['manual'],
      store_name: 'New Store',
      website_url: 'https://newstore.mx/'
    };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: store }), {
        headers: { 'Content-Type': 'application/json' },
        status: 201
      })
    );

    await expect(adminApi.createStoreCandidate(payload)).resolves.toEqual(store);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/stores', {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('updates store candidates with a JSON body', async () => {
    const store = { id: 'store-1', store_name: 'Updated Store' };
    const payload = {
      canonical_domain: 'example.mx',
      evidence: ['manual'],
      store_name: 'Updated Store',
      website_url: 'https://example.mx/'
    };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: store }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.updateStoreCandidate('store-1', payload)).resolves.toEqual(store);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/stores/store-1', {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH'
    });
  });

  it('updates clean stores with a JSON body', async () => {
    const store = { id: '12', name: 'Updated Store' };
    const payload = {
      canonical_domain: 'example.mx',
      name: 'Updated Store',
      status: 'active',
      website_url: 'https://example.mx/'
    };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: store }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.updateStore('12', payload)).resolves.toEqual(store);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/stores/12', {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH'
    });
  });

  it('updates store items with a JSON body', async () => {
    const itemCandidate = { id: '3365', status: 'MATCH_NOT_FOUND', title: 'Kitchen Rush Updated' };
    const payload = {
      description: 'Updated description',
      status: 'MATCH_NOT_FOUND',
      title: 'Kitchen Rush Updated'
    };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: itemCandidate }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.updateItemCandidate('3365', payload)).resolves.toEqual(itemCandidate);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/listings/3365', {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH'
    });
  });

  it('creates items from store items with a POST request', async () => {
    const itemCandidate = { id: '3365', item_id: 77, status: 'LISTED', title: 'Kitchen Rush' };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: itemCandidate }), {
        headers: { 'Content-Type': 'application/json' },
        status: 201
      })
    );

    await expect(adminApi.createItemFromCandidate('3365')).resolves.toEqual(itemCandidate);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/listings/3365/create-item', {
      body: JSON.stringify({ bgg_id: '', implements: false }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('creates store items with an implementation reference payload', async () => {
    const itemCandidate = { id: '3365', item_id: 77, status: 'LISTED', title: 'Kitchen Rush Mexico' };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: itemCandidate }), {
        headers: { 'Content-Type': 'application/json' },
        status: 201
      })
    );

    await expect(adminApi.createItemFromCandidate('3365', { bgg_id: '223953', implements: true })).resolves.toEqual(
      itemCandidate
    );

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/listings/3365/create-item', {
      body: JSON.stringify({ bgg_id: '223953', implements: true }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('creates items from BGG IDs for store items with a JSON body', async () => {
    const itemCandidate = { id: '3365', item_id: 77, matched_bgg_id: 377061, status: 'LISTED' };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: itemCandidate }), {
        headers: { 'Content-Type': 'application/json' },
        status: 201
      })
    );

    await expect(adminApi.createItemFromBggId('3365', '377061')).resolves.toEqual(itemCandidate);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/listings/3365/create-item-from-bgg', {
      body: JSON.stringify({ bgg_id: '377061' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('updates catalog items with a JSON body', async () => {
    const item = { canonical_name: 'Coffee Rush Updated', id: '377061' };
    const payload = {
      canonical_name: 'Coffee Rush Updated',
      item_type: 'base_game',
      status: 'active'
    };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: item }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.updateItem('377061', payload)).resolves.toEqual(item);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/items/377061', {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH'
    });
  });

  it('starts item discovery runs for clean stores with a POST request', async () => {
    const run = {
      completed_at: null,
      error: null,
      id: 'run-2',
      result: null,
      started_at: '2026-05-25T20:00:00Z',
      status: 'running',
      type: 'item_discovery'
    };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: run }), {
        headers: { 'Content-Type': 'application/json' },
        status: 202
      })
    );

    await expect(adminApi.startStoreItemDiscoveryRun('12')).resolves.toEqual(run);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/stores/12/item-discovery-runs', {
      method: 'POST'
    });
  });

  it('approves store candidates with a POST request', async () => {
    const store = { id: 'store-1', status: 'ACCEPTED', store_name: 'Accepted Store' };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: store }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.approveStoreCandidate('store-1')).resolves.toEqual(store);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/stores/store-1/approve', {
      method: 'POST'
    });
  });

  it('rejects store candidates with a POST request', async () => {
    const store = { id: 'store-1', status: 'REJECTED', store_name: 'Rejected Store' };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: store }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.rejectStoreCandidate('store-1')).resolves.toEqual(store);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/stores/store-1/reject', {
      method: 'POST'
    });
  });
});
