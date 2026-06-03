import OpenAI from 'openai';

import { systemPromptForPurpose, userPromptForTranslation } from './translationPrompts.js';
import type { TranslationClient, TranslationClientResult } from './translationService.js';

export function createOpenAiTranslationClient(apiKey: string): TranslationClient {
  const openai = new OpenAI({ apiKey });

  return {
    async translate(request, context): Promise<TranslationClientResult> {
      const response = await openai.responses.create({
        model: context.model,
        input: [
          {
            role: 'system',
            content: systemPromptForPurpose(request.purpose)
          },
          {
            role: 'user',
            content: userPromptForTranslation(request)
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'translation_result',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alternates: {
                  type: 'array',
                  items: { type: 'string' }
                },
                metadata: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    confidence: { type: 'number' },
                    notes: { type: 'string' },
                    preserved_identity_terms: {
                      type: 'array',
                      items: { type: 'string' }
                    },
                    removed_noise: {
                      type: 'array',
                      items: { type: 'string' }
                    }
                  },
                  required: ['confidence', 'notes', 'preserved_identity_terms', 'removed_noise']
                },
                translatedText: { type: 'string' }
              },
              required: ['translatedText', 'alternates', 'metadata']
            }
          }
        }
      });

      return parseTranslationOutput(response.output_text);
    }
  };
}

export function parseTranslationOutput(output: string): TranslationClientResult {
  const parsed = JSON.parse(output) as Partial<TranslationClientResult>;
  return {
    alternates: Array.isArray(parsed.alternates) ? parsed.alternates.map(String).filter(Boolean) : [],
    metadata: normalizeMetadata(parsed.metadata),
    translatedText: typeof parsed.translatedText === 'string' ? parsed.translatedText : ''
  };
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const confidence = typeof metadata.confidence === 'number' ? metadata.confidence : Number(metadata.confidence);
  return {
    confidence: Number.isFinite(confidence) ? confidence : 0,
    notes: typeof metadata.notes === 'string' ? metadata.notes : '',
    preserved_identity_terms: stringList(metadata.preserved_identity_terms),
    removed_noise: stringList(metadata.removed_noise)
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
