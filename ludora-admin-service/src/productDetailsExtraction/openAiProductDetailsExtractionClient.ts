import OpenAI from 'openai';

import {
  systemPromptForProductDetailsExtraction,
  userPromptForProductDetailsExtraction
} from './productDetailsExtractionPrompts.js';
import {
  normalizeProductDetails,
  type ProductDetailsExtractionClient,
  type ProductDetailsExtractionClientResult
} from './productDetailsExtractionService.js';

type OpenAiClientOptions = {
  baseURL?: string;
};

export function createOpenAiProductDetailsExtractionClient(
  apiKey: string,
  options: OpenAiClientOptions = {}
): ProductDetailsExtractionClient {
  const openai = new OpenAI({
    apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {})
  });

  return {
    async extract(request, context): Promise<ProductDetailsExtractionClientResult> {
      const response = await openai.responses.create({
        model: context.model,
        input: [
          {
            role: 'system',
            content: systemPromptForProductDetailsExtraction()
          },
          {
            role: 'user',
            content: userPromptForProductDetailsExtraction(request)
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'product_details_extraction_result',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                maxMinutes: { type: ['integer', 'null'] },
                maxPlayers: { type: ['integer', 'null'] },
                metadata: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    confidence: { type: 'number' },
                    evidence: {
                      type: 'array',
                      items: { type: 'string' }
                    },
                    warnings: {
                      type: 'array',
                      items: { type: 'string' }
                    }
                  },
                  required: ['confidence', 'evidence', 'warnings']
                },
                minAge: { type: ['integer', 'null'] },
                minMinutes: { type: ['integer', 'null'] },
                minPlayers: { type: ['integer', 'null'] }
              },
              required: ['minPlayers', 'maxPlayers', 'minMinutes', 'maxMinutes', 'minAge', 'metadata']
            }
          }
        }
      });

      return parseProductDetailsExtractionOutput(response.output_text);
    }
  };
}

export function parseProductDetailsExtractionOutput(output: string): ProductDetailsExtractionClientResult {
  const parsed = JSON.parse(output) as Record<string, unknown>;
  return {
    details: normalizeProductDetails({
      maxMinutes: parsed.maxMinutes,
      maxPlayers: parsed.maxPlayers,
      minAge: parsed.minAge,
      minMinutes: parsed.minMinutes,
      minPlayers: parsed.minPlayers
    }),
    metadata: normalizeMetadata(parsed.metadata)
  };
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const confidence = typeof metadata.confidence === 'number' ? metadata.confidence : Number(metadata.confidence);

  return {
    confidence: Number.isFinite(confidence) ? confidence : 0,
    evidence: stringList(metadata.evidence),
    warnings: stringList(metadata.warnings)
  };
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}
