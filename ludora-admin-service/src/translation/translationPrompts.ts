import type { TranslationPurpose, TranslationRequest } from './translationService.js';

export function systemPromptForPurpose(purpose: TranslationPurpose): string {
  const common =
    'You are a translation assistant for Ludora, a Mexican board game discovery platform. Preserve board game identity, names, player-count hints, expansion indicators, and domain-specific terms.';

  switch (purpose) {
    case 'BGG_SEARCH_QUERY':
      return `${common} Return English BoardGameGeek search text. Remove language/edition noise such as Spanish edition labels, but preserve identity-changing terms such as expansion names, 5-6 player hints, plus, junior, duel, and big box.`;
    case 'ITEM_DESCRIPTION':
      return `${common} Translate board game descriptions faithfully for users. Preserve paragraph boundaries, names, numbers, and rules terminology.`;
    case 'CATEGORY_NAME':
    case 'MECHANIC_NAME':
    case 'FAMILY_NAME':
      return `${common} Translate taxonomy labels into concise, stable Spanish display terminology.`;
    case 'ITEM_TITLE':
      return `${common} Translate or normalize item titles only when there is a known localized title. Preserve the canonical identity.`;
    case 'DISPLAY_TEXT':
    case 'ADMIN_ASSIST':
    default:
      return `${common} Translate clearly and conservatively for admin review.`;
  }
}

export function userPromptForTranslation(request: TranslationRequest): string {
  return [
    `Purpose: ${request.purpose}`,
    `Source language: ${request.sourceLanguage}`,
    `Target language: ${request.targetLanguage}`,
    `Text: ${request.text}`
  ].join('\n');
}
