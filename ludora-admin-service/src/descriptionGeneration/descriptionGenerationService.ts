export type DescriptionGenerationRequest = {
  boardgameName: string;
  description1: string;
  description2: string;
};

export type DescriptionGenerationClientResult = {
  descriptionEs: string;
  metadata: Record<string, unknown>;
};

export type DescriptionGenerationResult = DescriptionGenerationClientResult & {
  model: string;
  promptVersion: string;
};

export type DescriptionGenerationClient = {
  generate(
    request: DescriptionGenerationRequest,
    context: { model: string; promptVersion: string }
  ): Promise<DescriptionGenerationClientResult>;
};

export type DescriptionGenerationService = {
  generate(request: DescriptionGenerationRequest): Promise<DescriptionGenerationResult>;
};

const DEFAULT_MODEL = 'gpt-5.4-nano';
const DEFAULT_PROMPT_VERSION = 'description-generator-v1';

export function createDescriptionGenerationService(
  client: DescriptionGenerationClient,
  options: { model?: string; promptVersion?: string } = {}
): DescriptionGenerationService {
  const model = options.model ?? DEFAULT_MODEL;
  const promptVersion = options.promptVersion ?? DEFAULT_PROMPT_VERSION;

  return {
    async generate(request: DescriptionGenerationRequest): Promise<DescriptionGenerationResult> {
      const generated = await client.generate(normalizeRequest(request), { model, promptVersion });
      return {
        descriptionEs: generated.descriptionEs.trim(),
        metadata: generated.metadata,
        model,
        promptVersion
      };
    }
  };
}

function normalizeRequest(request: DescriptionGenerationRequest): DescriptionGenerationRequest {
  return {
    boardgameName: request.boardgameName.trim(),
    description1: request.description1.trim(),
    description2: request.description2.trim()
  };
}
