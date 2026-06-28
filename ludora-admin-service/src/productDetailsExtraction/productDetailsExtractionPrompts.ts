import type { ProductDetailsExtractionRequest } from './productDetailsExtractionService.js';

export function systemPromptForProductDetailsExtraction(): string {
  return [
    'You extract board game product facts for Ludora, a Mexican board game discovery platform.',
    'Return only facts explicitly stated in the provided product description or raw product payload.',
    'Do not infer player counts, play time, or minimum age from the game title, genre, publisher, or common knowledge.',
    'If a field is absent, unclear, marketing-only, or contradictory, return null for that field.',
    'Use integers only. Convert hours to minutes. For ranges, return the lower value as min and upper value as max.'
  ].join(' ');
}

export function userPromptForProductDetailsExtraction(request: ProductDetailsExtractionRequest): string {
  return [
    `Product title: ${request.title}`,
    `Source URL: ${request.sourceUrl}`,
    '',
    'Product description:',
    request.description,
    '',
    'Raw product payload:',
    rawPayloadText(request.rawPayload),
    '',
    'Extract only these board game details if explicitly supported: minimum players, maximum players, minimum minutes, maximum minutes, and minimum age.'
  ].join('\n');
}

function rawPayloadText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value);
}
