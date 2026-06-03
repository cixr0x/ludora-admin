import OpenAI from 'openai';

import {
  systemPromptForDescriptionGeneration,
  userPromptForDescriptionGeneration
} from './descriptionGenerationPrompts.js';
import type {
  DescriptionGenerationClient,
  DescriptionGenerationClientResult
} from './descriptionGenerationService.js';

export function createOpenAiDescriptionGenerationClient(apiKey: string): DescriptionGenerationClient {
  const openai = new OpenAI({ apiKey });

  return {
    async generate(request, context): Promise<DescriptionGenerationClientResult> {
      const response = await openai.responses.create({
        model: context.model,
        input: [
          {
            role: 'system',
            content: systemPromptForDescriptionGeneration()
          },
          {
            role: 'user',
            content: userPromptForDescriptionGeneration(request)
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'description_generation_result',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                descriptionEs: { type: 'string' },
                metadata: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    sourceBalance: { type: 'string' },
                    warnings: {
                      type: 'array',
                      items: { type: 'string' }
                    }
                  },
                  required: ['sourceBalance', 'warnings']
                }
              },
              required: ['descriptionEs', 'metadata']
            }
          }
        }
      });

      return parseDescriptionGenerationOutput(response.output_text);
    }
  };
}

export function parseDescriptionGenerationOutput(output: string): DescriptionGenerationClientResult {
  const parsed = JSON.parse(output) as Partial<DescriptionGenerationClientResult>;
  return {
    descriptionEs: typeof parsed.descriptionEs === 'string' ? parsed.descriptionEs.trim() : '',
    metadata: normalizeMetadata(parsed.metadata)
  };
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    sourceBalance: typeof metadata.sourceBalance === 'string' ? metadata.sourceBalance.trim() : '',
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
