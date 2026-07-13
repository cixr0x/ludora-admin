import { describe, expect, it } from 'vitest';

import { parseStoreProfileDetectionOutput } from './openAiStoreProfileDetectionClient.js';

describe('OpenAI store profile detection client', () => {
  it('parses structured store profile output', () => {
    expect(
      parseStoreProfileDetectionOutput(
        JSON.stringify({
          city: 'Mérida',
          country: 'Mexico',
          facebookUrl: '',
          instagramUrl: 'https://instagram.com/example',
          logoUrl: 'https://example.mx/logo.png',
          metadata: { confidence: 0.91, evidence: ['footer'], warnings: [] },
          name: 'Example',
          platform: 'shopify',
          state: 'Yucatán'
        })
      )
    ).toEqual({
      city: 'Mérida',
      country: 'Mexico',
      facebookUrl: '',
      instagramUrl: 'https://instagram.com/example',
      logoUrl: 'https://example.mx/logo.png',
      metadata: { confidence: 0.91, evidence: ['footer'], warnings: [] },
      name: 'Example',
      platform: 'shopify',
      state: 'Yucatán'
    });
  });
});
