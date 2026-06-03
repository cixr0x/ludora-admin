import { createHash } from 'node:crypto';

import type { Database } from '../db.js';

export type TranslationPurpose =
  | 'ADMIN_ASSIST'
  | 'BGG_SEARCH_QUERY'
  | 'CATEGORY_NAME'
  | 'DISPLAY_TEXT'
  | 'FAMILY_NAME'
  | 'ITEM_DESCRIPTION'
  | 'ITEM_TITLE'
  | 'MECHANIC_NAME';

export type TranslationRequest = {
  purpose: TranslationPurpose;
  sourceField?: string;
  sourceId?: number | null;
  sourceLanguage: string;
  sourceType?: string;
  targetLanguage: string;
  text: string;
};

export type TranslationClientResult = {
  alternates: string[];
  metadata: Record<string, unknown>;
  translatedText: string;
};

export type TranslationResult = TranslationClientResult & {
  fromCache: boolean;
  model: string;
  promptVersion: string;
};

export type TranslationClient = {
  translate(request: TranslationRequest, context: { model: string; promptVersion: string }): Promise<TranslationClientResult>;
};

export type TranslationService = {
  translate(request: TranslationRequest): Promise<TranslationResult>;
};

const DEFAULT_MODEL = 'gpt-5.4-nano';
const DEFAULT_PROMPT_VERSION = 'translation-v1';

export function createTranslationService(
  database: Database,
  client: TranslationClient,
  options: { model?: string; promptVersion?: string } = {}
): TranslationService {
  const model = options.model ?? DEFAULT_MODEL;
  const promptVersion = options.promptVersion ?? DEFAULT_PROMPT_VERSION;

  return {
    async translate(request: TranslationRequest): Promise<TranslationResult> {
      const normalizedRequest = normalizeRequest(request);
      const sourceTextHash = hashText(normalizedRequest.text);
      const cached = await findCachedTranslation(database, normalizedRequest, sourceTextHash, { model, promptVersion });
      if (cached) {
        return {
          alternates: jsonList(cached.alternates),
          fromCache: true,
          metadata: jsonObject(cached.metadata),
          model: stringValue(cached.model),
          promptVersion: stringValue(cached.prompt_version),
          translatedText: stringValue(cached.translated_text)
        };
      }

      try {
        const translated = await client.translate(normalizedRequest, { model, promptVersion });
        const stored = await insertTranslationJob(database, normalizedRequest, sourceTextHash, translated, {
          model,
          promptVersion,
          status: 'COMPLETED'
        });
        return {
          alternates: jsonList(stored.alternates),
          fromCache: false,
          metadata: jsonObject(stored.metadata),
          model: stringValue(stored.model),
          promptVersion: stringValue(stored.prompt_version),
          translatedText: stringValue(stored.translated_text)
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Translation failed';
        await insertFailedTranslationJob(database, normalizedRequest, sourceTextHash, { model, promptVersion, errorMessage: message });
        throw error;
      }
    }
  };
}

function normalizeRequest(request: TranslationRequest): TranslationRequest {
  return {
    purpose: request.purpose,
    sourceField: request.sourceField?.trim() ?? '',
    sourceId: request.sourceId ?? null,
    sourceLanguage: request.sourceLanguage.trim().toLowerCase(),
    sourceType: request.sourceType?.trim() ?? '',
    targetLanguage: request.targetLanguage.trim().toLowerCase(),
    text: request.text.trim()
  };
}

async function findCachedTranslation(
  database: Database,
  request: TranslationRequest,
  sourceTextHash: string,
  context: { model: string; promptVersion: string }
): Promise<Record<string, unknown> | null> {
  const result = await database.query(
    `
    select translated_text, alternates, metadata, model, prompt_version
    from translation_jobs
    where source_text_hash = $1
      and source_language = $2
      and target_language = $3
      and purpose = $4
      and model = $5
      and prompt_version = $6
      and status = 'COMPLETED'
    order by updated_at desc
    limit 1
    `,
    [sourceTextHash, request.sourceLanguage, request.targetLanguage, request.purpose, context.model, context.promptVersion]
  );
  return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
}

async function insertTranslationJob(
  database: Database,
  request: TranslationRequest,
  sourceTextHash: string,
  translated: TranslationClientResult,
  context: { model: string; promptVersion: string; status: 'COMPLETED' }
): Promise<Record<string, unknown>> {
  const result = await database.query(
    `
    insert into translation_jobs (
      source_type,
      source_id,
      source_field,
      source_language,
      target_language,
      purpose,
      source_text_hash,
      source_text,
      translated_text,
      alternates,
      metadata,
      model,
      prompt_version,
      status,
      updated_at
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, 'COMPLETED', now())
    returning translated_text, alternates, metadata, model, prompt_version
    `,
    [
      request.sourceType,
      request.sourceId,
      request.sourceField,
      request.sourceLanguage,
      request.targetLanguage,
      request.purpose,
      sourceTextHash,
      request.text,
      translated.translatedText,
      JSON.stringify(translated.alternates),
      JSON.stringify(translated.metadata),
      context.model,
      context.promptVersion
    ]
  );
  return (result.rows[0] as Record<string, unknown> | undefined) ?? {
    alternates: translated.alternates,
    metadata: translated.metadata,
    model: context.model,
    prompt_version: context.promptVersion,
    translated_text: translated.translatedText
  };
}

async function insertFailedTranslationJob(
  database: Database,
  request: TranslationRequest,
  sourceTextHash: string,
  context: { errorMessage: string; model: string; promptVersion: string }
): Promise<void> {
  await database.query(
    `
    insert into translation_jobs (
      source_type,
      source_id,
      source_field,
      source_language,
      target_language,
      purpose,
      source_text_hash,
      source_text,
      model,
      prompt_version,
      status,
      error_message,
      updated_at
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'FAILED', $11, now())
    `,
    [
      request.sourceType,
      request.sourceId,
      request.sourceField,
      request.sourceLanguage,
      request.targetLanguage,
      request.purpose,
      sourceTextHash,
      request.text,
      context.model,
      context.promptVersion,
      context.errorMessage
    ]
  );
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function jsonList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (typeof value === 'string') {
    try {
      return jsonList(JSON.parse(value));
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      return jsonObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
