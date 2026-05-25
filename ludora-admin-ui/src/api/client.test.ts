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
});
