import {
  createCodexResponsesClient,
  type CodexResponsesClientOptions
} from '../ai/codexResponsesClient.js';
import {
  systemPromptForAiBggMatch,
  userPromptForAiBggMatch
} from './aiBggMatchingPrompts.js';
import type {
  AiBggMatchDecision,
  AiBggMatchingClient
} from './aiBggMatchingService.js';

export const aiBggMatchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    matchFound: { type: 'boolean' },
    bggId: { type: ['integer', 'null'] },
    matchedName: { type: ['string', 'null'] },
    bggUrl: { type: ['string', 'null'] },
    bggImageUrl: { type: ['string', 'null'] },
    nameAssessment: { type: 'string', enum: ['MATCH', 'NO_MATCH'] },
    coverAssessment: { type: 'string', enum: ['MATCH', 'CONFLICT', 'UNAVAILABLE'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasoning: { type: 'string' }
  },
  required: ['matchFound', 'bggId', 'matchedName', 'bggUrl', 'bggImageUrl', 'nameAssessment', 'coverAssessment', 'confidence', 'reasoning']
} as const;

export function createCodexAiBggMatchingClient(
  options: CodexResponsesClientOptions
): AiBggMatchingClient {
  const responses = createCodexResponsesClient(options);

  return {
    async findMatch(request, context): Promise<AiBggMatchDecision> {
      const response = await responses.create({
        model: context.model,
        input: [
          {
            role: 'system',
            content: systemPromptForAiBggMatch()
          },
          {
            role: 'user',
            content: userPromptForAiBggMatch(request)
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'ai_bgg_match_decision',
            strict: true,
            schema: aiBggMatchSchema
          }
        }
      });

      return JSON.parse(response.output_text) as AiBggMatchDecision;
    }
  };
}
