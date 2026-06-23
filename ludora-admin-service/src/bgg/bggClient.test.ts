import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBggClient } from './bggClient.js';

describe('BGG client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('requests thing details with stats enabled', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        requestedUrls.push(String(url));
        return {
          ok: true,
          text: async () => `
            <items>
              <item type="boardgame" id="377061">
                <name type="primary" value="Coffee Rush" />
              </item>
            </items>
          `
        };
      })
    );

    await createBggClient({ apiToken: 'test-token', baseUrl: 'https://bgg.example/xmlapi2' }).fetchThing(377061);

    expect(requestedUrls).toHaveLength(1);
    const requestedUrl = new URL(requestedUrls[0]);
    expect(requestedUrl.pathname).toBe('/xmlapi2/thing');
    expect(requestedUrl.searchParams.get('id')).toBe('377061');
    expect(requestedUrl.searchParams.get('type')).toBe('boardgame,boardgameexpansion');
    expect(requestedUrl.searchParams.get('stats')).toBe('1');
  });

  it('serializes requests and waits one second between BGG request starts', async () => {
    vi.useFakeTimers();

    const requestedAt: number[] = [];
    let inFlightRequests = 0;
    let maxInFlightRequests = 0;
    let releaseFirstRequest!: () => void;
    const firstRequestRelease = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });

    const fetchMock = vi.fn(async () => {
      requestedAt.push(Date.now());
      inFlightRequests += 1;
      maxInFlightRequests = Math.max(maxInFlightRequests, inFlightRequests);
      if (requestedAt.length === 1) {
        await firstRequestRelease;
      }
      inFlightRequests -= 1;
      return xmlResponse('<items></items>');
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createBggClient({ apiToken: 'test-token', baseUrl: 'https://bgg.example/xmlapi2' });
    const firstRequest = client.fetchThing(377061);
    const secondRequest = client.search('Coffee Rush');

    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirstRequest();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([firstRequest, secondRequest]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(maxInFlightRequests).toBe(1);
    expect(requestedAt[1] - requestedAt[0]).toBeGreaterThanOrEqual(1000);
  });

  it('waits five seconds before retrying BGG requests that receive 429', async () => {
    vi.useFakeTimers();

    const requestedAt: number[] = [];
    const fetchMock = vi.fn(async () => {
      requestedAt.push(Date.now());
      if (requestedAt.length === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => ''
        };
      }
      return xmlResponse('<items></items>');
    });
    vi.stubGlobal('fetch', fetchMock);

    const search = createBggClient({ apiToken: 'test-token', baseUrl: 'https://bgg.example/xmlapi2' }).search('Coffee Rush');

    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(search).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedAt[1] - requestedAt[0]).toBeGreaterThanOrEqual(5000);
  });
});

function xmlResponse(xml: string) {
  return {
    ok: true,
    status: 200,
    text: async () => xml
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
