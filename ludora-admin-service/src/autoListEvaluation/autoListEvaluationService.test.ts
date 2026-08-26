import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../db.js';
import type {
  ImageSimilarityResult,
  ImageSimilarityService
} from '../imageSimilarity/imageSimilarityService.js';
import {
  AUTO_LIST_IMAGE_SIMILARITY_THRESHOLD,
  coverLanguagePass,
  createAutoListEvaluationService,
  type AutoListAiDecision,
  type AutoListEvaluationClient
} from './autoListEvaluationService.js';
import { systemPromptForAutoListEvaluation } from './autoListEvaluationPrompts.js';

describe('auto-list evaluation service', () => {
  it('uses the Spanish item image and auto-lists when AI passes and similarity is at least 98', async () => {
    const queries: RecordedQuery[] = [];
    const database = evaluationDatabase(linkedRow(), queries);
    const client = evaluationClient(decision());
    const imageSimilarity = imageSimilarityService(98);
    const service = createAutoListEvaluationService(database, client, {
      imageSimilarityService: imageSimilarity,
      model: 'gpt-5.6-terra',
      now: () => new Date('2026-08-25T18:00:00.000Z')
    });

    const result = await service.evaluateLinkedStoreItem(42, 77);

    expect(client.evaluate).toHaveBeenCalledWith({
      itemImageSource: 'image_url_es',
      itemImageUrl: 'https://catalog.mx/cafe-barista-es.jpg',
      itemNameEn: 'Coffee Rush',
      itemNameEs: 'Café Barista',
      storeItemImageUrl: 'https://store.mx/cafe-barista-en.jpg',
      storeItemName: 'Coffee Rush Board Game'
    }, { model: 'gpt-5.6-terra' });
    expect(imageSimilarity.estimate).toHaveBeenCalledWith(
      'https://catalog.mx/cafe-barista-es.jpg',
      'https://store.mx/cafe-barista-en.jpg'
    );
    expect(result).toMatchObject({
      auto_list_eligible: true,
      checks: {
        cover_language: { item_language: 'es', pass: true, store_language: 'en' },
        name_match: { pass: true },
        same_game: { pass: true }
      },
      image_similarity: {
        pass: true,
        score: 98,
        status: 'COMPLETED',
        threshold: 98
      },
      status: 'COMPLETED',
      verdict: 'PASS',
      version: 2
    });
    const update = queries.find(({ sql }) => normalizeSql(sql).startsWith('update store_items'));
    expect(normalizeSql(update?.sql ?? '')).toContain('set auto_list_result = $1::jsonb');
    expect(normalizeSql(update?.sql ?? '')).toContain(
      "when $4::boolean and listing_status = 'pending' then 'listed'"
    );
    expect(JSON.parse(String(update?.params?.[0]))).toEqual(result);
    expect(update?.params?.slice(1)).toEqual([42, 77, true]);
  });

  it('does not auto-list a score below 98 even when all AI checks pass', async () => {
    const queries: RecordedQuery[] = [];
    const result = await createAutoListEvaluationService(
      evaluationDatabase(linkedRow(), queries),
      evaluationClient(decision()),
      { imageSimilarityService: imageSimilarityService(97.99), model: 'gpt-5.6-terra' }
    ).evaluateLinkedStoreItem(42, 77);

    expect(result).toMatchObject({
      auto_list_eligible: false,
      image_similarity: { pass: false, score: 97.99, threshold: 98 },
      verdict: 'PASS'
    });
    const update = queries.find(({ sql }) => normalizeSql(sql).startsWith('update store_items'));
    expect(update?.params?.[3]).toBe(false);
  });

  it('falls back to the English item image and does not auto-list when the AI language check fails', async () => {
    const queries: RecordedQuery[] = [];
    const database = evaluationDatabase(linkedRow({ item_image_url_es: '' }), queries);
    const client = evaluationClient(decision({
      itemCoverLanguage: 'en',
      storeCoverLanguage: 'es',
      verdict: 'NOT PASS'
    }));

    const result = await createAutoListEvaluationService(database, client, {
      imageSimilarityService: imageSimilarityService(100),
      model: 'gpt-5.6-terra'
    }).evaluateLinkedStoreItem(42, 77);

    expect(client.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      itemImageSource: 'image_url',
      itemImageUrl: 'https://catalog.mx/coffee-rush.jpg'
    }), expect.anything());
    expect(result).toMatchObject({
      auto_list_eligible: false,
      checks: { cover_language: { pass: false } },
      image_similarity: { pass: true, score: 100 },
      status: 'COMPLETED',
      verdict: 'NOT PASS'
    });
    const update = queries.find(({ sql }) => normalizeSql(sql).startsWith('update store_items'));
    expect(update?.params?.[3]).toBe(false);
  });

  it('fails closed when image similarity cannot be estimated', async () => {
    const similarityError = new Error('comparison unavailable');
    const imageSimilarity: ImageSimilarityService = {
      estimate: vi.fn().mockRejectedValue(similarityError)
    };
    const queries: RecordedQuery[] = [];

    const result = await createAutoListEvaluationService(
      evaluationDatabase(linkedRow(), queries),
      evaluationClient(decision()),
      { imageSimilarityService: imageSimilarity, model: 'gpt-5.6-terra' }
    ).evaluateLinkedStoreItem(42, 77);

    expect(result).toMatchObject({
      auto_list_eligible: false,
      image_similarity: {
        pass: false,
        reasoning: 'comparison unavailable',
        score: null,
        status: 'ERROR',
        threshold: 98
      },
      status: 'COMPLETED',
      verdict: 'PASS'
    });
    const update = queries.find(({ sql }) => normalizeSql(sql).startsWith('update store_items'));
    expect(update?.params?.[3]).toBe(false);
  });

  it('stores a fail-closed error result when the CodexAPI call fails', async () => {
    const queries: RecordedQuery[] = [];
    const database = evaluationDatabase(linkedRow(), queries);
    const client: AutoListEvaluationClient = {
      evaluate: vi.fn().mockRejectedValue(new Error('CodexAPI timed out'))
    };

    const result = await createAutoListEvaluationService(database, client, {
      imageSimilarityService: imageSimilarityService(100),
      model: 'gpt-5.6-terra',
      now: () => new Date('2026-08-25T18:00:00.000Z')
    }).evaluateLinkedStoreItem(42, 77);

    expect(result).toMatchObject({
      auto_list_eligible: false,
      evaluated_at: '2026-08-25T18:00:00.000Z',
      image_similarity: { pass: true, score: 100, status: 'COMPLETED', threshold: 98 },
      item_id: 77,
      model: 'gpt-5.6-terra',
      reasoning: 'CodexAPI timed out',
      status: 'ERROR',
      store_item_id: 42,
      verdict: 'NOT PASS',
      version: 2
    });
    expect(queries.some(({ sql }) => normalizeSql(sql).includes('auto_list_result = $1::jsonb'))).toBe(true);
  });

  it('rejects an AI verdict that contradicts the individual checks', async () => {
    const database = evaluationDatabase(linkedRow(), []);
    const client = evaluationClient(decision({ nameMatches: false, verdict: 'PASS' }));

    const result = await createAutoListEvaluationService(database, client, {
      imageSimilarityService: imageSimilarityService(100),
      model: 'gpt-5.6-terra'
    }).evaluateLinkedStoreItem(42, 77);

    expect(result).toMatchObject({
      reasoning: 'Invalid auto-list evaluation decision: verdict PASS conflicts with the three checks',
      status: 'ERROR',
      verdict: 'NOT PASS'
    });
  });

  it('encodes the exact language asymmetry and conservative unknown handling', () => {
    expect(AUTO_LIST_IMAGE_SIMILARITY_THRESHOLD).toBe(98);
    expect(coverLanguagePass('es', 'es')).toBe(true);
    expect(coverLanguagePass('en', 'en')).toBe(true);
    expect(coverLanguagePass('en', 'es')).toBe(true);
    expect(coverLanguagePass('es', 'en')).toBe(false);
    expect(coverLanguagePass('fr', 'es')).toBe(false);
    expect(coverLanguagePass('und', 'und')).toBe(false);
  });

  it('requires nearly identical cover artwork, same-language names, and all checks to pass', () => {
    const prompt = systemPromptForAutoListEvaluation();
    expect(prompt).toContain('strict same-cover-artwork check, not merely a same-title or same-underlying-game check');
    expect(prompt).toContain('same printed cover artwork and design');
    expect(prompt).toContain('translated language text and small publisher or distributor logos or labels');
    expect(prompt).toContain('A redesigned, alternate, legacy, anniversary, or retailer-exclusive cover must fail');
    expect(prompt).toContain('an illustrated character scene versus an abstract dice-and-logo cover is a failure');
    expect(prompt).toContain('Matching names, designers, or game identity cannot override different artwork');
    expect(prompt).toContain('cite the decisive visual artwork and layout similarities or differences');
    expect(prompt).toContain('store cover is English ("en") and the catalog cover is Spanish ("es")');
    expect(prompt).toContain('Spanish store cover with an English catalog cover must fail');
    expect(prompt).toContain('the two titles being compared are written in the same language');
    expect(prompt).toContain('Judge the actual language of each title rather than trusting the En or Es field label');
    expect(prompt).toContain('Do not translate either title for comparison');
    expect(prompt).toContain('require all meaningful product qualifiers');
    expect(prompt).toContain('"Destinies: Adversidad" must not match only "Destinies: Adversity Module"');
    expect(prompt).toContain('never justify a pass only by translating between languages');
    expect(prompt).toContain('only when sameGame, the language rule, and nameMatches all pass');
  });
});

type RecordedQuery = { params?: unknown[]; sql: string };

function evaluationDatabase(row: Record<string, unknown>, queries: RecordedQuery[]): Database {
  return {
    query: async (sql, params) => {
      queries.push({ params, sql });
      return normalizeSql(sql).includes('from store_items si') ? { rows: [row] } : { rows: [{ id: 42 }] };
    }
  };
}

function linkedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: 77,
    item_image_url: 'https://catalog.mx/coffee-rush.jpg',
    item_image_url_es: 'https://catalog.mx/cafe-barista-es.jpg',
    item_name_en: 'Coffee Rush',
    item_name_es: 'Café Barista',
    store_item_id: 42,
    store_item_image_url: 'https://store.mx/cafe-barista-en.jpg',
    store_item_name: 'Coffee Rush Board Game',
    ...overrides
  };
}

function evaluationClient(result: AutoListAiDecision): AutoListEvaluationClient {
  return { evaluate: vi.fn().mockResolvedValue(result) };
}

function imageSimilarityService(score: number): ImageSimilarityService {
  return { estimate: vi.fn().mockResolvedValue(imageSimilarityResult(score)) };
}

function imageSimilarityResult(score: number): ImageSimilarityResult {
  return {
    diagnostics: {
      candidate_dimensions: { height: 500, width: 400 },
      candidate_keypoints: 180,
      homography_valid: true,
      inlier_ratio: 0.95,
      inliers: 76,
      median_reprojection_error: 0.4,
      projected_area_ratio: 1,
      reference_dimensions: { height: 500, width: 400 },
      reference_grid_coverage: 1,
      reference_hull_coverage: 0.9,
      reference_keypoints: 200,
      tentative_matches: 80
    },
    matched_region: null,
    method: 'sift_homography_v1',
    score
  };
}

function decision(overrides: Partial<AutoListAiDecision> = {}): AutoListAiDecision {
  return {
    itemCoverLanguage: 'es',
    languageReasoning: 'English store cover to Spanish catalog cover is allowed.',
    nameMatches: true,
    nameReasoning: 'The store title matches the English catalog title.',
    reasoning: 'All three auto-list checks pass.',
    sameGame: true,
    sameGameReasoning: 'Both covers identify Coffee Rush.',
    storeCoverLanguage: 'en',
    verdict: 'PASS',
    ...overrides
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
