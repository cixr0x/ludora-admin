import { describe, expect, it } from 'vitest';

import { parseTranslationOutput } from './openAiTranslationClient.js';

describe('OpenAI translation client output parsing', () => {
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
