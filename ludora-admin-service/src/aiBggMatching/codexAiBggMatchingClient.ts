import OpenAI from 'openai';

import {
  createCodexResponsesClient,
  type CodexResponsesClientOptions
} from '../ai/codexResponsesClient.js';
import {
  systemPromptForAiBggMatch,
  userPromptForAiBggMatch
} from './aiBggMatchingPrompts.js';
import {
  assertAiBggMatchDecisionConsistency,
  type AiBggMatchDecision,
  type AiBggMatchingClient
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
      const content: OpenAI.Responses.ResponseInputContent[] = [
        { type: 'input_text', text: userPromptForAiBggMatch(request) }
      ];
      if (request.imageUrl?.trim()) {
        content.push({ type: 'input_image', image_url: request.imageUrl.trim(), detail: 'high' });
      }

      const response = await responses.create({
        model: context.model,
        instructions: systemPromptForAiBggMatch(),
        input: [{ role: 'user', content }],
        tools: [{ type: 'web_search' }],
        text: {
          format: {
            type: 'json_schema',
            name: 'ai_bgg_match_decision',
            strict: true,
            schema: aiBggMatchSchema
          }
        }
      });

      return parseAiBggMatchDecision(response.output_text);
    }
  };
}

const aiBggMatchDecisionFields = [
  'matchFound',
  'bggId',
  'matchedName',
  'bggUrl',
  'bggImageUrl',
  'nameAssessment',
  'coverAssessment',
  'confidence',
  'reasoning'
] as const;

export function parseAiBggMatchDecision(output: string): AiBggMatchDecision {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed)) {
    invalidDecision('must be an object');
  }

  for (const field of Object.keys(parsed)) {
    if (!aiBggMatchDecisionFields.includes(field as typeof aiBggMatchDecisionFields[number])) {
      invalidDecision(`contains unexpected field ${field}`);
    }
  }
  for (const field of aiBggMatchDecisionFields) {
    if (!Object.hasOwn(parsed, field)) {
      invalidDecision(`missing required field ${field}`);
    }
  }

  const { matchFound, bggId, nameAssessment, coverAssessment, confidence } = parsed;
  if (typeof matchFound !== 'boolean') {
    invalidDecision('matchFound must be a boolean');
  }
  if (bggId !== null && (typeof bggId !== 'number' || !Number.isInteger(bggId))) {
    invalidDecision('bggId must be an integer or null');
  }
  if (nameAssessment !== 'MATCH' && nameAssessment !== 'NO_MATCH') {
    invalidDecision('nameAssessment must be MATCH or NO_MATCH');
  }
  if (coverAssessment !== 'MATCH' && coverAssessment !== 'CONFLICT' && coverAssessment !== 'UNAVAILABLE') {
    invalidDecision('coverAssessment must be MATCH, CONFLICT, or UNAVAILABLE');
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    invalidDecision('confidence must be a finite number between 0 and 1');
  }

  const decision: AiBggMatchDecision = {
    matchFound,
    bggId,
    matchedName: nullableString(parsed.matchedName, 'matchedName'),
    bggUrl: nullableString(parsed.bggUrl, 'bggUrl'),
    bggImageUrl: nullableString(parsed.bggImageUrl, 'bggImageUrl'),
    nameAssessment,
    coverAssessment,
    confidence,
    reasoning: requiredString(parsed.reasoning, 'reasoning')
  };

  assertAiBggMatchDecisionConsistency(decision);

  return decision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    invalidDecision(`${field} must be a string or null`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    invalidDecision(`${field} must be a string`);
  }
  return value;
}

function invalidDecision(message: string): never {
  throw new Error(`Invalid AI BGG match decision: ${message}`);
}
