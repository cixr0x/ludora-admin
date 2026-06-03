import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from './config.js';

describe('loadConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults PORT to 4001 when unset', () => {
    vi.stubEnv('PORT', undefined);

    expect(loadConfig().port).toBe(4001);
  });

  it.each(['abc', '0', '-1', '4001.5'])('rejects invalid PORT %s', (port) => {
    vi.stubEnv('PORT', port);

    expect(() => loadConfig()).toThrow('PORT must be a positive integer');
  });

  it('uses the discovery API URL from env when provided', () => {
    vi.stubEnv('LUDORA_DISCOVERY_API_URL', 'http://localhost:8001/');

    expect(loadConfig().discoveryApiUrl).toBe('http://localhost:8001/');
  });

  it('allows both localhost and 127.0.0.1 UI origins by default', () => {
    vi.stubEnv('CORS_ORIGIN', undefined);

    expect(loadConfig().corsOrigin).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('loads comma-separated CORS origins from env', () => {
    vi.stubEnv('CORS_ORIGIN', 'http://localhost:5173, http://127.0.0.1:5173');

    expect(loadConfig().corsOrigin).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('loads optional BGG API configuration', () => {
    vi.stubEnv('BGG_API_TOKEN', 'test-token');
    vi.stubEnv('BGG_API_BASE_URL', 'https://example.test/xmlapi2');

    expect(loadConfig()).toMatchObject({
      bggApiBaseUrl: 'https://example.test/xmlapi2',
      bggApiToken: 'test-token'
    });
  });

  it('loads optional OpenAI translation configuration', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('OPENAI_TRANSLATION_MODEL', 'gpt-5.4-nano');

    expect(loadConfig()).toMatchObject({
      openAiApiKey: 'test-openai-key',
      openAiTranslationModel: 'gpt-5.4-nano'
    });
  });
});
