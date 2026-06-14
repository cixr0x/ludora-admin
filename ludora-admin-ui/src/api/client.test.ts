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

  it('fetches item taxonomy metadata', async () => {
    const taxonomy = {
      categories: [{ id: 1, value: 'Economic', value_es: 'Economico' }],
      families: [{ id: 2, value: 'Food & Drink: Coffee', value_es: 'Cafe' }],
      mechanics: [{ id: 3, value: 'Contracts', value_es: 'Contratos' }]
    };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: taxonomy }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.getItemTaxonomy('77')).resolves.toEqual(taxonomy);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/items/77/taxonomy');
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

  it('fetches paged front page categories with page metadata', async () => {
    const records = [{ category_id: 5, category_name: 'Party Game', category_type: 'category', id: '1', order: 10, title: 'Need a laugh?' }];
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: records,
          meta: {
            page: 0,
            page_size: 100,
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
      adminApi.getFrontPageCategoriesPage({
        filters: { title: 'laugh' },
        page: 0,
        pageSize: 100,
        sortColumnId: 'title',
        sortDirection: 'asc'
      })
    ).resolves.toEqual({
      page: 0,
      pageSize: 100,
      rows: records,
      total: 1
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4001/front-page-categories?page=0&page_size=100&sort=title&sort_direction=asc&filter_title=laugh'
    );
  });

  it('creates, updates, and deletes front page categories', async () => {
    const category = { category_id: 5, category_type: 'category', id: '1', order: 10, title: 'Need a laugh?' };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: category }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.createFrontPageCategory({ category_id: 5, category_type: 'category', order: 10, title: 'Need a laugh?' })).resolves.toEqual(
      category
    );
    await expect(adminApi.updateFrontPageCategory('1', { category_id: 6, category_type: 'family', order: 20, title: 'Cozy nights' })).resolves.toEqual(
      category
    );
    await expect(adminApi.deleteFrontPageCategory('1')).resolves.toEqual(category);

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://localhost:4001/front-page-categories', {
      body: JSON.stringify({ category_id: 5, category_type: 'category', order: 10, title: 'Need a laugh?' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://localhost:4001/front-page-categories/1', {
      body: JSON.stringify({ category_id: 6, category_type: 'family', order: 20, title: 'Cozy nights' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH'
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'http://localhost:4001/front-page-categories/1', {
      method: 'DELETE'
    });
  });

  it('fetches front page category taxonomy options', async () => {
    const rows = [
      {
        bgg_id: 1021,
        category_id: 5,
        category_type: 'category',
        front_page_category_id: null,
        game_count: 42,
        name: 'Party Game',
        name_es: 'Juego de fiesta'
      }
    ];
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: rows }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.getFrontPageCategoryOptions()).resolves.toEqual(rows);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/front-page-category-options');
  });

  it('fetches front page category taxonomy options with uncovered-game counts', async () => {
    const rows = [
      {
        bgg_id: 1021,
        category_id: 5,
        category_type: 'category',
        front_page_category_id: null,
        game_count: 7,
        name: 'Party Game',
        name_es: 'Juego de fiesta'
      }
    ];
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: rows }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.getFrontPageCategoryOptions({ onlyUnlinkedGames: true })).resolves.toEqual(rows);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/front-page-category-options?only_unlinked_games=true');
  });

  it('fetches products linked to a front page category taxonomy option', async () => {
    const rows = [
      {
        canonical_name: 'Coffee Rush',
        canonical_name_es: 'Cafeteria',
        id: 77,
        image_url: 'https://cdn.example/coffee.jpg',
        image_url_es: 'https://cdn.example/cafe.jpg',
        item_type: 'base_game',
        year_published: 2023
      }
    ];
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: rows }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.getFrontPageCategoryProducts('mechanic', 8)).resolves.toEqual(rows);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/front-page-category-options/mechanic/8/products');
  });

  it('starts random front page category item assignment with a POST request', async () => {
    const result = { assigned_count: 2, skipped_count: 1 };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: result }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.assignRandomFrontPageCategoryItems()).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/front-page-categories/random-item-assignments', {
      method: 'POST'
    });
  });

  it('fetches front page preview rows', async () => {
    const rows = [
      {
        category_id: 5,
        category_name: 'Party Game',
        category_type: 'category',
        id: 1,
        order: 10,
        products: [
          {
            canonical_name: 'Coffee Rush',
            canonical_name_es: 'Cafeteria',
            id: 77,
            image_url: 'https://cdn.example/coffee.jpg',
            image_url_es: 'https://cdn.example/cafe.jpg',
            item_type: 'base_game',
            year_published: 2023
          }
        ],
        title: 'Party Game'
      }
    ];
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: rows }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.getFrontPagePreview()).resolves.toEqual(rows);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/front-page-preview');
  });

  it('updates store items with a JSON body', async () => {
    const itemCandidate = { id: '3365', listing_status: 'UNLISTED', title: 'Kitchen Rush Updated' };
    const payload = {
      description: 'Updated description',
      listing_status: 'UNLISTED',
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

  it('confirms store items as boardgames with a POST request', async () => {
    const itemCandidate = { id: '3365', item_id: 77, listing_status: 'PENDING', title: 'Kitchen Rush' };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: itemCandidate }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.confirmItemCandidateBoardgame('3365')).resolves.toEqual(itemCandidate);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/listings/3365/confirm-boardgame', {
      method: 'POST'
    });
  });

  it('updates store item listing status with a PATCH request', async () => {
    const itemCandidate = { id: '3365', item_id: 77, listing_status: 'LISTED', title: 'Kitchen Rush' };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: itemCandidate }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(adminApi.updateItemCandidateListingStatus('3365', 'LISTED')).resolves.toEqual(itemCandidate);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/discovery/listings/3365/listing-status', {
      body: JSON.stringify({ listing_status: 'LISTED' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH'
    });
  });

  it('creates items from store items with a POST request', async () => {
    const itemCandidate = { id: '3365', item_id: 77, listing_status: 'PENDING', title: 'Kitchen Rush' };
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
    const itemCandidate = { id: '3365', item_id: 77, listing_status: 'PENDING', title: 'Kitchen Rush Mexico' };
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
    const itemCandidate = { id: '3365', item_id: 77, listing_status: 'PENDING', matched_bgg_id: 377061 };
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

  it('starts item update runs with a POST request', async () => {
    const run = {
      completed_at: null,
      error: null,
      id: 'run-3',
      result: {
        updated_items: 8
      },
      started_at: '2026-06-08T20:00:00Z',
      status: 'completed',
      type: 'item_update'
    };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: run }), {
        headers: { 'Content-Type': 'application/json' },
        status: 202
      })
    );

    await expect(adminApi.startItemUpdateRun()).resolves.toEqual(run);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/item-update-runs', {
      method: 'POST'
    });
  });

  it('starts item embedding runs with a refresh mode', async () => {
    const run = {
      completed_at: null,
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
    };
    const { adminApi } = await importClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: run }), {
        headers: { 'Content-Type': 'application/json' },
        status: 202
      })
    );

    await expect(adminApi.startItemEmbeddingRun('missing')).resolves.toEqual(run);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/admin/operations/item-embedding-runs', {
      body: JSON.stringify({ refresh_mode: 'missing' }),
      headers: { 'Content-Type': 'application/json' },
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
