import { describe, expect, it, vi } from 'vitest';

import {
  createStoreProfileDetectionService,
  type StoreProfileAiClient,
  type WebsitePage
} from './storeProfileDetectionService.js';

describe('store profile detection service', () => {
  it('detects store fields from the homepage and contact page', async () => {
    const pages: Record<string, WebsitePage> = {
      'https://example.mx/': {
        body: `
          <html>
            <head>
              <meta property="og:site_name" content="Example Juegos">
              <meta property="og:image" content="/assets/logo.png">
              <script>window.Shopify = { theme: { id: 1 } };</script>
            </head>
            <body>
              <a href="https://instagram.com/examplejuegos/?utm_source=site">Instagram</a>
              <a href="/contacto">Contacto</a>
            </body>
          </html>
        `,
        headers: { server: 'cloudflare' },
        url: 'https://www.example.mx/'
      },
      'https://www.example.mx/contacto': {
        body: `
          <html><body>
            <a href="https://www.facebook.com/examplejuegos">Facebook</a>
            Visítanos en Guadalajara, Jalisco, México.
          </body></html>
        `,
        url: 'https://www.example.mx/contacto'
      }
    };
    const fetchWebsite = vi.fn(async (url: string) => {
      const page = pages[url];
      if (!page) {
        throw new Error(`Unexpected URL: ${url}`);
      }
      return page;
    });
    const service = createStoreProfileDetectionService({ fetchWebsite });

    const result = await service.detect('example.mx');

    expect(result.ai_used).toBe(false);
    expect(result.profile).toEqual({
      canonical_domain: 'example.mx',
      city: 'Guadalajara',
      country: 'Mexico',
      facebook_url: 'https://facebook.com/examplejuegos',
      instagram_url: 'https://instagram.com/examplejuegos',
      logo_url: 'https://www.example.mx/assets/logo.png',
      name: 'Example Juegos',
      platform: 'shopify',
      state: 'Jalisco',
      website_url: 'https://www.example.mx/'
    });
    expect(result.unresolved_fields).toEqual([]);
    expect(fetchWebsite).toHaveBeenCalledTimes(2);
  });

  it('uses AI enrichment only for website fields that deterministic extraction did not resolve', async () => {
    const aiClient: StoreProfileAiClient = {
      detect: vi.fn(async () => ({
        city: 'Austin',
        country: 'United States',
        facebookUrl: 'https://facebook.com/tabletopshop',
        instagramUrl: 'https://instagram.com/tabletopshop',
        logoUrl: 'https://tabletop.example/logo.svg',
        metadata: { confidence: 0.8, evidence: ['footer'], warnings: [] },
        name: 'Tabletop Shop',
        platform: 'woocommerce',
        state: 'Texas'
      }))
    };
    const service = createStoreProfileDetectionService({
      aiClient,
      fetchWebsite: async () => ({
        body: '<html><head><title>Tabletop Shop</title></head><body>Welcome</body></html>',
        headers: {},
        url: 'https://tabletop.example/'
      })
    });

    const result = await service.detect('https://tabletop.example');

    expect(result.ai_used).toBe(true);
    expect(result.profile).toMatchObject({
      canonical_domain: 'tabletop.example',
      city: 'Austin',
      country: 'United States',
      name: 'Tabletop Shop',
      platform: 'woocommerce',
      state: 'Texas'
    });
    expect(result.unresolved_fields).toEqual([]);
  });

  it('rejects local and private website targets before fetching', async () => {
    const fetchWebsite = vi.fn();
    const service = createStoreProfileDetectionService({ fetchWebsite });

    await expect(service.detect('http://127.0.0.1:3000')).rejects.toThrow('website_url must reference a public website');
    expect(fetchWebsite).not.toHaveBeenCalled();
  });
});
