import { describe, expect, it } from 'vitest';

import type { Database } from '../db.js';
import {
  createProductDetailsEnrichmentService,
  createProductDetailsExtractionService,
  hasMissingProductDetails,
  normalizeProductDetails,
  type ProductDetailsExtractionClient,
  type ProductDetailsExtractionRequest
} from './productDetailsExtractionService.js';

describe('product details extraction service', () => {
  it('fills missing details while preserving existing candidate values', async () => {
    const calls: ProductDetailsExtractionRequest[] = [];
    const client: ProductDetailsExtractionClient = {
      extract: async (request) => {
        calls.push(request);
        return {
          details: {
            maxMinutes: 45,
            maxPlayers: 5,
            minAge: 8,
            minMinutes: 30,
            minPlayers: 2
          },
          metadata: {
            confidence: 0.92,
            evidence: ['2-5 jugadores', '30-45 min', '8+'],
            warnings: []
          }
        };
      }
    };

    const result = await createProductDetailsExtractionService(client, {
      model: 'gpt-5.4-nano',
      promptVersion: 'product-details-v2'
    }).extract({
      description: 'Juego familiar para 2-5 jugadores. Duracion aproximada: 30-45 minutos. Edad 8+.',
      existingDetails: {
        maxPlayers: 4,
        minPlayers: null
      },
      rawPayload: '',
      sourceUrl: 'https://store.mx/game',
      title: 'Cafe Barista'
    });

    expect(result).toEqual({
      details: {
        maxMinutes: 45,
        maxPlayers: 4,
        minAge: 8,
        minMinutes: 30,
        minPlayers: 2
      },
      extractedDetails: {
        maxMinutes: 45,
        maxPlayers: 5,
        minAge: 8,
        minMinutes: 30,
        minPlayers: 2
      },
      metadata: {
        confidence: 0.92,
        evidence: ['2-5 jugadores', '30-45 min', '8+'],
        warnings: []
      },
      model: 'gpt-5.4-nano',
      promptVersion: 'product-details-v2',
      skipped: false
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe('Cafe Barista');
  });

  it('skips extraction when all details are already present', async () => {
    const client: ProductDetailsExtractionClient = {
      extract: async () => {
        throw new Error('should not call client');
      }
    };

    const result = await createProductDetailsExtractionService(client).extract({
      description: 'Already enriched.',
      existingDetails: {
        maxMinutes: 45,
        maxPlayers: 4,
        minAge: 8,
        minMinutes: 30,
        minPlayers: 2
      },
      rawPayload: '',
      sourceUrl: 'https://store.mx/game',
      title: 'Cafe Barista'
    });

    expect(result.skipped).toBe(true);
    expect(result.details).toEqual({
      maxMinutes: 45,
      maxPlayers: 4,
      minAge: 8,
      minMinutes: 30,
      minPlayers: 2
    });
    expect(result.extractedDetails).toEqual({
      maxMinutes: null,
      maxPlayers: null,
      minAge: null,
      minMinutes: null,
      minPlayers: null
    });
    expect(result.metadata.warnings).toEqual(['Product details already exist']);
  });

  it('normalizes invalid extracted values conservatively', () => {
    expect(
      normalizeProductDetails({
        maxMinutes: 20,
        maxPlayers: 1,
        minAge: -1,
        minMinutes: 45,
        minPlayers: 4
      })
    ).toEqual({
      maxMinutes: null,
      maxPlayers: null,
      minAge: null,
      minMinutes: null,
      minPlayers: null
    });
  });

  it('detects missing details', () => {
    expect(
      hasMissingProductDetails({
        maxMinutes: 45,
        maxPlayers: 4,
        minAge: 8,
        minMinutes: 30,
        minPlayers: null
      })
    ).toBe(true);
    expect(
      hasMissingProductDetails({
        maxMinutes: 45,
        maxPlayers: 4,
        minAge: 8,
        minMinutes: 30,
        minPlayers: 2
      })
    ).toBe(false);
  });
});

describe('product details enrichment service', () => {
  it('updates store item details and the linked item with extracted values', async () => {
    const candidate = {
      description: 'Para 2 a 4 jugadores, 30 a 45 minutos, edad 8+.',
      id: 920,
      item_id: 77,
      max_minutes: null,
      max_players: null,
      min_age: null,
      min_minutes: null,
      min_players: null,
      raw_payload: { specs: '2-4 jugadores | 30-45 min | 8+' },
      source_url: 'https://store.mx/cafe',
      title: 'Cafe Barista'
    };
    const updatedCandidate = {
      ...candidate,
      max_minutes: 45,
      max_players: 4,
      min_age: 8,
      min_minutes: 30,
      min_players: 2
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        const normalized = normalizeSql(sql);
        if (normalized.startsWith('select')) {
          return { rows: [candidate] };
        }
        if (normalized.startsWith('update store_items')) {
          return { rows: [updatedCandidate] };
        }
        return { rows: [] };
      }
    };
    const extractionService = createProductDetailsExtractionService({
      extract: async () => ({
        details: {
          maxMinutes: 45,
          maxPlayers: 4,
          minAge: 8,
          minMinutes: 30,
          minPlayers: 2
        },
        metadata: {
          confidence: 0.9,
          evidence: ['2-4 jugadores'],
          warnings: []
        }
      })
    });

    const result = await createProductDetailsEnrichmentService(database, extractionService).enrichCandidate(920, {
      updateLinkedItem: true
    });

    expect(result.candidate).toEqual(updatedCandidate);
    expect(result.extraction.details).toEqual({
      maxMinutes: 45,
      maxPlayers: 4,
      minAge: 8,
      minMinutes: 30,
      minPlayers: 2
    });
    expect(queries).toHaveLength(3);
    expect(normalizeSql(queries[1].sql)).toContain('update store_items');
    expect(queries[1].params).toEqual([2, 4, 30, 45, 8, 920]);
    expect(normalizeSql(queries[2].sql)).toContain('update items');
    expect(queries[2].params).toEqual([77, 2, 4, 30, 45, 8]);
  });

  it('throws when the candidate is missing', async () => {
    const database: Database = {
      query: async () => ({ rows: [] })
    };
    const extractionService = createProductDetailsExtractionService({
      extract: async () => {
        throw new Error('should not call client');
      }
    });

    await expect(createProductDetailsEnrichmentService(database, extractionService).enrichCandidate(404)).rejects.toMatchObject({
      message: 'Item candidate not found',
      status: 404
    });
  });
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}
