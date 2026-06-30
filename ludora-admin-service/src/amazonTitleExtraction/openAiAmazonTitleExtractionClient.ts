import { createOpenAiResponsesClient, type OpenAiClientOptions } from '../ai/openAiResponsesClient.js';
import {
  systemPromptForAmazonTitleExtraction,
  userPromptForAmazonTitleExtraction
} from './amazonTitleExtractionPrompts.js';
import type {
  AmazonTitleExtractionClient,
  AmazonTitleExtractionClientResult
} from './amazonTitleExtractionService.js';

export function createOpenAiAmazonTitleExtractionClient(
  apiKey: string,
  options: OpenAiClientOptions = {}
): AmazonTitleExtractionClient {
  const responses = createOpenAiResponsesClient(apiKey, options);

  return {
    async extract(request, context): Promise<AmazonTitleExtractionClientResult> {
      const response = await responses.create({
        model: context.model,
        input: [
          {
            role: 'system',
            content: systemPromptForAmazonTitleExtraction()
          },
          {
            role: 'user',
            content: userPromptForAmazonTitleExtraction(request)
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'amazon_title_extraction_result',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                gameTitle: { type: 'string' },
                metadata: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    confidence: { type: 'number' },
                    removedNoise: {
                      type: 'array',
                      items: { type: 'string' }
                    },
                    warnings: {
                      type: 'array',
                      items: { type: 'string' }
                    }
                  },
                  required: ['confidence', 'removedNoise', 'warnings']
                }
              },
              required: ['gameTitle', 'metadata']
            }
          }
        }
      });

      return parseAmazonTitleExtractionOutput(response.output_text);
    }
  };
}

export function parseAmazonTitleExtractionOutput(output: string): AmazonTitleExtractionClientResult {
  const parsed = JSON.parse(output) as Record<string, unknown>;
  return {
    gameTitle: typeof parsed.gameTitle === 'string' ? parsed.gameTitle.trim() : '',
    metadata: normalizeMetadata(parsed.metadata)
  };
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const confidence = typeof metadata.confidence === 'number' ? metadata.confidence : Number(metadata.confidence);
  return {
    confidence: Number.isFinite(confidence) ? confidence : 0,
    removedNoise: stringList(metadata.removedNoise),
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
