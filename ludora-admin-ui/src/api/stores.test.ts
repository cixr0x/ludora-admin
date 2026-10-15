import { afterEach, describe, expect, it, vi } from 'vitest';

import { storeCreationApi, storeStatisticsApi } from './stores';

describe('store creation API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests website profile detection with admin credentials', async () => {
    const detected = { ai_used: false, profile: { website_url: 'https://example.mx/' }, unresolved_fields: [] };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: detected }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      })
    );

    await expect(storeCreationApi.detectStoreProfile('example.mx')).resolves.toEqual(detected);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/admin/store-profile-detections', {
      body: JSON.stringify({ website_url: 'example.mx' }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
  });

  it('loads item statistics for the selected store with admin credentials and cancellation', async () => {
    const statistics = {
      total_items: 31,
      boardgame_true_confirmed_true: 17,
      boardgame_true_confirmed_false: 7,
      boardgame_false_confirmed_true: 2,
      boardgame_false_confirmed_false: 5,
      confirmed_boardgame_listed: 11,
      confirmed_boardgame_pending: 3,
      confirmed_boardgame_rejected: 2
    };
    const signal = new AbortController().signal;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: statistics }), { status: 200 })
    );

    await expect(storeStatisticsApi.getItemStatistics('42', signal)).resolves.toEqual(statistics);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4001/stores/42/item-statistics', {
      credentials: 'include',
      method: 'GET',
      signal
    });
  });

  it('preserves statistics API failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Store not found' } }), { status: 404 })
    );

    await expect(storeStatisticsApi.getItemStatistics('42')).rejects.toThrow('Store not found');
  });

  it('rejects a missing statistics payload instead of treating it as an empty store', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await expect(storeStatisticsApi.getItemStatistics('42')).rejects.toThrow('Invalid API response: data is required');
  });
});
