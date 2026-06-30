import { Router } from 'express';

import type { AmazonTitleExtractionService } from '../amazonTitleExtraction/amazonTitleExtractionService.js';

export function createAmazonTitleExtractionRouter(amazonTitleExtractionService?: AmazonTitleExtractionService): Router {
  const router = Router();

  router.post('/admin/ai/amazon-title-extractions', async (request, response, next) => {
    try {
      if (!amazonTitleExtractionService) {
        throw httpError(503, 'Amazon title extraction service is not configured');
      }

      const result = await amazonTitleExtractionService.extract(parseAmazonTitleExtractionInput(request.body));
      response.status(201).json({
        data: {
          game_title: result.gameTitle,
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

function parseAmazonTitleExtractionInput(body: unknown) {
  const value = (body ?? {}) as Record<string, unknown>;
  const amazonTitle = stringField(value, 'amazon_title');
  const sourceUrl = stringField(value, 'source_url');
  if (!amazonTitle || !sourceUrl) {
    throw httpError(400, 'amazon_title and source_url are required');
  }
  return {
    amazonTitle,
    rawPayload: value.raw_payload ?? {},
    sourceUrl
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
