import { createOpenAiResponsesClient, type OpenAiClientOptions } from '../ai/openAiResponsesClient.js';
import {
  systemPromptForStoreProfileDetection,
  userPromptForStoreProfileDetection
} from './storeProfileDetectionPrompts.js';
import type { StoreProfileAiClient, StoreProfileAiResult } from './storeProfileDetectionService.js';

export function createOpenAiStoreProfileDetectionClient(
  apiKey: string,
  options: OpenAiClientOptions = {}
): StoreProfileAiClient {
  const responses = createOpenAiResponsesClient(apiKey, options);

  return {
    async detect(request, context): Promise<StoreProfileAiResult> {
      const response = await responses.create({
        model: context.model,
        input: [
          { role: 'system', content: systemPromptForStoreProfileDetection() },
          { role: 'user', content: userPromptForStoreProfileDetection(request) }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'store_profile_detection_result',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                city: { type: 'string' },
                country: { type: 'string' },
                facebookUrl: { type: 'string' },
                instagramUrl: { type: 'string' },
                logoUrl: { type: 'string' },
                metadata: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    confidence: { type: 'number' },
                    evidence: { type: 'array', items: { type: 'string' } },
                    warnings: { type: 'array', items: { type: 'string' } }
                  },
                  required: ['confidence', 'evidence', 'warnings']
                },
                name: { type: 'string' },
                platform: { type: 'string' },
                state: { type: 'string' }
              },
              required: [
                'name',
                'platform',
                'instagramUrl',
                'facebookUrl',
                'city',
                'state',
                'country',
                'logoUrl',
                'metadata'
              ]
            }
          }
        }
      });

      return parseStoreProfileDetectionOutput(response.output_text);
    }
  };
}

export function parseStoreProfileDetectionOutput(output: string): StoreProfileAiResult {
  const parsed = JSON.parse(output) as Record<string, unknown>;
  return {
    city: stringValue(parsed.city),
    country: stringValue(parsed.country),
    facebookUrl: stringValue(parsed.facebookUrl),
    instagramUrl: stringValue(parsed.instagramUrl),
    logoUrl: stringValue(parsed.logoUrl),
    metadata: normalizeMetadata(parsed.metadata),
    name: stringValue(parsed.name),
    platform: stringValue(parsed.platform),
    state: stringValue(parsed.state)
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

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
}
