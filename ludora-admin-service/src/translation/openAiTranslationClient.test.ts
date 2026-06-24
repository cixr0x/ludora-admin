import OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpenAiTranslationClient, parseTranslationOutput } from './openAiTranslationClient.js';

vi.mock('openai', () => ({
  default: vi.fn(function OpenAIMock() {
    return {
      responses: {
        create: vi.fn()
      }
    };
  })
}));

describe('OpenAI translation client output parsing', () => {
  beforeEach(() => {
    vi.mocked(OpenAI).mockClear();
  });

  it('passes a configured base URL to the OpenAI SDK', () => {
    createOpenAiTranslationClient('test-key', { baseURL: 'http://127.0.0.1:3001/v1' });

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'http://127.0.0.1:3001/v1'
    });
  });

  it('normalizes metadata arrays when the model returns scalar values', () => {
    const result = parseTranslationOutput(
      JSON.stringify({
        alternates: ['Un juego sobre comercio'],
        metadata: {
          confidence: '0.98',
          notes: 'Direct translation',
          preserved_identity_terms: '',
          removed_noise: 'Spanish edition'
        },
        translatedText: 'Un juego sobre el comercio.'
      })
    );

    expect(result.metadata).toEqual({
      confidence: 0.98,
      notes: 'Direct translation',
      preserved_identity_terms: [],
      removed_noise: ['Spanish edition']
    });
  });
});
