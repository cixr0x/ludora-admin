import { describe, expect, it } from 'vitest';

import type { Database } from '../db.js';
import { createTranslationService, type TranslationClient } from './translationService.js';

describe('translation service', () => {
  it('returns completed cached translations without calling the client', async () => {
    const calls: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        calls.push({ params, sql });
        return {
          rows: [
            {
              alternates: ['Catan Traders Barbarians 5 6'],
              metadata: { confidence: 0.9 },
              model: 'cached-model',
              prompt_version: 'translation-v1',
              translated_text: 'Catan: Traders & Barbarians 5-6 Player Expansion'
            }
          ]
        };
      }
    };
    const client: TranslationClient = {
      translate: async () => {
        throw new Error('client should not be called');
      }
    };

    const result = await createTranslationService(database, client).translate({
      purpose: 'BGG_SEARCH_QUERY',
      sourceLanguage: 'es',
      targetLanguage: 'en',
      text: 'Catan: Mercaderes y Barbaros'
    });

    expect(result.fromCache).toBe(true);
    expect(result.translatedText).toBe('Catan: Traders & Barbarians 5-6 Player Expansion');
    expect(result.alternates).toEqual(['Catan Traders Barbarians 5 6']);
    expect(calls).toHaveLength(1);
    expect(calls[0].params?.slice(4, 6)).toEqual(['gpt-5.4-nano', 'translation-v1']);
    expect(normalizeSql(calls[0].sql)).toContain('and model = $5 and prompt_version = $6');
  });

  it('calls the client and stores completed translations on cache miss', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (normalizeSql(sql).startsWith('select')) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              alternates: JSON.parse(String(params?.[9])),
              metadata: JSON.parse(String(params?.[10])),
              model: params?.[11],
              prompt_version: params?.[12],
              translated_text: params?.[8]
            }
          ]
        };
      }
    };
    const client: TranslationClient = {
      translate: async () => ({
        alternates: ['Catan Traders Barbarians 5 6'],
        metadata: { confidence: 0.88, removed_noise: ['Español'] },
        translatedText: 'Catan: Traders & Barbarians 5-6 Player Expansion'
      })
    };

    const result = await createTranslationService(database, client, {
      model: 'gpt-5.4-nano',
      promptVersion: 'translation-v1'
    }).translate({
      purpose: 'BGG_SEARCH_QUERY',
      sourceField: 'title',
      sourceId: 920,
      sourceLanguage: 'es',
      sourceType: 'discovery_item_candidate',
      targetLanguage: 'en',
      text: 'Catan: Mercaderes y Bárbaros, Ampliación 5-6 jugadores (Español)'
    });

    expect(result.fromCache).toBe(false);
    expect(result.model).toBe('gpt-5.4-nano');
    expect(result.promptVersion).toBe('translation-v1');
    expect(result.alternates).toEqual(['Catan Traders Barbarians 5 6']);
    expect(normalizeSql(queries[1].sql)).toContain('insert into translation_jobs');
    expect(queries[1].params?.[0]).toBe('discovery_item_candidate');
    expect(queries[1].params?.[1]).toBe(920);
    expect(queries[1].params?.[5]).toBe('BGG_SEARCH_QUERY');
  });

  it('stores failed translation jobs when the client fails', async () => {
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return { rows: [] };
      }
    };
    const client: TranslationClient = {
      translate: async () => {
        throw new Error('OpenAI unavailable');
      }
    };

    await expect(
      createTranslationService(database, client).translate({
        purpose: 'ITEM_DESCRIPTION',
        sourceLanguage: 'en',
        targetLanguage: 'es',
        text: 'A game about trading.'
      })
    ).rejects.toThrow('OpenAI unavailable');

    const failedInsert = queries.find((query) => normalizeSql(query.sql).includes("'failed'"));
    expect(failedInsert?.params?.at(-1)).toBe('OpenAI unavailable');
  });
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
