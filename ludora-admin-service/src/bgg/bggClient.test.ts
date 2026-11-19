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
    expect(requestedUrl.searchParams.get('type')).toBe('boardgame,boardgameexpansion,boardgameaccessory,rpgitem');
    expect(requestedUrl.searchParams.get('stats')).toBe('1');
  });

  it('requests RPG items and accessories in live BGG searches', async () => {
    let requestedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      requestedUrl = String(url);
      return xmlResponse('<items />');
    }));

    await createBggClient({ apiToken: 'test-token', baseUrl: 'https://bgg.example/xmlapi2' }).search('Player Handbook');

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe('/xmlapi2/search');
    expect(url.searchParams.get('type')).toBe('boardgame,boardgameexpansion,boardgameaccessory,rpgitem');
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

  it('aborts an optional cover lookup during rate-limit backoff and releases the shared queue', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce(xmlResponse('<items />'));
    vi.stubGlobal('fetch', fetchMock);
    const bgg = createBggClient({ apiToken: 'test-token' });
    const controller = new AbortController();
    const reason = new Error('Cover lookup deadline exceeded');
    let rejection: unknown;
    const cover = bgg.fetchThing(296354, controller.signal).catch((error: unknown) => { rejection = error; });
    const next = bgg.search('Catan');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rejection).toBe(reason);
    await cover;
    await expect(next).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an expired cover lookup while it waits on an occupied queue and skips its fetch', async () => {
    vi.useFakeTimers();
    let releaseFirstRequest!: () => void;
    const firstRequestRelease = new Promise<void>((resolve) => { releaseFirstRequest = resolve; });
    const fetchMock = vi.fn(async () => {
      await firstRequestRelease;
      return xmlResponse('<items />');
    });
    vi.stubGlobal('fetch', fetchMock);
    const bgg = createBggClient({ apiToken: 'test-token' });
    const first = bgg.search('Catan');
    const controller = new AbortController();
    let rejected = false;
    const cover = bgg.fetchThing(296354, controller.signal).catch(() => { rejected = true; });
    await flushPromises();
    controller.abort();
    await flushPromises();
    expect(rejected).toBe(true);

    releaseFirstRequest();
    await first;
    await cover;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledOnce();
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
