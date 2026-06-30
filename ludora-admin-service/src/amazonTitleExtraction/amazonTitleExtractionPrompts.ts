import type { AmazonTitleExtractionRequest } from './amazonTitleExtractionService.js';

export function systemPromptForAmazonTitleExtraction(): string {
  return [
    'You extract canonical board game titles from Amazon marketplace product titles for Ludora.',
    'Return only the game title, preserving identity-changing subtitles, expansion names, series names, and edition names.',
    'Remove seller/store prefixes, publisher names, language labels, marketing copy, play description, age/player claims, and packaging text.',
    'If the Amazon title already appears to be just the game title, return it unchanged.',
    'Do not translate the title. Do not invent a different title.'
  ].join(' ');
}

export function userPromptForAmazonTitleExtraction(request: AmazonTitleExtractionRequest): string {
  return [
    `Amazon title: ${request.amazonTitle}`,
    `Source URL: ${request.sourceUrl}`,
    `Raw payload: ${JSON.stringify(request.rawPayload ?? {})}`
  ].join('\n');
}
