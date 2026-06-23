import { Router } from 'express';

import type { DescriptionGenerationService } from '../descriptionGeneration/descriptionGenerationService.js';

export function createDescriptionGenerationRouter(descriptionGenerationService?: DescriptionGenerationService): Router {
  const router = Router();

  router.post('/admin/description-generations', async (request, response, next) => {
    try {
      if (!descriptionGenerationService) {
        throw httpError(503, 'Description generation service is not configured');
      }

      const result = await descriptionGenerationService.generate(parseDescriptionGenerationInput(request.body));
      response.status(201).json({
        data: {
          description_es: result.descriptionEs,
          metadata: result.metadata,
          model: result.model,
          prompt_version: result.promptVersion
        }
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function parseDescriptionGenerationInput(body: unknown) {
  const value = (body ?? {}) as Record<string, unknown>;
  const boardgameName = stringField(value, 'boardgame_name');
  const description1 = stringField(value, 'description_1');
  const description2 = stringField(value, 'description_2');

  if (!boardgameName || (!description1 && !description2)) {
    throw httpError(400, 'boardgame_name and at least one source description are required');
  }

  return {
    boardgameName,
    description1,
    description2
  };
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field.trim() : '';
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
