import { afterEach, describe, expect, it, vi } from 'vitest';

import { storeCreationApi } from './stores';

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
});
