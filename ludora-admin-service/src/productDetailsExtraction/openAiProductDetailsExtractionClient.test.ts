import OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOpenAiProductDetailsExtractionClient,
  parseProductDetailsExtractionOutput
} from './openAiProductDetailsExtractionClient.js';

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

describe('OpenAI product details extraction client', () => {
  beforeEach(() => {
    vi.mocked(OpenAI).mockClear();
    createMock.mockReset();
  });

  it('passes a configured base URL to the OpenAI SDK', () => {
    createOpenAiProductDetailsExtractionClient('test-key', { baseURL: 'http://127.0.0.1:3001/v1' });

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'http://127.0.0.1:3001/v1'
    });
  });

  it('parses and normalizes scalar model output', () => {
    const result = parseProductDetailsExtractionOutput(
      JSON.stringify({
        maxMinutes: '45',
        maxPlayers: '4',
        metadata: {
          confidence: '0.87',
          evidence: '2-4 jugadores, 30-45 minutos',
          warnings: ''
        },
        minAge: '8',
        minMinutes: '30',
        minPlayers: '2'
      })
    );

    expect(result).toEqual({
      details: {
        maxMinutes: 45,
        maxPlayers: 4,
        minAge: 8,
        minMinutes: 30,
        minPlayers: 2
      },
      metadata: {
        confidence: 0.87,
        evidence: ['2-4 jugadores, 30-45 minutos'],
        warnings: []
      }
    });
  });

  it('discards invalid numeric ranges from model output', () => {
    const result = parseProductDetailsExtractionOutput(
      JSON.stringify({
        maxMinutes: 25,
        maxPlayers: 1,
        metadata: {
          confidence: 0.5,
          evidence: [],
          warnings: ['conflicting specs']
        },
        minAge: -3,
        minMinutes: 45,
        minPlayers: 4
      })
    );

    expect(result.details).toEqual({
      maxMinutes: null,
      maxPlayers: null,
      minAge: null,
      minMinutes: null,
      minPlayers: null
    });
    expect(result.metadata.warnings).toEqual(['conflicting specs']);
  });

  it('requests structured JSON details from the Responses API', async () => {
    createMock.mockResolvedValueOnce({
      output_text: JSON.stringify({
        maxMinutes: 60,
        maxPlayers: 5,
        metadata: {
          confidence: 0.9,
          evidence: ['2-5 jugadores'],
          warnings: []
        },
        minAge: 10,
        minMinutes: 30,
        minPlayers: 2
      })
    });

    const client = createOpenAiProductDetailsExtractionClient('test-key');
    const result = await client.extract(
      {
        description: 'Para 2-5 jugadores, 30-60 minutos, edad 10+.',
        existingDetails: {},
        rawPayload: '',
        sourceUrl: 'https://store.mx/game',
        title: 'Cafe Barista'
      },
      { model: 'gpt-5.4-nano', promptVersion: 'product-details-v1' }
    );

    expect(result.details).toEqual({
      maxMinutes: 60,
      maxPlayers: 5,
      minAge: 10,
      minMinutes: 30,
      minPlayers: 2
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4-nano',
        text: expect.objectContaining({
          format: expect.objectContaining({
            name: 'product_details_extraction_result',
            strict: true,
            type: 'json_schema'
          })
        })
      })
    );
  });
});
