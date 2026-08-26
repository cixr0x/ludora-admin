import type { Database } from '../db.js';

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

export type CompletedAutoListEvaluation = {
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
  inputs: AutoListEvaluationRequest & {
    item_id: number;
    store_item_id: number;
  };
  model: string;
  reasoning: string;
  status: 'COMPLETED';
  verdict: AutoListVerdict;
  version: 1;
};

export type ErrorAutoListEvaluation = {
  evaluated_at: string;
  item_id: number;
  model: string;
  reasoning: string;
  status: 'ERROR';
  store_item_id: number;
  verdict: 'NOT PASS';
  version: 1;
};

export type AutoListEvaluationResult = CompletedAutoListEvaluation | ErrorAutoListEvaluation;

export type AutoListEvaluationService = {
  evaluateLinkedStoreItem(storeItemId: number, itemId: number): Promise<AutoListEvaluationResult>;
};

type LinkedStoreItemRow = {
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
  options: { model: string; now?: () => Date }
): AutoListEvaluationService {
  const now = options.now ?? (() => new Date());

  return {
    async evaluateLinkedStoreItem(storeItemId, itemId): Promise<AutoListEvaluationResult> {
      const input = await loadEvaluationInput(database, storeItemId, itemId);
      const evaluatedAt = now().toISOString();

      try {
        const decision = normalizeDecision(await client.evaluate(input, { model: options.model }));
        const result = completedResult(storeItemId, itemId, input, decision, options.model, evaluatedAt);
        await storeResult(database, storeItemId, result);
        return result;
      } catch (error) {
        const result: ErrorAutoListEvaluation = {
          evaluated_at: evaluatedAt,
          item_id: itemId,
          model: options.model,
          reasoning: error instanceof Error ? error.message : 'Auto-list evaluation failed',
          status: 'ERROR',
          store_item_id: storeItemId,
          verdict: 'NOT PASS',
          version: 1
        };
        await storeResult(database, storeItemId, result);
        return result;
      }
    }
  };
}

async function loadEvaluationInput(
  database: Database,
  storeItemId: number,
  itemId: number
): Promise<AutoListEvaluationRequest> {
  const result = await database.query(
    `
    select
      si.id as store_item_id,
      si.item_id,
      si.title as store_item_name,
      si.image_url as store_item_image_url,
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
    itemImageSource: spanishImageUrl ? 'image_url_es' : 'image_url',
    itemImageUrl: spanishImageUrl || normalizedString(row.item_image_url),
    itemNameEn: normalizedString(row.item_name_en),
    itemNameEs: normalizedString(row.item_name_es),
    storeItemImageUrl: normalizedString(row.store_item_image_url),
    storeItemName: normalizedString(row.store_item_name)
  };
}

function completedResult(
  storeItemId: number,
  itemId: number,
  input: AutoListEvaluationRequest,
  decision: AutoListAiDecision,
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
    inputs: {
      ...input,
      item_id: itemId,
      store_item_id: storeItemId
    },
    model,
    reasoning: decision.reasoning,
    status: 'COMPLETED',
    verdict,
    version: 1
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
  result: AutoListEvaluationResult
): Promise<void> {
  await database.query(
    `
    update store_items
    set auto_list_result = $1::jsonb,
        last_updated = now()
    where id = $2
    `,
    [JSON.stringify(result), storeItemId]
  );
}
