import OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpenAiDescriptionGenerationClient, parseDescriptionGenerationOutput } from './openAiDescriptionGenerationClient.js';

vi.mock('openai', () => ({
  default: vi.fn(function OpenAIMock() {
    return {
      responses: {
        create: vi.fn()
      }
    };
  })
}));

describe('OpenAI description generation client output parsing', () => {
  beforeEach(() => {
    vi.mocked(OpenAI).mockClear();
  });

  it('passes a configured base URL to the OpenAI SDK', () => {
    createOpenAiDescriptionGenerationClient('test-key', { baseURL: 'http://127.0.0.1:3001/v1' });

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'http://127.0.0.1:3001/v1'
    });
  });

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
