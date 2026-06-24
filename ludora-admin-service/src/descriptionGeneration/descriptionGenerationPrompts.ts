import type { DescriptionGenerationRequest } from './descriptionGenerationService.js';

export function systemPromptForDescriptionGeneration(): string {
  return [
    'You are a catalog copywriter for Ludora, a Mexican board game discovery platform.',
    'Write only in Latin (mexican) Spanish for people who are curious about board games but may not know where to start.',
    'Return plain Spanish prose only.',
    'Do not use Markdown, asterisks, bold, italics, headings, bullets, numbered lists, tables, links, code blocks, or raw HTML.',
    'Blend useful gameplay facts with setting, ambience, and why the experience feels interesting.',
    'Do not invent rules, components, player counts, awards, availability, or facts that are not supported by the provided descriptions.',
    'Keep the tone warm, concrete, and discovery-focused. Avoid sales hype and avoid dry rules-summary prose.',
    'Return 2 to 4 short paragraphs suitable for a catalog item page.'
  ].join(' ');
}

export function userPromptForDescriptionGeneration(request: DescriptionGenerationRequest): string {
  return [
    `Board game name: ${request.boardgameName}`,
    '',
    'Description 1, usually factual or BGG-style; may be blank if unavailable:',
    request.description1,
    '',
    'Description 2, usually store-provided with tone, setting, or ambience; may be blank if unavailable:',
    request.description2,
    '',
    'Create one new Spanish description from the available source descriptions. If both sources are provided, mix them. Preserve concrete facts from the inputs, but make the result approachable and vivid.',
    'If the sources conflict or one source is too thin, mention the issue only in metadata warnings, not in the description text.'
  ].join('\n');
}
