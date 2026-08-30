import type { Database } from '../db.js';
import type {
  ImageSimilarityResult,
  ImageSimilarityService
} from '../imageSimilarity/imageSimilarityService.js';

export const AUTO_LIST_IMAGE_SIMILARITY_THRESHOLD = 95;

export type AutoListVerdict = 'PASS' | 'NOT PASS';

export type AutoListEvaluationRequest = {
  itemImageSource: 'image_url_es' | 'image_url';
  itemImageUrl: string;
  itemNameEn: string;
  itemNameEs: string;
  storeItemImageUrl: string;
  storeItemName: string;
};

export type AutoListAiDecision = {
  itemCoverLanguage: string;
  languageReasoning: string;
  nameMatches: boolean;
  nameReasoning: string;
  reasoning: string;
  sameGame: boolean;
  sameGameReasoning: string;
  storeCoverLanguage: string;
  verdict: AutoListVerdict;
};

export type AutoListEvaluationClient = {
  evaluate(request: AutoListEvaluationRequest, context: { model: string }): Promise<AutoListAiDecision>;
};

export type AutoListImageSimilarity =
  | (ImageSimilarityResult & {
      pass: boolean;
      reasoning: string;
      status: 'COMPLETED';
      threshold: number;
    })
  | {
      pass: false;
      reasoning: string;
      score: null;
      status: 'ERROR';
      threshold: number;
    };

export type CompletedAutoListEvaluation = {
  auto_list_eligible: boolean;
  checks: {
    cover_language: {
      item_language: string;
      pass: boolean;
      reasoning: string;
      store_language: string;
    };
    name_match: {
      pass: boolean;
      reasoning: string;
    };
    same_game: {
      pass: boolean;
      reasoning: string;
    };
  };
  evaluated_at: string;
  image_similarity: AutoListImageSimilarity;
  inputs: AutoListEvaluationRequest & {
    item_id: number;
    store_item_id: number;
  };
  model: string;
  reasoning: string;
  status: 'COMPLETED';
  verdict: AutoListVerdict;
  version: 2;
};

export type ErrorAutoListEvaluation = {
  auto_list_eligible: false;
  evaluated_at: string;
  image_similarity: AutoListImageSimilarity;
  item_id: number;
  model: string;
  reasoning: string;
  status: 'ERROR';
  store_item_id: number;
  verdict: 'NOT PASS';
  version: 2;
};

export type AutoListEvaluationResult = CompletedAutoListEvaluation | ErrorAutoListEvaluation;

export type SkippedAutoListEvaluation = {
  auto_list_eligible: false;
  item_id: number;
  reason: 'TRANSLATION_NOT_GENERATED';
  reasoning: string;
  status: 'SKIPPED';
  store_item_id: number;
};

export type AutoListEvaluationOutcome = AutoListEvaluationResult | SkippedAutoListEvaluation;

export type AutoListEvaluationService = {
  evaluateLinkedStoreItem(storeItemId: number, itemId: number): Promise<AutoListEvaluationOutcome>;
};

type LinkedStoreItemRow = {
  item_description_es: string;
  item_id: number;
  item_image_url: string;
  item_image_url_es: string;
  item_name_en: string;
  item_name_es: string;
  store_item_id: number;
  store_item_image_url: string;
  store_item_name: string;
};

export function createAutoListEvaluationService(
  database: Database,
  client: AutoListEvaluationClient,
  options: { imageSimilarityService: ImageSimilarityService; model: string; now?: () => Date }
): AutoListEvaluationService {
  const now = options.now ?? (() => new Date());

  return {
    async evaluateLinkedStoreItem(storeItemId, itemId): Promise<AutoListEvaluationOutcome> {
      const source = await loadEvaluationSource(database, storeItemId, itemId);
      if (!source.translationGenerated) {
        return {
          auto_list_eligible: false,
          item_id: itemId,
          reason: 'TRANSLATION_NOT_GENERATED',
          reasoning: 'Auto-list evaluation skipped because the linked catalog item does not have a generated Spanish translation.',
          status: 'SKIPPED',
          store_item_id: storeItemId
        };
      }
      const input = source.input;
      const evaluatedAt = now().toISOString();
      const [decisionOutcome, imageSimilarityOutcome] = await Promise.allSettled([
        client.evaluate(input, { model: options.model }),
        estimateImageSimilarity(options.imageSimilarityService, input)
      ]);
      const imageSimilarity = imageSimilarityCheck(imageSimilarityOutcome);

      let result: AutoListEvaluationResult;
      if (decisionOutcome.status === 'rejected') {
        const result: ErrorAutoListEvaluation = {
          auto_list_eligible: false,
          evaluated_at: evaluatedAt,
          image_similarity: imageSimilarity,
          item_id: itemId,
          model: options.model,
          reasoning: errorMessage(decisionOutcome.reason, 'Auto-list evaluation failed'),
          status: 'ERROR',
          store_item_id: storeItemId,
          verdict: 'NOT PASS',
          version: 2
        };
        await storeResult(database, storeItemId, itemId, result);
        return result;
      }

      try {
        const decision = normalizeDecision(decisionOutcome.value);
        result = completedResult(
          storeItemId,
          itemId,
          input,
          decision,
          imageSimilarity,
          options.model,
          evaluatedAt
        );
      } catch (error) {
        result = {
          auto_list_eligible: false,
          evaluated_at: evaluatedAt,
          image_similarity: imageSimilarity,
          item_id: itemId,
          model: options.model,
          reasoning: errorMessage(error, 'Auto-list evaluation failed'),
          status: 'ERROR',
          store_item_id: storeItemId,
          verdict: 'NOT PASS',
          version: 2
        };
      }
      await storeResult(database, storeItemId, itemId, result);
      return result;
    }
  };
}

async function loadEvaluationSource(
  database: Database,
  storeItemId: number,
  itemId: number
): Promise<{ input: AutoListEvaluationRequest; translationGenerated: boolean }> {
  const result = await database.query(
    `
    select
      si.id as store_item_id,
      si.item_id,
      si.title as store_item_name,
      si.image_url as store_item_image_url,
      i.description_es as item_description_es,
      i.canonical_name as item_name_en,
      i.canonical_name_es as item_name_es,
      i.image_url as item_image_url,
      i.image_url_es as item_image_url_es
    from store_items si
    join items i on i.id = si.item_id
    where si.id = $1
      and si.item_id = $2
    `,
    [storeItemId, itemId]
  );
  const row = result.rows[0] as LinkedStoreItemRow | undefined;
  if (!row) {
    throw new Error('Linked store item and catalog item could not be loaded for auto-list evaluation');
  }

  const spanishImageUrl = normalizedString(row.item_image_url_es);
  return {
    input: {
      itemImageSource: spanishImageUrl ? 'image_url_es' : 'image_url',
      itemImageUrl: spanishImageUrl || normalizedString(row.item_image_url),
      itemNameEn: normalizedString(row.item_name_en),
      itemNameEs: normalizedString(row.item_name_es),
      storeItemImageUrl: normalizedString(row.store_item_image_url),
      storeItemName: normalizedString(row.store_item_name)
    },
    translationGenerated: Boolean(normalizedString(row.item_description_es))
  };
}

function completedResult(
  storeItemId: number,
  itemId: number,
  input: AutoListEvaluationRequest,
  decision: AutoListAiDecision,
  imageSimilarity: AutoListImageSimilarity,
  model: string,
  evaluatedAt: string
): CompletedAutoListEvaluation {
  const hasBothImages = Boolean(input.storeItemImageUrl && input.itemImageUrl);
  const sameGamePass = hasBothImages && decision.sameGame;
  const languagePass = coverLanguagePass(decision.storeCoverLanguage, decision.itemCoverLanguage);
  const verdict: AutoListVerdict = sameGamePass && languagePass && decision.nameMatches
    ? 'PASS'
    : 'NOT PASS';

  if (decision.verdict !== verdict) {
    throw new Error(`Invalid auto-list evaluation decision: verdict ${decision.verdict} conflicts with the three checks`);
  }

  return {
    auto_list_eligible: verdict === 'PASS' && imageSimilarity.pass,
    checks: {
      cover_language: {
        item_language: decision.itemCoverLanguage,
        pass: languagePass,
        reasoning: decision.languageReasoning,
        store_language: decision.storeCoverLanguage
      },
      name_match: {
        pass: decision.nameMatches,
        reasoning: decision.nameReasoning
      },
      same_game: {
        pass: sameGamePass,
        reasoning: decision.sameGameReasoning
      }
    },
    evaluated_at: evaluatedAt,
    image_similarity: imageSimilarity,
    inputs: {
      ...input,
      item_id: itemId,
      store_item_id: storeItemId
    },
    model,
    reasoning: decision.reasoning,
    status: 'COMPLETED',
    verdict,
    version: 2
  };
}

async function estimateImageSimilarity(
  service: ImageSimilarityService,
  input: AutoListEvaluationRequest
): Promise<ImageSimilarityResult> {
  if (!input.itemImageUrl || !input.storeItemImageUrl) {
    throw new Error('Image similarity requires both the catalog and store item covers');
  }
  return service.estimate(input.itemImageUrl, input.storeItemImageUrl);
}

function imageSimilarityCheck(
  outcome: PromiseSettledResult<ImageSimilarityResult>
): AutoListImageSimilarity {
  if (outcome.status === 'rejected') {
    return {
      pass: false,
      reasoning: errorMessage(outcome.reason, 'Image similarity could not be estimated'),
      score: null,
      status: 'ERROR',
      threshold: AUTO_LIST_IMAGE_SIMILARITY_THRESHOLD
    };
  }
  return {
    ...outcome.value,
    pass: outcome.value.score >= AUTO_LIST_IMAGE_SIMILARITY_THRESHOLD,
    reasoning: outcome.value.score >= AUTO_LIST_IMAGE_SIMILARITY_THRESHOLD
      ? `Image similarity score ${outcome.value.score} meets the required threshold ${AUTO_LIST_IMAGE_SIMILARITY_THRESHOLD}.`
      : `Image similarity score ${outcome.value.score} is below the required threshold ${AUTO_LIST_IMAGE_SIMILARITY_THRESHOLD}.`,
    status: 'COMPLETED',
    threshold: AUTO_LIST_IMAGE_SIMILARITY_THRESHOLD
  };
}

export function coverLanguagePass(storeLanguage: string, itemLanguage: string): boolean {
  const store = normalizeLanguage(storeLanguage);
  const item = normalizeLanguage(itemLanguage);
  if (store === 'und' || item === 'und') {
    return false;
  }
  return store === item || (store === 'en' && item === 'es');
}

function normalizeDecision(decision: AutoListAiDecision): AutoListAiDecision {
  return {
    ...decision,
    itemCoverLanguage: normalizeLanguage(decision.itemCoverLanguage),
    languageReasoning: requiredString(decision.languageReasoning, 'languageReasoning'),
    nameReasoning: requiredString(decision.nameReasoning, 'nameReasoning'),
    reasoning: requiredString(decision.reasoning, 'reasoning'),
    sameGameReasoning: requiredString(decision.sameGameReasoning, 'sameGameReasoning'),
    storeCoverLanguage: normalizeLanguage(decision.storeCoverLanguage)
  };
}

function normalizeLanguage(value: string): string {
  const normalized = requiredString(value, 'cover language').toLowerCase();
  if (normalized === 'english') {
    return 'en';
  }
  if (normalized === 'spanish') {
    return 'es';
  }
  if (!/^[a-z]{2,3}$/.test(normalized)) {
    throw new Error('Invalid auto-list evaluation decision: cover languages must be ISO codes, mul, zxx, or und');
  }
  return normalized;
}

function requiredString(value: string, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`Invalid auto-list evaluation decision: ${field} must be a non-empty string`);
  }
  return normalized;
}

function normalizedString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

async function storeResult(
  database: Database,
  storeItemId: number,
  itemId: number,
  result: AutoListEvaluationResult
): Promise<void> {
  const stored = await database.query(
    `
    update store_items
    set auto_list_result = $1::jsonb,
        listing_status = case
          when $4::boolean and listing_status = 'PENDING' then 'LISTED'
          else listing_status
        end,
        last_updated = now()
    where id = $2
      and item_id = $3
    returning id
    `,
    [JSON.stringify(result), storeItemId, itemId, result.auto_list_eligible]
  );
  if (!stored.rows[0]) {
    throw new Error('Store item match changed before the auto-list result could be stored');
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
