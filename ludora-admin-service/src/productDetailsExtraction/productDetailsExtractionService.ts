import type { Database } from '../db.js';

export type ProductDetails = {
  maxMinutes: number | null;
  maxPlayers: number | null;
  minAge: number | null;
  minMinutes: number | null;
  minPlayers: number | null;
};

export type ProductDetailsExtractionRequest = {
  description: string;
  existingDetails?: Partial<ProductDetails>;
  rawPayload?: unknown;
  sourceUrl: string;
  title: string;
};

export type ProductDetailsExtractionClientResult = {
  details: ProductDetails;
  metadata: Record<string, unknown>;
};

export type ProductDetailsExtractionResult = {
  details: ProductDetails;
  extractedDetails: ProductDetails;
  metadata: Record<string, unknown>;
  model: string;
  promptVersion: string;
  skipped: boolean;
};

export type ProductDetailsExtractionClient = {
  extract(
    request: ProductDetailsExtractionRequest,
    context: { model: string; promptVersion: string }
  ): Promise<ProductDetailsExtractionClientResult>;
};

export type ProductDetailsExtractionService = {
  extract(request: ProductDetailsExtractionRequest): Promise<ProductDetailsExtractionResult>;
};

export type ProductDetailsEnrichmentResult = {
  candidate: Record<string, unknown>;
  extraction: ProductDetailsExtractionResult;
};

export type ProductDetailsEnrichmentService = {
  enrichCandidate(candidateId: number, options?: { updateLinkedItem?: boolean }): Promise<ProductDetailsEnrichmentResult>;
};

const DEFAULT_MODEL = 'gpt-5.4-nano';
const DEFAULT_PROMPT_VERSION = 'product-details-v1';

const emptyDetails: ProductDetails = {
  maxMinutes: null,
  maxPlayers: null,
  minAge: null,
  minMinutes: null,
  minPlayers: null
};

export function createProductDetailsExtractionService(
  client: ProductDetailsExtractionClient,
  options: { model?: string; promptVersion?: string } = {}
): ProductDetailsExtractionService {
  const model = options.model ?? DEFAULT_MODEL;
  const promptVersion = options.promptVersion ?? DEFAULT_PROMPT_VERSION;

  return {
    async extract(request): Promise<ProductDetailsExtractionResult> {
      const normalizedRequest = normalizeRequest(request);
      const existingDetails = normalizeProductDetails(normalizedRequest.existingDetails ?? {});

      if (!hasMissingProductDetails(existingDetails)) {
        return skippedResult(existingDetails, model, promptVersion, ['Product details already exist']);
      }

      if (!hasExtractionEvidence(normalizedRequest)) {
        return skippedResult(existingDetails, model, promptVersion, ['No product description or raw payload available']);
      }

      const extracted = await client.extract(normalizedRequest, { model, promptVersion });
      const extractedDetails = normalizeProductDetails(extracted.details);

      return {
        details: mergeProductDetails(existingDetails, extractedDetails),
        extractedDetails,
        metadata: normalizeMetadata(extracted.metadata),
        model,
        promptVersion,
        skipped: false
      };
    }
  };
}

export function createProductDetailsEnrichmentService(
  database: Database,
  extractionService: ProductDetailsExtractionService
): ProductDetailsEnrichmentService {
  return {
    async enrichCandidate(candidateId, options = {}): Promise<ProductDetailsEnrichmentResult> {
      const candidate = await findCandidate(database, candidateId);
      if (!candidate) {
        throw httpError(404, 'Item candidate not found');
      }

      const extraction = await extractionService.extract(candidateExtractionRequest(candidate));
      const updatedCandidate = extraction.skipped
        ? candidate
        : await updateCandidateDetails(database, candidateId, extraction.details);

      if (options.updateLinkedItem && rowInteger(updatedCandidate, 'item_id') !== null) {
        await updateLinkedItemDetails(database, rowInteger(updatedCandidate, 'item_id') as number, extraction.details);
      }

      return {
        candidate: updatedCandidate,
        extraction
      };
    }
  };
}

type ProductDetailsInput = Partial<Record<keyof ProductDetails, unknown>>;

export function hasMissingProductDetails(details: ProductDetailsInput): boolean {
  const normalized = normalizeProductDetails(details);
  return (
    normalized.minPlayers === null ||
    normalized.maxPlayers === null ||
    normalized.minMinutes === null ||
    normalized.maxMinutes === null ||
    normalized.minAge === null
  );
}

export function mergeProductDetails(existing: ProductDetailsInput, extracted: ProductDetailsInput): ProductDetails {
  const normalizedExisting = normalizeProductDetails(existing);
  const normalizedExtracted = normalizeProductDetails(extracted);

  return normalizeProductDetails({
    maxMinutes: normalizedExisting.maxMinutes ?? normalizedExtracted.maxMinutes,
    maxPlayers: normalizedExisting.maxPlayers ?? normalizedExtracted.maxPlayers,
    minAge: normalizedExisting.minAge ?? normalizedExtracted.minAge,
    minMinutes: normalizedExisting.minMinutes ?? normalizedExtracted.minMinutes,
    minPlayers: normalizedExisting.minPlayers ?? normalizedExtracted.minPlayers
  });
}

export function normalizeProductDetails(details: ProductDetailsInput): ProductDetails {
  const normalized: ProductDetails = {
    maxMinutes: positiveInteger(details.maxMinutes),
    maxPlayers: positiveInteger(details.maxPlayers),
    minAge: nonNegativeInteger(details.minAge),
    minMinutes: positiveInteger(details.minMinutes),
    minPlayers: positiveInteger(details.minPlayers)
  };

  if (normalized.minPlayers !== null && normalized.maxPlayers !== null && normalized.minPlayers > normalized.maxPlayers) {
    normalized.minPlayers = null;
    normalized.maxPlayers = null;
  }

  if (normalized.minMinutes !== null && normalized.maxMinutes !== null && normalized.minMinutes > normalized.maxMinutes) {
    normalized.minMinutes = null;
    normalized.maxMinutes = null;
  }

  return normalized;
}

function normalizeRequest(request: ProductDetailsExtractionRequest): ProductDetailsExtractionRequest {
  return {
    description: request.description.trim(),
    existingDetails: normalizeProductDetails(request.existingDetails ?? {}),
    rawPayload: request.rawPayload ?? '',
    sourceUrl: request.sourceUrl.trim(),
    title: request.title.trim()
  };
}

function hasExtractionEvidence(request: ProductDetailsExtractionRequest): boolean {
  return request.description.trim() !== '' || rawPayloadText(request.rawPayload).trim() !== '';
}

function skippedResult(
  details: ProductDetails,
  model: string,
  promptVersion: string,
  warnings: string[]
): ProductDetailsExtractionResult {
  return {
    details,
    extractedDetails: { ...emptyDetails },
    metadata: {
      confidence: 0,
      evidence: [],
      warnings
    },
    model,
    promptVersion,
    skipped: true
  };
}

async function findCandidate(database: Database, candidateId: number): Promise<Record<string, unknown> | null> {
  const result = await database.query(
    `
    select id, item_id, source_url, title, description, raw_payload,
           min_players, max_players, min_minutes, max_minutes, min_age
    from store_items
    where id = $1
    `,
    [candidateId]
  );
  return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
}

function candidateExtractionRequest(candidate: Record<string, unknown>): ProductDetailsExtractionRequest {
  return {
    description: rowString(candidate, 'description'),
    existingDetails: {
      maxMinutes: rowInteger(candidate, 'max_minutes'),
      maxPlayers: rowInteger(candidate, 'max_players'),
      minAge: rowInteger(candidate, 'min_age'),
      minMinutes: rowInteger(candidate, 'min_minutes'),
      minPlayers: rowInteger(candidate, 'min_players')
    },
    rawPayload: candidate.raw_payload ?? '',
    sourceUrl: rowString(candidate, 'source_url'),
    title: rowString(candidate, 'title')
  };
}

async function updateCandidateDetails(
  database: Database,
  candidateId: number,
  details: ProductDetails
): Promise<Record<string, unknown>> {
  const result = await database.query(
    `
    update store_items
    set min_players = $1,
        max_players = $2,
        min_minutes = $3,
        max_minutes = $4,
        min_age = $5,
        last_updated = now()
    where id = $6
    returning *
    `,
    [details.minPlayers, details.maxPlayers, details.minMinutes, details.maxMinutes, details.minAge, candidateId]
  );
  return (result.rows[0] as Record<string, unknown> | undefined) ?? {};
}

async function updateLinkedItemDetails(database: Database, itemId: number, details: ProductDetails): Promise<void> {
  await database.query(
    `
    update items
    set min_players = coalesce($2, min_players),
        max_players = coalesce($3, max_players),
        min_minutes = coalesce($4, min_minutes),
        max_minutes = coalesce($5, max_minutes),
        min_age = coalesce($6, min_age),
        updated_at = now()
    where id = $1
    `,
    [itemId, details.minPlayers, details.maxPlayers, details.minMinutes, details.maxMinutes, details.minAge]
  );
}

function rawPayloadText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value);
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const confidence = typeof metadata.confidence === 'number' ? metadata.confidence : Number(metadata.confidence);

  return {
    confidence: Number.isFinite(confidence) ? confidence : 0,
    evidence: stringList(metadata.evidence),
    warnings: stringList(metadata.warnings)
  };
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function rowString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' || typeof field === 'number' ? String(field).trim() : '';
}

function rowInteger(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  if (field === null || field === undefined || field === '') {
    return null;
  }
  const parsed = typeof field === 'number' ? field : Number(field);
  return Number.isInteger(parsed) ? parsed : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = integerValue(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = integerValue(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function integerValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
