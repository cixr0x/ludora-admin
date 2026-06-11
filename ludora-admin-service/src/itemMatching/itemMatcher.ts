import type { BggNamedLink } from '../bgg/bggParser.js';

export type DiscoveryCandidateForMatch = {
  itemType?: string | null;
  maxPlayers?: number | null;
  minPlayers?: number | null;
  publisher?: string | null;
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
  } else if ([canonicalName, ...spanishNames].some((name) => hasTitleOverlap(candidateTitle, name))) {
    score = 0.55;
    reasons.push('substring title overlap only');
    reasons.push(...meaningfulExtraTokenReasons(candidateTitle, canonicalName));
  } else {
    reasons.push('no exact local name match');
  }

  if (itemTypeConflicts(candidate.itemType, item.itemType)) {
    score -= 0.25;
    reasons.push('item type conflict');
  }

  return { matchReasons: reasons, matchScore: clampScore(score) };
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
  return uniqueNormalizedTitles([value, stripLanguageEditionParentheticals(value)]);
}

const LANGUAGE_TOKENS = new Set([
  'aleman',
  'castellano',
  'deutsch',
  'english',
  'espanol',
  'francais',
  'frances',
  'french',
  'german',
  'ingles',
  'italian',
  'italiano',
  'portugues',
  'portuguese',
  'spanish'
]);

const LANGUAGE_EDITION_FILLER_TOKENS = new Set(['edition', 'edicion', 'en', 'idioma', 'language', 'version']);

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
