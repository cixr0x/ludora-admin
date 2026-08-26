import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../db.js';
import {
  coverLanguagePass,
  createAutoListEvaluationService,
  type AutoListAiDecision,
  type AutoListEvaluationClient
} from './autoListEvaluationService.js';
import { systemPromptForAutoListEvaluation } from './autoListEvaluationPrompts.js';

describe('auto-list evaluation service', () => {
  it('uses the Spanish item image, stores a structured PASS result, and does not approve listing', async () => {
    const queries: RecordedQuery[] = [];
    const database = evaluationDatabase(linkedRow(), queries);
    const client = evaluationClient(decision());
    const service = createAutoListEvaluationService(database, client, {
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
    expect(result).toMatchObject({
      checks: {
        cover_language: { item_language: 'es', pass: true, store_language: 'en' },
        name_match: { pass: true },
        same_game: { pass: true }
      },
      status: 'COMPLETED',
      verdict: 'PASS'
    });
    const update = queries.find(({ sql }) => normalizeSql(sql).startsWith('update store_items'));
    expect(normalizeSql(update?.sql ?? '')).toContain('set auto_list_result = $1::jsonb');
    expect(normalizeSql(update?.sql ?? '')).not.toContain('listing_status');
    expect(JSON.parse(String(update?.params?.[0]))).toEqual(result);
  });

  it('falls back to the English item image and rejects Spanish-store to English-item language order', async () => {
    const database = evaluationDatabase(linkedRow({ item_image_url_es: '' }), []);
    const client = evaluationClient(decision({
      itemCoverLanguage: 'en',
      storeCoverLanguage: 'es',
      verdict: 'NOT PASS'
    }));

    const result = await createAutoListEvaluationService(database, client, {
      model: 'gpt-5.6-terra'
    }).evaluateLinkedStoreItem(42, 77);

    expect(client.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      itemImageSource: 'image_url',
      itemImageUrl: 'https://catalog.mx/coffee-rush.jpg'
    }), expect.anything());
    expect(result).toMatchObject({
      checks: { cover_language: { pass: false } },
      status: 'COMPLETED',
      verdict: 'NOT PASS'
    });
  });

  it('stores a fail-closed error result when the CodexAPI call fails', async () => {
    const queries: RecordedQuery[] = [];
    const database = evaluationDatabase(linkedRow(), queries);
    const client: AutoListEvaluationClient = {
      evaluate: vi.fn().mockRejectedValue(new Error('CodexAPI timed out'))
    };

    const result = await createAutoListEvaluationService(database, client, {
      model: 'gpt-5.6-terra',
      now: () => new Date('2026-08-25T18:00:00.000Z')
    }).evaluateLinkedStoreItem(42, 77);

    expect(result).toEqual({
      evaluated_at: '2026-08-25T18:00:00.000Z',
      item_id: 77,
      model: 'gpt-5.6-terra',
      reasoning: 'CodexAPI timed out',
      status: 'ERROR',
      store_item_id: 42,
      verdict: 'NOT PASS',
      version: 1
    });
    expect(queries.some(({ sql }) => normalizeSql(sql).includes('auto_list_result = $1::jsonb'))).toBe(true);
  });

  it('rejects an AI verdict that contradicts the individual checks', async () => {
    const database = evaluationDatabase(linkedRow(), []);
    const client = evaluationClient(decision({ nameMatches: false, verdict: 'PASS' }));

    const result = await createAutoListEvaluationService(database, client, {
      model: 'gpt-5.6-terra'
    }).evaluateLinkedStoreItem(42, 77);

    expect(result).toMatchObject({
      reasoning: 'Invalid auto-list evaluation decision: verdict PASS conflicts with the three checks',
      status: 'ERROR',
      verdict: 'NOT PASS'
    });
  });

  it('encodes the exact language asymmetry and conservative unknown handling', () => {
    expect(coverLanguagePass('es', 'es')).toBe(true);
    expect(coverLanguagePass('en', 'en')).toBe(true);
    expect(coverLanguagePass('en', 'es')).toBe(true);
    expect(coverLanguagePass('es', 'en')).toBe(false);
    expect(coverLanguagePass('fr', 'es')).toBe(false);
    expect(coverLanguagePass('und', 'und')).toBe(false);
  });

  it('tells CodexAPI to inspect the exact URLs and requires all checks to pass', () => {
    const prompt = systemPromptForAutoListEvaluation();
    expect(prompt).toContain('Open or download exactly those two URLs');
    expect(prompt).toContain('store cover is English ("en") and the catalog cover is Spanish ("es")');
    expect(prompt).toContain('Spanish store cover with an English catalog cover must fail');
    expect(prompt).toContain('only when sameGame, the language rule, and nameMatches all pass');
  });
});

type RecordedQuery = { params?: unknown[]; sql: string };

function evaluationDatabase(row: Record<string, unknown>, queries: RecordedQuery[]): Database {
  return {
    query: async (sql, params) => {
      queries.push({ params, sql });
      return normalizeSql(sql).includes('from store_items si') ? { rows: [row] } : { rows: [] };
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
