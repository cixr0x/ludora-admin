import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBggClient } from './bggClient.js';

describe('BGG client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});
