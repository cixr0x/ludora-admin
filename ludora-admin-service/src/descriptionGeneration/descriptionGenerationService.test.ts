import { describe, expect, it } from 'vitest';

import {
  createDescriptionGenerationService,
  type DescriptionGenerationClient,
  type DescriptionGenerationRequest
} from './descriptionGenerationService.js';

describe('description generation service', () => {
  it('normalizes requests and returns model metadata', async () => {
    const calls: Array<{
      context: { model: string; promptVersion: string };
      request: DescriptionGenerationRequest;
    }> = [];
    const client: DescriptionGenerationClient = {
      generate: async (request, context) => {
        calls.push({ context, request });
        return {
          descriptionEs:
            'En Coffee Rush, cada pedido convierte la cafeteria en una carrera contra el tiempo para preparar bebidas y ganar reputacion.',
          metadata: {
            sourceBalance: 'mixed',
            warnings: []
          }
        };
      }
    };

    const result = await createDescriptionGenerationService(client, {
      model: 'gpt-5.4-nano',
      promptVersion: 'description-generator-v2'
    }).generate({
      boardgameName: ' Coffee Rush ',
      description1: ' Complete customer orders to increase your ratings. ',
      description2: ' Vive la emocion de atender una cafeteria llena de pedidos. '
    });

    expect(result).toEqual({
      descriptionEs:
        'En Coffee Rush, cada pedido convierte la cafeteria en una carrera contra el tiempo para preparar bebidas y ganar reputacion.',
      metadata: {
        sourceBalance: 'mixed',
        warnings: []
      },
      model: 'gpt-5.4-nano',
      promptVersion: 'description-generator-v2'
    });
    expect(calls).toEqual([
      {
        context: {
          model: 'gpt-5.4-nano',
          promptVersion: 'description-generator-v2'
        },
        request: {
          boardgameName: 'Coffee Rush',
          description1: 'Complete customer orders to increase your ratings.',
          description2: 'Vive la emocion de atender una cafeteria llena de pedidos.'
        }
      }
    ]);
  });
});
