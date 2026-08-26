import {
  createCodexResponsesClient,
  type CodexResponsesClientOptions
} from '../ai/codexResponsesClient.js';
import {
  systemPromptForAutoListEvaluation,
  userPromptForAutoListEvaluation
} from './autoListEvaluationPrompts.js';
import type {
  AutoListAiDecision,
  AutoListEvaluationClient
} from './autoListEvaluationService.js';

export const autoListEvaluationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'NOT PASS'] },
    sameGame: { type: 'boolean' },
    sameGameReasoning: { type: 'string' },
    storeCoverLanguage: { type: 'string' },
    itemCoverLanguage: { type: 'string' },
    languageReasoning: { type: 'string' },
    nameMatches: { type: 'boolean' },
    nameReasoning: { type: 'string' },
    reasoning: { type: 'string' }
  },
  required: [
    'verdict',
    'sameGame',
    'sameGameReasoning',
    'storeCoverLanguage',
    'itemCoverLanguage',
    'languageReasoning',
    'nameMatches',
    'nameReasoning',
    'reasoning'
  ]
} as const;

export function createCodexAutoListEvaluationClient(
  options: CodexResponsesClientOptions
): AutoListEvaluationClient {
  const responses = createCodexResponsesClient(options);

  return {
    async evaluate(request, context): Promise<AutoListAiDecision> {
      const response = await responses.create({
        model: context.model,
        instructions: systemPromptForAutoListEvaluation(),
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: userPromptForAutoListEvaluation(request) },
            { type: 'input_text', text: 'Attached image 1: store item cover.' },
            ...imageContent(request.storeItemImageUrl, 'Store item cover is missing.'),
            { type: 'input_text', text: `Attached image 2: catalog item cover from ${request.itemImageSource}.` },
            ...imageContent(request.itemImageUrl, 'Catalog item cover is missing.')
          ]
        }],
        text: {
          format: {
            type: 'json_schema',
            name: 'auto_list_evaluation',
            strict: true,
            schema: autoListEvaluationSchema
          }
        }
      });

      return parseAutoListAiDecision(response.output_text);
    }
  };
}

function imageContent(imageUrl: string, missingText: string) {
  return imageUrl
    ? [{ type: 'input_image' as const, image_url: imageUrl, detail: 'high' as const }]
    : [{ type: 'input_text' as const, text: missingText }];
}

const decisionFields = [
  'verdict',
  'sameGame',
  'sameGameReasoning',
  'storeCoverLanguage',
  'itemCoverLanguage',
  'languageReasoning',
  'nameMatches',
  'nameReasoning',
  'reasoning'
] as const;

export function parseAutoListAiDecision(output: string): AutoListAiDecision {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed)) {
    invalidDecision('must be an object');
  }

  for (const field of Object.keys(parsed)) {
    if (!decisionFields.includes(field as typeof decisionFields[number])) {
      invalidDecision(`contains unexpected field ${field}`);
    }
  }
  for (const field of decisionFields) {
    if (!Object.hasOwn(parsed, field)) {
      invalidDecision(`missing required field ${field}`);
    }
  }

  if (parsed.verdict !== 'PASS' && parsed.verdict !== 'NOT PASS') {
    invalidDecision('verdict must be PASS or NOT PASS');
  }
  if (typeof parsed.sameGame !== 'boolean') {
    invalidDecision('sameGame must be a boolean');
  }
  if (typeof parsed.nameMatches !== 'boolean') {
    invalidDecision('nameMatches must be a boolean');
  }

  return {
    itemCoverLanguage: requiredString(parsed.itemCoverLanguage, 'itemCoverLanguage'),
    languageReasoning: requiredString(parsed.languageReasoning, 'languageReasoning'),
    nameMatches: parsed.nameMatches,
    nameReasoning: requiredString(parsed.nameReasoning, 'nameReasoning'),
    reasoning: requiredString(parsed.reasoning, 'reasoning'),
    sameGame: parsed.sameGame,
    sameGameReasoning: requiredString(parsed.sameGameReasoning, 'sameGameReasoning'),
    storeCoverLanguage: requiredString(parsed.storeCoverLanguage, 'storeCoverLanguage'),
    verdict: parsed.verdict
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    invalidDecision(`${field} must be a string`);
  }
  return value;
}

function invalidDecision(message: string): never {
  throw new Error(`Invalid auto-list evaluation decision: ${message}`);
}
