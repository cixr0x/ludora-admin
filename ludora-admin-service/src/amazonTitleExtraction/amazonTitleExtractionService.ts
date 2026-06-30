export type AmazonTitleExtractionRequest = {
  amazonTitle: string;
  rawPayload?: unknown;
  sourceUrl: string;
};

export type AmazonTitleExtractionClientResult = {
  gameTitle: string;
  metadata: Record<string, unknown>;
};

export type AmazonTitleExtractionResult = AmazonTitleExtractionClientResult & {
  model: string;
  promptVersion: string;
};

export type AmazonTitleExtractionClient = {
  extract(
    request: AmazonTitleExtractionRequest,
    context: { model: string; promptVersion: string }
  ): Promise<AmazonTitleExtractionClientResult>;
};

export type AmazonTitleExtractionService = {
  extract(request: AmazonTitleExtractionRequest): Promise<AmazonTitleExtractionResult>;
};

const DEFAULT_MODEL = 'gpt-5.4-nano';
const DEFAULT_PROMPT_VERSION = 'amazon-title-v1';

export function createAmazonTitleExtractionService(
  client: AmazonTitleExtractionClient,
  options: { model?: string; promptVersion?: string } = {}
): AmazonTitleExtractionService {
  const model = options.model ?? DEFAULT_MODEL;
  const promptVersion = options.promptVersion ?? DEFAULT_PROMPT_VERSION;

  return {
    async extract(request): Promise<AmazonTitleExtractionResult> {
      const normalizedRequest = normalizeRequest(request);
      const extracted = await client.extract(normalizedRequest, { model, promptVersion });
      return {
        gameTitle: typeof extracted.gameTitle === 'string' ? extracted.gameTitle.trim() : '',
        metadata: normalizeMetadata(extracted.metadata),
        model,
        promptVersion
      };
    }
  };
}

function normalizeRequest(request: AmazonTitleExtractionRequest): AmazonTitleExtractionRequest {
  return {
    amazonTitle: request.amazonTitle.trim(),
    rawPayload: request.rawPayload ?? {},
    sourceUrl: request.sourceUrl.trim()
  };
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const confidence = typeof metadata.confidence === 'number' ? metadata.confidence : Number(metadata.confidence);
  return {
    confidence: Number.isFinite(confidence) ? confidence : 0,
    removedNoise: stringList(metadata.removedNoise),
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
