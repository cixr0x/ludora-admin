import type { BggNamedLink } from '../bgg/bggParser.js';

export type DiscoveryCandidateForMatch = {
  itemType?: string | null;
  maxPlayers?: number | null;
  minPlayers?: number | null;
  publisher?: string | null;
  storeName?: string | null;
  title: string;
};

export type BggThingForMatch = {
  alternateNames: string[];
  bggId: number;
  maxPlayers?: number | null;
  minPlayers?: number | null;
  name: string;
  publishers: BggNamedLink[];
  type: string;
  yearPublished?: number | null;
};

export type LocalItemForMatch = {
  aliases: string[];
  bggId?: number | null;
  id: number;
  itemType?: string | null;
  name: string;
  nameEs?: string;
  normalizedName: string;
  normalizedNameEs?: string;
  publishers?: string[];
};

export type MatchScore = {
  matchReasons: string[];
  matchScore: number;
};

const MEANINGFUL_EXTRA_TOKENS = new Set([
  '5',
  '6',
  'anniversary',
  'big',
  'box',
  'card',
  'collector',
  'dice',
  'duel',
  'expansion',
  'juego',
  'junior',
  'legacy',
  'plus',
  'roll',
  'travel',
  'write'
]);

const TITLE_STOP_TOKENS = new Set([
  'a',
  'al',
  'an',
  'and',
  'con',
  'de',
  'del',
  'el',
  'en',
  'for',
  'la',
  'las',
  'los',
  'of',
  'or',
  'para',
  'the',
  'un',
  'una',
  'y'
]);

const LISTING_MARKETING_TOKENS = new Set([
  'nuevo',
  'nueva',
  'nuevos',
  'nuevas',
  'oficial',
  'original',
  'producto',
  'sellado',
  'sellada',
  'sellados',
  'selladas'
]);

const TITLE_TOKEN_ALIASES = new Map([
  ['exp', 'expansion']
]);

export function scoreBggThing(candidate: DiscoveryCandidateForMatch, thing: BggThingForMatch): MatchScore {
  const reasons: string[] = [];
  const candidateTitle = normalizeTitle(candidate.title);
  const candidateTitleVariants = normalizeTitleVariants(candidate.title);
  const names = [{ label: 'primary', value: thing.name }, ...thing.alternateNames.map((value) => ({ label: 'alternate', value }))];
  const exactName = names.find((name) => candidateTitleVariants.includes(normalizeTitle(name.value)));
  let score = 0.2;

  if (exactName) {
    score = 0.9;
    const reasonSuffix = normalizeTitle(exactName.value) === candidateTitle ? '' : ' after ignoring language edition';
    reasons.push(`exact BGG ${exactName.label} name match${reasonSuffix}`);
  } else {
    const bestName = names.find((name) => hasTitleOverlap(candidateTitle, normalizeTitle(name.value)));
    if (bestName) {
      score = 0.55;
      reasons.push('substring title overlap only');
      reasons.push(...meaningfulExtraTokenReasons(candidateTitle, normalizeTitle(bestName.value)));
    } else {
      reasons.push('no exact BGG name match');
    }
  }

  const typeConflict = itemTypeConflicts(candidate.itemType, bggTypeToItemType(thing.type));
  if (typeConflict) {
    score -= 0.25;
    reasons.push('item type conflict');
  }

  if (publisherOverlaps(candidate.publisher, thing.publishers)) {
    score += 0.03;
    reasons.push('publisher overlap');
  }

  if (candidate.minPlayers && thing.minPlayers && candidate.minPlayers === thing.minPlayers) {
    score += 0.02;
    reasons.push('minimum players match');
  }

  if (candidate.maxPlayers && thing.maxPlayers && candidate.maxPlayers === thing.maxPlayers) {
    score += 0.02;
    reasons.push('maximum players match');
  }

  return { matchReasons: reasons, matchScore: clampScore(score) };
}

export function scoreLocalItem(candidate: DiscoveryCandidateForMatch, item: LocalItemForMatch): MatchScore {
  const reasons: string[] = [];
  const candidateTitle = normalizeTitle(candidate.title);
  const candidateTitleVariants = normalizeTitleVariants(candidate.title);
  const canonicalName = normalizeTitle(item.name || item.normalizedName);
  const spanishNames = [item.nameEs, item.normalizedNameEs].map((value) => normalizeTitle(value ?? '')).filter(Boolean);
  const aliases = item.aliases.map(normalizeTitle);
  let score = 0.2;

  if (candidateTitleVariants.includes(canonicalName) || candidateTitleVariants.includes(normalizeTitle(item.normalizedName))) {
    score = 0.94;
    const reasonSuffix =
      candidateTitle === canonicalName || candidateTitle === normalizeTitle(item.normalizedName)
        ? ''
        : ' after ignoring language edition';
    reasons.push(`exact local item name match${reasonSuffix}`);
  } else if (spanishNames.some((name) => candidateTitleVariants.includes(name))) {
    score = 0.94;
    const reasonSuffix = spanishNames.includes(candidateTitle) ? '' : ' after ignoring language edition';
    reasons.push(`exact local Spanish item name match${reasonSuffix}`);
  } else if (aliases.some((alias) => candidateTitleVariants.includes(alias))) {
    score = 0.94;
    const reasonSuffix = aliases.includes(candidateTitle) ? '' : ' after ignoring language edition';
    reasons.push(`exact local alias match${reasonSuffix}`);
  } else {
    const fuzzyMatch = bestLocalTokenMatch(candidate, item, [
      { label: 'item name', value: canonicalName },
      ...spanishNames.map((value) => ({ label: 'Spanish item name', value })),
      ...aliases.map((value) => ({ label: 'alias', value }))
    ]);
    if (fuzzyMatch) {
      score = fuzzyMatch.score;
      reasons.push(...fuzzyMatch.reasons);
    } else {
      reasons.push('no local name token overlap');
    }
  }

  if (itemTypeConflicts(candidate.itemType, item.itemType)) {
    score -= 0.25;
    reasons.push('item type conflict');
  }

  return { matchReasons: reasons, matchScore: clampScore(score) };
}

export function localMatchSearchTokens(candidate: DiscoveryCandidateForMatch): string[] {
  const titleTokens = significantTitleTokens(normalizeTitle(candidate.title));
  const ignoredTokens = ignoredListingTokens(candidate, []);
  const contentTokens = titleTokens.filter((token) => !ignoredTokens.has(token));
  const distinctiveTokens = contentTokens.filter((token) => token.length >= 3 || /^\d+$/.test(token));
  const selected = distinctiveTokens.length > 0
    ? distinctiveTokens
    : contentTokens.length > 0
      ? contentTokens
      : titleTokens;
  return selected.slice(0, 12);
}

export function normalizeTitle(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

export function normalizeTitleVariants(value: string): string[] {
  return uniqueNormalizedTitles([value, stripLanguageEditionParentheticals(value), stripTrailingLanguageEdition(value)]);
}

const LANGUAGE_TOKENS = new Set([
  'aleman',
  'alemana',
  'castellano',
  'castellana',
  'deutsch',
  'english',
  'espanol',
  'espanola',
  'francais',
  'francaise',
  'frances',
  'francesa',
  'french',
  'german',
  'ingles',
  'inglesa',
  'italian',
  'italiano',
  'italiana',
  'portugues',
  'portuguesa',
  'portuguese',
  'spanish'
]);

const LANGUAGE_EDITION_FILLER_TOKENS = new Set(['edition', 'edicion', 'en', 'idioma', 'language', 'version']);

type LocalNameTokenMatch = {
  reasons: string[];
  score: number;
};

function bestLocalTokenMatch(
  candidate: DiscoveryCandidateForMatch,
  item: LocalItemForMatch,
  names: Array<{ label: string; value: string }>
): LocalNameTokenMatch | null {
  const matches = names
    .filter(({ value }) => Boolean(value))
    .map(({ label, value }) => scoreLocalNameTokens(candidate, item, label, value))
    .filter((match): match is LocalNameTokenMatch => match !== null)
    .sort((left, right) => right.score - left.score);
  return matches[0] ?? null;
}

function scoreLocalNameTokens(
  candidate: DiscoveryCandidateForMatch,
  item: LocalItemForMatch,
  label: string,
  matchedName: string
): LocalNameTokenMatch | null {
  const candidateTokens = significantTitleTokens(normalizeTitle(candidate.title));
  const matchedTokens = significantTitleTokens(matchedName);
  if (candidateTokens.length === 0 || matchedTokens.length === 0) {
    return null;
  }

  const candidateTokenSet = new Set(candidateTokens);
  const matchedTokenSet = new Set(matchedTokens);
  const overlap = matchedTokens.filter((token) => candidateTokenSet.has(token));
  if (overlap.length === 0) {
    return null;
  }

  const ignoredTokens = ignoredListingTokens(candidate, item.publishers ?? []);
  const extraTokens = candidateTokens.filter((token) => !matchedTokenSet.has(token));
  const ignoredExtraTokens = extraTokens.filter((token) => ignoredTokens.has(token));
  const unexpectedExtraTokens = extraTokens.filter((token) => !ignoredTokens.has(token));
  const meaningfulUnexpectedExtraTokens = unexpectedExtraTokens.filter((token) =>
    MEANINGFUL_EXTRA_TOKENS.has(token)
  );
  const missingTokens = matchedTokens.filter((token) => !candidateTokenSet.has(token));
  const fullCatalogTitleCoverage = missingTokens.length === 0;
  const strongContainedMatch = fullCatalogTitleCoverage && unexpectedExtraTokens.length === 0;
  const comparableCandidateTokens = candidateTokens.filter((token) => !ignoredTokens.has(token));
  const sharedPhrase = longestSharedContiguousTokenPhrase(comparableCandidateTokens, matchedTokens);
  const sharedPhraseTokens = new Set(sharedPhrase);
  const additionalSharedTokens = overlap.filter((token) => !sharedPhraseTokens.has(token));
  const strongCompleteEmbeddedTitleMatch =
    matchedTokens.length >= 3 &&
    sharedPhrase.length === matchedTokens.length;
  const strongEmbeddedPhraseMatch =
    sharedPhrase.length >= 2 &&
    additionalSharedTokens.length >= 1 &&
    meaningfulUnexpectedExtraTokens.length === 0;

  const reasons: string[] = [];
  let score: number;
  if (strongContainedMatch) {
    score = 0.92;
    reasons.push(`order-independent local ${label} match`);
  } else if (strongCompleteEmbeddedTitleMatch) {
    score = 0.91;
    reasons.push(`complete embedded local ${label} match: ${sharedPhrase.join(' ')}`);
  } else if (strongEmbeddedPhraseMatch) {
    score = 0.91;
    reasons.push(`embedded local ${label} phrase match: ${sharedPhrase.join(' ')}`);
    reasons.push(`additional shared local title tokens: ${additionalSharedTokens.join(', ')}`);
  } else {
    const precision = overlap.length / (overlap.length + unexpectedExtraTokens.length);
    const recall = overlap.length / matchedTokens.length;
    const tokenF1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    score = Math.min(0.89, 0.2 + (0.69 * tokenF1));
    reasons.push(`local ${label} token overlap: ${overlap.length}/${matchedTokens.length}`);
  }

  if (ignoredExtraTokens.length > 0) {
    reasons.push(`ignored listing context tokens: ${ignoredExtraTokens.join(', ')}`);
  }
  if (missingTokens.length > 0) {
    reasons.push(`missing local title tokens: ${missingTokens.join(', ')}`);
  }
  for (const token of unexpectedExtraTokens) {
    reasons.push(
      MEANINGFUL_EXTRA_TOKENS.has(token)
        ? `meaningful extra title token: ${token}`
        : `unexplained extra title token: ${token}`
    );
  }

  return { reasons, score };
}

function significantTitleTokens(normalizedTitle: string): string[] {
  const tokens = uniqueTokens(
    normalizedTitle
      .split(' ')
      .filter(Boolean)
      .map((token) => TITLE_TOKEN_ALIASES.get(token) ?? token)
  );
  const significantTokens = tokens.filter((token) => !TITLE_STOP_TOKENS.has(token));
  return significantTokens.length > 0 ? significantTokens : tokens;
}

function longestSharedContiguousTokenPhrase(leftTokens: string[], rightTokens: string[]): string[] {
  let bestStart = 0;
  let bestLength = 0;
  for (let leftIndex = 0; leftIndex < leftTokens.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < rightTokens.length; rightIndex += 1) {
      let length = 0;
      while (
        leftIndex + length < leftTokens.length &&
        rightIndex + length < rightTokens.length &&
        leftTokens[leftIndex + length] === rightTokens[rightIndex + length]
      ) {
        length += 1;
      }
      if (length > bestLength) {
        bestStart = leftIndex;
        bestLength = length;
      }
    }
  }
  return leftTokens.slice(bestStart, bestStart + bestLength);
}

function ignoredListingTokens(candidate: DiscoveryCandidateForMatch, itemPublishers: string[]): Set<string> {
  const ignoredTokens = new Set<string>([
    ...LANGUAGE_TOKENS,
    ...LANGUAGE_EDITION_FILLER_TOKENS,
    ...LISTING_MARKETING_TOKENS
  ]);
  for (const context of [candidate.publisher, candidate.storeName, ...itemPublishers]) {
    for (const token of normalizeTitle(context ?? '').split(' ').filter(Boolean)) {
      ignoredTokens.add(token);
    }
  }

  const normalizedCandidateTitle = normalizeTitle(candidate.title);
  addPhraseTokensWhenPresent(ignoredTokens, normalizedCandidateTitle, ['juego de mesa', 'juegos de mesa']);
  addPhraseTokensWhenPresent(ignoredTokens, normalizedCandidateTitle, ['board game', 'board games']);
  addPhraseTokensWhenPresent(ignoredTokens, normalizedCandidateTitle, ['tabletop game', 'tabletop games']);
  return ignoredTokens;
}

function addPhraseTokensWhenPresent(target: Set<string>, normalizedTitle: string, phrases: string[]): void {
  const paddedTitle = ` ${normalizedTitle} `;
  for (const phrase of phrases) {
    if (paddedTitle.includes(` ${phrase} `)) {
      for (const token of phrase.split(' ')) {
        target.add(token);
      }
    }
  }
}

function uniqueTokens(tokens: string[]): string[] {
  return Array.from(new Set(tokens));
}

function stripLanguageEditionParentheticals(value: string): string {
  return value.replace(/\(([^()]*)\)/g, (segment, content) => {
    const tokens = normalizeTitle(content).split(' ').filter(Boolean);
    if (tokens.length === 0) {
      return segment;
    }
    const hasLanguageToken = tokens.some((token) => LANGUAGE_TOKENS.has(token));
    const hasOnlyLanguageEditionTokens = tokens.every(
      (token) => LANGUAGE_TOKENS.has(token) || LANGUAGE_EDITION_FILLER_TOKENS.has(token)
    );
    return hasLanguageToken && hasOnlyLanguageEditionTokens ? ' ' : segment;
  });
}

function stripTrailingLanguageEdition(value: string): string {
  const tokens = normalizeTitle(value).split(' ').filter(Boolean);
  if (tokens.length < 2) {
    return value;
  }

  let suffixStart = tokens.length;
  let hasLanguageToken = false;
  while (suffixStart > 0) {
    const token = tokens[suffixStart - 1];
    if (LANGUAGE_TOKENS.has(token)) {
      hasLanguageToken = true;
      suffixStart -= 1;
      continue;
    }
    if (LANGUAGE_EDITION_FILLER_TOKENS.has(token)) {
      suffixStart -= 1;
      continue;
    }
    break;
  }

  if (!hasLanguageToken || suffixStart === 0 || suffixStart === tokens.length) {
    return value;
  }

  return tokens.slice(0, suffixStart).join(' ');
}

function uniqueNormalizedTitles(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeTitle).filter(Boolean)));
}

function hasTitleOverlap(candidateTitle: string, matchedTitle: string): boolean {
  return Boolean(candidateTitle && matchedTitle && (candidateTitle.includes(matchedTitle) || matchedTitle.includes(candidateTitle)));
}

function meaningfulExtraTokenReasons(candidateTitle: string, matchedTitle: string): string[] {
  const matchedTokens = new Set(matchedTitle.split(' ').filter(Boolean));
  return candidateTitle
    .split(' ')
    .filter((token) => token && !matchedTokens.has(token) && MEANINGFUL_EXTRA_TOKENS.has(token))
    .map((token) => `meaningful extra title token: ${token}`);
}

function itemTypeConflicts(candidateType?: string | null, matchedType?: string | null): boolean {
  if (!candidateType || candidateType === 'unknown' || !matchedType || matchedType === 'unknown') {
    return false;
  }
  return candidateType !== matchedType;
}

function bggTypeToItemType(type: string): string {
  if (type === 'boardgameexpansion') {
    return 'expansion';
  }
  if (type === 'boardgame') {
    return 'base_game';
  }
  return 'unknown';
}

function publisherOverlaps(candidatePublisher: string | null | undefined, publishers: BggNamedLink[]): boolean {
  const normalizedCandidate = normalizeTitle(candidatePublisher ?? '');
  if (!normalizedCandidate) {
    return false;
  }
  return publishers.some((publisher) => normalizeTitle(publisher.name) === normalizedCandidate);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(0.99, Number(value.toFixed(4))));
}
