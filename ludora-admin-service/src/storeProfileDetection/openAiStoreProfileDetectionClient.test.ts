import OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOpenAiStoreProfileDetectionClient,
  parseStoreProfileDetectionOutput
} from './openAiStoreProfileDetectionClient.js';

vi.mock('openai', () => ({
  default: vi.fn(function OpenAIMock() {
    return {
      responses: {
        create: vi.fn()
      }
    };
  })
}));

describe('OpenAI store profile detection client', () => {
  beforeEach(() => {
    vi.mocked(OpenAI).mockClear();
  });

  it('uses the fixed CodexAPI compatibility key', () => {
    createOpenAiStoreProfileDetectionClient({ baseURL: 'http://127.0.0.1:3001/v1' });

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'codexapi-local',
      baseURL: 'http://127.0.0.1:3001/v1'
    });
  });

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
