import { Router } from 'express';

import type { TranslationPurpose, TranslationService } from '../translation/translationService.js';

const translationPurposes = new Set<TranslationPurpose>([
  'ADMIN_ASSIST',
  'BGG_SEARCH_QUERY',
  'CATEGORY_NAME',
  'DISPLAY_TEXT',
  'FAMILY_NAME',
  'ITEM_DESCRIPTION',
  'ITEM_TITLE',
  'MECHANIC_NAME'
]);

export function createTranslationRouter(translationService?: TranslationService): Router {
  const router = Router();

  router.post('/admin/translations', async (request, response, next) => {
    try {
      if (!translationService) {
        throw httpError(503, 'Translation service is not configured');
      }

      const result = await translationService.translate(parseTranslationInput(request.body));
      response.status(201).json({
        data: {
          alternates: result.alternates,
          from_cache: result.fromCache,
          metadata: result.metadata,
          model: result.model,
          prompt_version: result.promptVersion,
          translated_text: result.translatedText
        }
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function parseTranslationInput(body: unknown) {
  const value = (body ?? {}) as Record<string, unknown>;
  const purpose = translationPurposeField(value, 'purpose');
  const sourceLanguage = stringField(value, 'source_language') || 'auto';
  const targetLanguage = stringField(value, 'target_language');
  const text = stringField(value, 'text');

  if (!targetLanguage || !text) {
    throw httpError(400, 'target_language and text are required');
  }

  return {
    purpose,
    sourceField: stringField(value, 'source_field'),
    sourceId: integerField(value, 'source_id'),
    sourceLanguage,
    sourceType: stringField(value, 'source_type'),
    targetLanguage,
    text
  };
}

function translationPurposeField(value: Record<string, unknown>, key: string): TranslationPurpose {
  const rawValue = stringField(value, key);
  if (translationPurposes.has(rawValue as TranslationPurpose)) {
    return rawValue as TranslationPurpose;
  }
  throw httpError(400, 'purpose must be a supported translation purpose');
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field.trim() : '';
}

function integerField(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  if (field === undefined || field === null || field === '') {
    return null;
  }
  const parsed = typeof field === 'number' ? field : Number(field);
  return Number.isInteger(parsed) ? parsed : null;
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
