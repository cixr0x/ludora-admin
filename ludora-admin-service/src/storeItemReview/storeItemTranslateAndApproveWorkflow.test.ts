import { describe, expect, it, vi } from 'vitest';

import type { DescriptionGenerationResult, DescriptionGenerationService } from '../descriptionGeneration/descriptionGenerationService.js';
import type { Database } from '../db.js';
import { createStoreItemTranslateAndApproveWorkflow } from './storeItemTranslateAndApproveWorkflow.js';

const generatedDescription: DescriptionGenerationResult = {
  descriptionEs: 'Completa pedidos antes de que los clientes pierdan la paciencia.',
  metadata: {},
  model: 'test-model',
  promptVersion: 'test-prompt'
};

describe('store item translate-and-approve workflow', () => {
  it('returns immediately, saves the generated translation, and then approves the pending store item', async () => {
    let resolveGeneration!: (result: DescriptionGenerationResult) => void;
    const generation = new Promise<DescriptionGenerationResult>((resolve) => {
      resolveGeneration = resolve;
    });
    const descriptionGenerationService: DescriptionGenerationService = {
      generate: vi.fn(async () => generation)
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        if (queries.length === 1) {
          return {
            rows: [
              {
                boardgame_name: 'Coffee Rush',
                description_es: '',
                item_description: 'Complete customer orders in a busy coffee shop.',
                item_id: 77,
                listing_status: 'PENDING',
                store_item_description: 'Run a coffee shop before the customers lose patience.'
              }
            ]
          };
        }
        return { rows: [{ id: 920 }] };
      }
    };

    const workflow = createStoreItemTranslateAndApproveWorkflow(database, descriptionGenerationService);
    const started = await workflow.start(920);

    expect(started).toEqual({ candidateId: 920, status: 'PROCESSING' });
    expect(queries).toHaveLength(1);
    expect(descriptionGenerationService.generate).toHaveBeenCalledWith({
      boardgameName: 'Coffee Rush',
      description1: 'Complete customer orders in a busy coffee shop.',
      description2: 'Run a coffee shop before the customers lose patience.'
    });

    resolveGeneration(generatedDescription);

    await vi.waitFor(() => expect(queries).toHaveLength(2));
    const mutation = queries[1];
    const normalizedSql = mutation.sql.replace(/\s+/g, ' ').trim().toLowerCase();
    expect(normalizedSql).toContain('update items set description_es = $1');
    expect(normalizedSql).toContain("update store_items si set listing_status = 'listed'");
    expect(normalizedSql).toContain("and si.listing_status = 'pending'");
    expect(mutation.params).toEqual([generatedDescription.descriptionEs, 77, 920]);
  });

  it('leaves the store item pending when description generation fails', async () => {
    const generationError = new Error('model unavailable');
    const descriptionGenerationService: DescriptionGenerationService = {
      generate: vi.fn(async () => {
        throw generationError;
      })
    };
    const queries: Array<{ params?: unknown[]; sql: string }> = [];
    const database: Database = {
      query: async (sql, params) => {
        queries.push({ params, sql });
        return {
          rows: [
            {
              boardgame_name: 'Coffee Rush',
              description_es: '',
              item_description: 'Complete customer orders in a busy coffee shop.',
              item_id: 77,
              listing_status: 'PENDING',
              store_item_description: ''
            }
          ]
        };
      }
    };
    const logger = { error: vi.fn() };
    const workflow = createStoreItemTranslateAndApproveWorkflow(database, descriptionGenerationService, logger);

    await expect(workflow.start(920)).resolves.toEqual({ candidateId: 920, status: 'PROCESSING' });

    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        'Translate-and-approve job failed for store item 920',
        generationError
      )
    );
    expect(queries).toHaveLength(1);
    expect(queries[0].sql.toLowerCase()).toContain('from store_items');
    expect(queries[0].sql.toLowerCase()).not.toContain('update store_items');
  });

  it('rejects starting the workflow when the store item is not pending', async () => {
    const database: Database = {
      query: async () => ({
        rows: [
          {
            boardgame_name: 'Coffee Rush',
            description_es: '',
            item_description: 'Complete customer orders.',
            item_id: 77,
            listing_status: 'REJECTED',
            store_item_description: ''
          }
        ]
      })
    };
    const descriptionGenerationService: DescriptionGenerationService = {
      generate: vi.fn()
    };
    const workflow = createStoreItemTranslateAndApproveWorkflow(database, descriptionGenerationService);

    await expect(workflow.start(920)).rejects.toMatchObject({
      message: 'Store item must be pending',
      status: 409
    });
    expect(descriptionGenerationService.generate).not.toHaveBeenCalled();
  });
});
