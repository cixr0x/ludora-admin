import OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOpenAiAmazonTitleExtractionClient,
  parseAmazonTitleExtractionOutput
} from './openAiAmazonTitleExtractionClient.js';

const createMock = vi.fn();

vi.mock('openai', () => ({
  default: vi.fn(function OpenAIMock() {
    return {
      responses: {
        create: createMock
      }
    };
  })
}));

describe('OpenAI Amazon title extraction client', () => {
  beforeEach(() => {
    vi.mocked(OpenAI).mockClear();
    createMock.mockReset();
  });

  it('uses the shared base URL aware OpenAI client flow', () => {
    createOpenAiAmazonTitleExtractionClient('test-key', { baseURL: 'http://127.0.0.1:3001/v1' });

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'http://127.0.0.1:3001/v1'
    });
  });

  it('parses and trims model output', () => {
    const result = parseAmazonTitleExtractionOutput(
      JSON.stringify({
        gameTitle: ' Yokai Pagoda ',
        metadata: {
          confidence: '0.94',
          removedNoise: ['La Compania de los Juegos', 'Juego en Espanol'],
          warnings: ''
        }
      })
    );

    expect(result).toEqual({
      gameTitle: 'Yokai Pagoda',
      metadata: {
        confidence: 0.94,
        removedNoise: ['La Compania de los Juegos', 'Juego en Espanol'],
        warnings: []
      }
    });
  });

  it('requests a structured game title from the Responses API', async () => {
    createMock.mockResolvedValueOnce({
      output_text: JSON.stringify({
        gameTitle: 'Yokai Pagoda',
        metadata: {
          confidence: 0.96,
          removedNoise: ['publisher prefix', 'marketing copy'],
          warnings: []
        }
      })
    });

    const client = createOpenAiAmazonTitleExtractionClient('test-key');
    const result = await client.extract(
      {
        amazonTitle:
          'La Compania de los Juegos | Yokai Pagoda | Juega Cartas para Evitar Recibir Puntos Negativos | Juego en Espanol',
        rawPayload: {
          amazon: {
            asin: 'B0TEST1234'
          }
        },
        sourceUrl: 'https://www.amazon.com.mx/dp/B0TEST1234'
      },
      { model: 'gpt-5.4-nano', promptVersion: 'amazon-title-v1' }
    );

    expect(result.gameTitle).toBe('Yokai Pagoda');
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4-nano',
        text: expect.objectContaining({
          format: expect.objectContaining({
            name: 'amazon_title_extraction_result',
            strict: true,
            type: 'json_schema'
          })
        })
      })
    );
  });
});
