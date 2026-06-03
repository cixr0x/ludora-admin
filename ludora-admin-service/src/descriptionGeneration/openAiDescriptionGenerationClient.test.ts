import { describe, expect, it } from 'vitest';

import { parseDescriptionGenerationOutput } from './openAiDescriptionGenerationClient.js';

describe('OpenAI description generation client output parsing', () => {
  it('normalizes metadata arrays when the model returns scalar values', () => {
    const result = parseDescriptionGenerationOutput(
      JSON.stringify({
        descriptionEs:
          'En Coffee Rush, la cafeteria se llena de pedidos y cada ingrediente cuenta para convertir el caos en una victoria deliciosa.',
        metadata: {
          sourceBalance: 'balanced',
          warnings: 'No se mencionaron premios ni componentes no presentes en las fuentes.'
        }
      })
    );

    expect(result).toEqual({
      descriptionEs:
        'En Coffee Rush, la cafeteria se llena de pedidos y cada ingrediente cuenta para convertir el caos en una victoria deliciosa.',
      metadata: {
        sourceBalance: 'balanced',
        warnings: ['No se mencionaron premios ni componentes no presentes en las fuentes.']
      }
    });
  });
});
