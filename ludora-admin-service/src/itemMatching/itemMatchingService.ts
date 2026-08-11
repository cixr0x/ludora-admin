import type { AiBggMatchFound, AiBggMatchingService } from '../aiBggMatching/aiBggMatchingService.js';
import type { BggClient } from '../bgg/bggClient.js';
import type { BggItemImporter } from '../bgg/bggItemImporter.js';
import type { BggCachedMatch, BggMatchCache } from '../bgg/bggMatchCache.js';
import type { BggSearchItem } from '../bgg/bggParser.js';
import type { Database } from '../db.js';
import { nullTraceLogger, type TraceLogger } from '../trace.js';
import {
  normalizeTitleVariants,
  scoreBggThing,
  scoreLocalItem,
  type BggThingForMatch,
  type DiscoveryCandidateForMatch,
  type LocalItemForMatch
} from './itemMatcher.js';

export type ItemMatchCandidateRow = {
  bgg_id?: number | null;
  discovery_item_candidate_id?: number;
  id?: number;
  item_id?: number | null;
  match_reasons?: unknown;
  match_score?: number;
  matched_name?: string;
  raw_payload?: unknown;
  source: 'LOCAL' | 'BGG';
  status?: string;
};

export type ItemMatchingService = {
  confirmBoardgameAndMatch?(
    discoveryItemCandidateId: number,
    options?: ConfirmBoardgameOptions
  ): Promise<void>;
  generateMatchCandidates(discoveryItemCandidateId: number): Promise<ItemMatchCandidateRow[]>;
  listMatchCandidates(discoveryItemCandidateId: number): Promise<ItemMatchCandidateRow[]>;
};

type ConfirmBoardgameOptions = {
  confirmationSource?: 'admin' | 'automated';
  traceLogger?: TraceLogger;
};

type DiscoveryItemCandidateRow = {
  id: number;
  image_url?: string | null;
  is_boardgame_confirmed?: boolean | null;
  item_type?: string | null;
  language?: string | null;
  match_source?: 'BGG' | 'LOCAL' | 'NONE' | null;
  max_players?: number | null;
  min_players?: number | null;
  processing_error?: string | null;
  publisher?: string | null;
  title: string;
};

type GeneratedMatchCandidate = {
  accepted: boolean;
  bggId: number | null;
  itemId: number | null;
  matchReasons: string[];
  matchScore: number;
  matchedName: string;
  rawPayload: unknown;
  source: 'LOCAL' | 'BGG';
};

const matchCandidateSelect = `
  id, discovery_item_candidate_id, source, item_id, bgg_id, matched_name,
  match_score, match_reasons, status, raw_payload, created_at, updated_at
`;

const AUTO_MATCH_SCORE_THRESHOLD = 0.9;

export type ItemMatchingDependencies = {
  aiBggMatchingService?: AiBggMatchingService;
  bggClient?: BggClient;
  bggItemImporter?: BggItemImporter;
  bggMatchCache: BggMatchCache;
};

export function createItemMatchingService(
  database: Database,
  dependencies: ItemMatchingDependencies
): ItemMatchingService {
  const { aiBggMatchingService, bggClient, bggItemImporter, bggMatchCache } = dependencies;
  return {
    async confirmBoardgameAndMatch(
      discoveryItemCandidateId: number,
      options: ConfirmBoardgameOptions = {}
    ): Promise<void> {
      const traceLogger = options.traceLogger ?? nullTraceLogger;
      traceLog(traceLogger, 'item_matcher.confirm.start', {
        candidate_id: discoveryItemCandidateId,
        confirmation_source: options.confirmationSource ?? 'admin'
      });
      const candidate = await loadDiscoveryItemCandidate(database, discoveryItemCandidateId);
      traceLog(traceLogger, 'item_matcher.candidate.loaded', {
        candidate_id: discoveryItemCandidateId,
        item_type: candidate.item_type ?? null,
        language: candidate.language ?? null,
        title: candidate.title
      });
      const isAdminConfirmation = options.confirmationSource === 'admin';
      if (
        options.confirmationSource === 'automated' &&
        candidate.is_boardgame_confirmed === true &&
        candidate.match_source === 'NONE' &&
        !nonEmptyStringOrNull(candidate.processing_error)
      ) {
        traceLog(traceLogger, 'item_matcher.confirm.completed', {
          candidate_id: discoveryItemCandidateId,
          result: 'already_confirmed_no_match'
        });
        return;
      }
      await confirmStoreItemAsBoardgame(database, discoveryItemCandidateId, isAdminConfirmation);
      traceLog(traceLogger, 'item_matcher.boardgame.confirmed', {
        candidate_id: discoveryItemCandidateId,
        is_boardgame_confirmed: isAdminConfirmation
      });

      try {
        traceLog(traceLogger, 'item_matcher.local_match.start', { candidate_id: discoveryItemCandidateId });
        const localMatches = await generateLocalMatches(database, candidate);
        const localMatch = bestAcceptedMatch(localMatches);
        traceLog(traceLogger, 'item_matcher.local_match.completed', {
          best_item_id: localMatch?.itemId ?? null,
          best_score: localMatch?.matchScore ?? null,
          candidate_id: discoveryItemCandidateId,
          match_count: localMatches.length
        });
        if (localMatch?.itemId) {
          await linkStoreItemMatch(
            database,
            discoveryItemCandidateId,
            localMatch,
            localMatch.itemId,
            shouldConfirmBoardgameMatch(localMatch, isAdminConfirmation)
          );
          traceLog(traceLogger, 'item_matcher.link.completed', {
            candidate_id: discoveryItemCandidateId,
            item_id: localMatch.itemId,
            match_source: localMatch.source,
            match_score: localMatch.matchScore,
            matched_bgg_id: localMatch.bggId
          });
          traceLog(traceLogger, 'item_matcher.confirm.completed', {
            candidate_id: discoveryItemCandidateId,
            result: 'linked_local_match'
          });
          return;
        }

        traceLog(traceLogger, 'item_matcher.bgg_match.start', { candidate_id: discoveryItemCandidateId });
        const bggMatches = await generateBggMatches(candidate, {
          aiBggMatchingService,
          bggClient,
          bggMatchCache
        }, traceLogger);
        const bggMatch = bestAcceptedMatch(bggMatches);
        traceLog(traceLogger, 'item_matcher.bgg_match.completed', {
          best_bgg_id: bggMatch?.bggId ?? null,
          best_score: bggMatch?.matchScore ?? null,
          candidate_id: discoveryItemCandidateId,
          match_count: bggMatches.length
        });
        if (!bggMatch?.bggId) {
          await markStoreItemMatchNotFound(database, discoveryItemCandidateId, ['no match above threshold'], isAdminConfirmation);
          traceLog(traceLogger, 'item_matcher.no_match', {
            candidate_id: discoveryItemCandidateId,
            match_count: bggMatches.length,
            reason: 'no match above threshold'
          });
          traceLog(traceLogger, 'item_matcher.confirm.completed', {
            candidate_id: discoveryItemCandidateId,
            result: 'no_match'
          });
          return;
        }

        if (!bggItemImporter) {
          await markStoreItemProcessingError(
            database,
            discoveryItemCandidateId,
            'BGG item importer is not configured',
            isAdminConfirmation
          );
          traceLog(traceLogger, 'item_matcher.failed', {
            bgg_id: bggMatch.bggId,
            candidate_id: discoveryItemCandidateId,
            error: 'BGG item importer is not configured'
          });
          return;
        }

        traceLog(traceLogger, 'item_matcher.bgg_import.start', {
          bgg_id: bggMatch.bggId,
          candidate_id: discoveryItemCandidateId
        });
        const itemId = await bggItemImporter.importBggId(bggMatch.bggId);
        traceLog(traceLogger, 'item_matcher.bgg_import.completed', {
          bgg_id: bggMatch.bggId,
          candidate_id: discoveryItemCandidateId,
          item_id: itemId
        });
        if (!itemId) {
          await markStoreItemProcessingError(
            database,
            discoveryItemCandidateId,
            'BGG item could not be imported',
            isAdminConfirmation
          );
          traceLog(traceLogger, 'item_matcher.failed', {
            bgg_id: bggMatch.bggId,
            candidate_id: discoveryItemCandidateId,
            error: 'BGG item could not be imported'
          });
          return;
        }

        await linkStoreItemMatch(
          database,
          discoveryItemCandidateId,
          bggMatch,
          itemId,
          shouldConfirmBoardgameMatch(bggMatch, isAdminConfirmation)
        );
        traceLog(traceLogger, 'item_matcher.link.completed', {
          candidate_id: discoveryItemCandidateId,
          item_id: itemId,
          match_source: bggMatch.source,
          match_score: bggMatch.matchScore,
          matched_bgg_id: bggMatch.bggId
        });
        traceLog(traceLogger, 'item_matcher.confirm.completed', {
          candidate_id: discoveryItemCandidateId,
          result: 'linked_bgg_match'
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Item matching failed';
        await markStoreItemProcessingError(
          database,
          discoveryItemCandidateId,
          message,
          isAdminConfirmation
        );
        traceLog(traceLogger, 'item_matcher.failed', {
          candidate_id: discoveryItemCandidateId,
          error: message
        });
      }
    },

    async generateMatchCandidates(discoveryItemCandidateId: number): Promise<ItemMatchCandidateRow[]> {
      const candidate = await loadDiscoveryItemCandidate(database, discoveryItemCandidateId);
      const localMatches = await generateLocalMatches(database, candidate);
      const bggMatches = hasAcceptedMatch(localMatches)
        ? []
        : await generateBggMatches(candidate, { aiBggMatchingService, bggClient, bggMatchCache });
      const generated = [
        ...localMatches,
        ...bggMatches
      ].filter((match) => match.accepted || match.matchScore >= 0.3);

      await database.query(
        `
        delete from item_match_candidates
        where discovery_item_candidate_id = $1
          and status = 'PENDING'
        `,
        [discoveryItemCandidateId]
      );

      const storedRows: ItemMatchCandidateRow[] = [];
      for (const match of generated) {
        const result = await database.query(
          `
          insert into item_match_candidates (
            discovery_item_candidate_id,
            source,
            item_id,
            bgg_id,
            matched_name,
            match_score,
            match_reasons,
            status,
            raw_payload,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'PENDING', $8::jsonb, now())
          returning ${matchCandidateSelect}
          `,
          [
            candidate.id,
            match.source,
            match.itemId,
            match.bggId,
            match.matchedName,
            match.matchScore,
            JSON.stringify(match.matchReasons),
            JSON.stringify(match.rawPayload)
          ]
        );
        storedRows.push(...(result.rows as ItemMatchCandidateRow[]));
      }

      return storedRows;
    },

    async listMatchCandidates(discoveryItemCandidateId: number): Promise<ItemMatchCandidateRow[]> {
      const result = await database.query(
        `
        select ${matchCandidateSelect}
        from item_match_candidates
        where discovery_item_candidate_id = $1
        order by match_score desc, updated_at desc
        `,
        [discoveryItemCandidateId]
      );
      return result.rows as ItemMatchCandidateRow[];
    }
  };
}

function bestAcceptedMatch(matches: GeneratedMatchCandidate[]): GeneratedMatchCandidate | null {
  return [...matches]
    .filter((match) => match.accepted)
    .sort((left, right) => right.matchScore - left.matchScore)[0] ?? null;
}

function shouldConfirmBoardgameMatch(match: GeneratedMatchCandidate, isAdminConfirmation: boolean): boolean {
  return isAdminConfirmation || match.source === 'LOCAL' || match.bggId !== null;
}

async function confirmStoreItemAsBoardgame(
  database: Database,
  discoveryItemCandidateId: number,
  isBoardgameConfirmed: boolean
): Promise<void> {
  await database.query(
    `
    update store_items
    set is_boardgame = true,
        is_boardgame_confirmed = ${isBoardgameConfirmed ? 'true' : 'false'},
        processing_error = '',
        last_updated = now()
    where id = $1
    `,
    [discoveryItemCandidateId]
  );
}

async function linkStoreItemMatch(
  database: Database,
  discoveryItemCandidateId: number,
  match: GeneratedMatchCandidate,
  itemId: number,
  isBoardgameConfirmed: boolean
): Promise<void> {
  await database.query(
    `
    update store_items
    set item_id = $1,
        is_boardgame = true,
        is_boardgame_confirmed = ${isBoardgameConfirmed ? 'true' : 'false'},
        match_source = $2,
        matched_bgg_id = $3,
        matched_name = $4,
        match_score = $5,
        match_reasons = $6::jsonb,
        match_payload = $7::jsonb,
        matched_at = now(),
        processed_at = now(),
        processing_error = '',
        last_updated = now()
    where id = $8
    `,
    [
      itemId,
      match.source,
      match.bggId,
      match.matchedName,
      match.matchScore,
      JSON.stringify(match.matchReasons),
      JSON.stringify(match.rawPayload),
      discoveryItemCandidateId
    ]
  );
}

async function markStoreItemMatchNotFound(
  database: Database,
  discoveryItemCandidateId: number,
  reasons: string[],
  isBoardgameConfirmed: boolean
): Promise<void> {
  await database.query(
    `
    update store_items
    set is_boardgame = true,
        is_boardgame_confirmed = ${isBoardgameConfirmed ? 'true' : 'false'},
        match_source = 'NONE',
        match_reasons = $1::jsonb,
        match_payload = '{}'::jsonb,
        processed_at = now(),
        processing_error = '',
        last_updated = now()
    where id = $2
    `,
    [JSON.stringify(reasons), discoveryItemCandidateId]
  );
}

async function markStoreItemProcessingError(
  database: Database,
  discoveryItemCandidateId: number,
  error: string,
  isBoardgameConfirmed: boolean
): Promise<void> {
  await database.query(
    `
    update store_items
    set is_boardgame = true,
        is_boardgame_confirmed = ${isBoardgameConfirmed ? 'true' : 'false'},
        processing_error = $1,
        processed_at = now(),
        last_updated = now()
    where id = $2
    `,
    [error, discoveryItemCandidateId]
  );
}

async function loadDiscoveryItemCandidate(database: Database, discoveryItemCandidateId: number): Promise<DiscoveryItemCandidateRow> {
  const result = await database.query(
    `
    select id, title, image_url, publisher, item_type, min_players, max_players, language,
           is_boardgame_confirmed, match_source, processing_error
    from store_items
    where id = $1
    `,
    [discoveryItemCandidateId]
  );
  const row = result.rows[0] as DiscoveryItemCandidateRow | undefined;
  if (!row) {
    throw httpError(404, 'Discovery item candidate not found');
  }
  return row;
}

async function generateLocalMatches(database: Database, candidate: DiscoveryItemCandidateRow): Promise<GeneratedMatchCandidate[]> {
  const normalizedTitleVariants = normalizeTitleVariants(candidate.title);
  const result = await database.query(
    `
    select
      i.id,
      i.canonical_name,
      i.canonical_name_es,
      i.normalized_name,
      i.normalized_name_es,
      i.item_type,
      i.bgg_id,
      coalesce(json_agg(distinct ia.alias) filter (where ia.alias is not null), '[]'::json) as aliases
    from items i
    left join item_aliases ia on ia.item_id = i.id
    where i.normalized_name = any($1::text[])
       or i.normalized_name_es = any($1::text[])
       or ia.normalized_alias = any($1::text[])
    group by i.id, i.canonical_name, i.canonical_name_es, i.normalized_name, i.normalized_name_es, i.item_type, i.bgg_id
    order by i.canonical_name asc
    limit 20
    `,
    [normalizedTitleVariants]
  );

  return result.rows.map((row) => {
    const item = localItemFromRow(row as Record<string, unknown>);
    const score = scoreLocalItem(discoveryCandidateForMatch(candidate), item);
    return {
      accepted: score.matchScore >= AUTO_MATCH_SCORE_THRESHOLD,
      bggId: item.bggId ?? null,
      itemId: item.id,
      matchReasons: score.matchReasons,
      matchScore: score.matchScore,
      matchedName: item.name,
      rawPayload: { item },
      source: 'LOCAL' as const
    };
  });
}

async function generateBggMatches(
  candidate: DiscoveryItemCandidateRow,
  dependencies: Pick<ItemMatchingDependencies, 'aiBggMatchingService' | 'bggClient' | 'bggMatchCache'>,
  traceLogger: TraceLogger = nullTraceLogger
): Promise<GeneratedMatchCandidate[]> {
  traceLog(traceLogger, 'item_matcher.bgg_cache.start', {
    candidate_id: candidate.id,
    query: candidate.title
  });
  const cached = await dependencies.bggMatchCache.lookup(candidate.title, {
    imageUrl: nonEmptyStringOrNull(candidate.image_url)
  });
  const cacheMatches = cached.matches.map((match) => generatedCacheMatch(candidate, match));
  traceLog(traceLogger, 'item_matcher.bgg_cache.completed', {
    accepted_match: hasAcceptedMatch(cacheMatches),
    cache_hit: cached.cacheHit,
    candidate_id: candidate.id,
    match_count: cacheMatches.length
  });
  if (hasAcceptedMatch(cacheMatches)) {
    return cacheMatches;
  }

  const aiMatch = await generateAiBggMatch(candidate, dependencies, traceLogger);
  return aiMatch ? mergeMatchesByBggId([...cacheMatches, aiMatch]) : cacheMatches;
}

function generatedCacheMatch(
  candidate: DiscoveryItemCandidateRow,
  cached: BggCachedMatch
): GeneratedMatchCandidate {
  const score = scoreBggThing(discoveryCandidateForMatch(candidate), bggThingFromSearchItem(cached.item));
  return {
    accepted: cached.verifiedByAi || score.matchScore >= AUTO_MATCH_SCORE_THRESHOLD,
    bggId: cached.item.bggId,
    itemId: null,
    matchReasons: cached.verifiedByAi
      ? ['AI-verified BGG cache association', ...score.matchReasons]
      : score.matchReasons,
    matchScore: cached.verifiedByAi
      ? Math.max(score.matchScore, AUTO_MATCH_SCORE_THRESHOLD)
      : score.matchScore,
    matchedName: cached.item.name,
    rawPayload: {
      search_result: cached.item,
      source: cached.verifiedByAi ? 'ai_match_cache' : 'bgg_cache'
    },
    source: 'BGG'
  };
}

async function generateAiBggMatch(
  candidate: DiscoveryItemCandidateRow,
  dependencies: Pick<ItemMatchingDependencies, 'aiBggMatchingService' | 'bggClient' | 'bggMatchCache'>,
  traceLogger: TraceLogger
): Promise<GeneratedMatchCandidate | null> {
  if (!dependencies.aiBggMatchingService) {
    return null;
  }

  const imageUrl = nonEmptyStringOrNull(candidate.image_url);
  traceLog(traceLogger, 'item_matcher.ai_match.start', {
    candidate_id: candidate.id,
    has_image: imageUrl !== null,
    item_name: candidate.title
  });
  let decision: AiBggMatchFound | null | undefined;
  try {
    decision = await dependencies.aiBggMatchingService.findMatch({
      itemName: candidate.title,
      imageUrl
    });
    traceLog(traceLogger, 'item_matcher.ai_match.completed', {
      ...aiDecisionTraceFields(decision),
      candidate_id: candidate.id,
      match_found: decision !== null
    });
    if (!decision) {
      traceLog(traceLogger, 'item_matcher.ai_match.no_match', {
        candidate_id: candidate.id
      });
      return null;
    }

    if (!dependencies.bggClient) {
      throw new Error('BGG client is not configured');
    }
    const thing = await dependencies.bggClient.fetchThing(decision.bggId);
    const idValidated = Boolean(thing && thing.details.bggId === decision.bggId);
    const nameValidated = Boolean(
      thing && idValidated && bggThingContainsAiMatchedName(
        decision.matchedName,
        thing.details.name,
        thing.details.alternateNames
      )
    );
    const validated = idValidated && nameValidated;
    traceLog(traceLogger, 'item_matcher.ai_match.validation.completed', {
      bgg_id: decision.bggId,
      candidate_id: candidate.id,
      id_validated: idValidated,
      name_validated: nameValidated,
      validated
    });
    if (!thing || !idValidated) {
      throw new Error(`AI BGG match could not validate BGG ID ${decision.bggId}`);
    }
    if (!nameValidated) {
      throw new Error(`AI BGG match name did not match BGG ID ${decision.bggId}`);
    }

    const searchItem: BggSearchItem = {
      bggId: thing.details.bggId,
      name: thing.details.name,
      type: thing.details.type,
      yearPublished: thing.details.yearPublished
    };
    await dependencies.bggMatchCache.recordAiMatch(
      [candidate.title, thing.details.name],
      searchItem,
      { imageUrl }
    );
    traceLog(traceLogger, 'item_matcher.ai_match.cache.completed', {
      bgg_id: decision.bggId,
      candidate_id: candidate.id,
      query_count: 2
    });

    return {
      accepted: true,
      bggId: decision.bggId,
      itemId: null,
      matchReasons: ['AI-validated BGG match', decision.reasoning],
      matchScore: decision.confidence,
      matchedName: thing.details.name,
      rawPayload: { ai_match: decision, thing: thing.details },
      source: 'BGG'
    };
  } catch (error) {
    traceLog(traceLogger, 'item_matcher.ai_match.failed', {
      ...aiDecisionTraceFields(decision),
      candidate_id: candidate.id,
      error: error instanceof Error ? error.message : 'AI BGG matching failed'
    });
    throw error;
  }
}

function bggThingContainsAiMatchedName(
  aiMatchedName: string,
  primaryName: string,
  alternateNames: string[]
): boolean {
  const aiNameVariants = new Set(normalizeTitleVariants(aiMatchedName));
  return [primaryName, ...alternateNames].some((name) =>
    normalizeTitleVariants(name).some((variant) => aiNameVariants.has(variant))
  );
}

function aiDecisionTraceFields(decision: AiBggMatchFound | null | undefined): Record<string, unknown> {
  return {
    bgg_id: decision?.bggId ?? null,
    matched_name: decision?.matchedName ?? null,
    name_assessment: decision?.nameAssessment ?? null,
    cover_assessment: decision?.coverAssessment ?? null,
    confidence: decision?.confidence ?? null
  };
}

function hasAcceptedMatch(matches: GeneratedMatchCandidate[]): boolean {
  return matches.some((match) => match.accepted);
}

function discoveryCandidateForMatch(candidate: DiscoveryItemCandidateRow): DiscoveryCandidateForMatch {
  return {
    itemType: candidate.item_type,
    maxPlayers: candidate.max_players,
    minPlayers: candidate.min_players,
    publisher: candidate.publisher,
    title: candidate.title
  };
}

function localItemFromRow(row: Record<string, unknown>): LocalItemForMatch {
  const item: LocalItemForMatch = {
    aliases: stringList(row.aliases),
    bggId: numberOrNull(row.bgg_id),
    id: Number(row.id),
    itemType: stringOrNull(row.item_type),
    name: String(row.canonical_name ?? ''),
    normalizedName: String(row.normalized_name ?? '')
  };
  const nameEs = stringOrNull(row.canonical_name_es)?.trim();
  const normalizedNameEs = stringOrNull(row.normalized_name_es)?.trim();
  if (nameEs) {
    item.nameEs = nameEs;
  }
  if (normalizedNameEs) {
    item.normalizedNameEs = normalizedNameEs;
  }
  return item;
}

function mergeMatchesByBggId(matches: GeneratedMatchCandidate[]): GeneratedMatchCandidate[] {
  const merged = new Map<number | null, GeneratedMatchCandidate>();
  for (const match of matches) {
    const existing = merged.get(match.bggId);
    if (
      !existing ||
      (match.accepted && !existing.accepted) ||
      (match.accepted === existing.accepted && match.matchScore > existing.matchScore)
    ) {
      merged.set(match.bggId, match);
    }
  }
  return [...merged.values()].sort((left, right) => right.matchScore - left.matchScore);
}

function bggThingFromSearchItem(searchResult: BggSearchItem): BggThingForMatch {
  return {
    alternateNames: [],
    bggId: searchResult.bggId,
    maxPlayers: null,
    minPlayers: null,
    name: searchResult.name,
    publishers: [],
    type: searchResult.type,
    yearPublished: searchResult.yearPublished
  };
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return stringList(parsed);
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function nonEmptyStringOrNull(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function traceLog(traceLogger: TraceLogger, event: string, fields: Record<string, unknown> = {}): void {
  try {
    traceLogger.log(event, fields);
  } catch {
    return;
  }
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
