export type AiBggMatchRequest = {
  itemName: string;
  imageUrl: string | null;
};

export type AiBggMatchDecision = {
  matchFound: boolean;
  bggId: number | null;
  matchedName: string | null;
  bggUrl: string | null;
  bggImageUrl: string | null;
  nameAssessment: 'MATCH' | 'NO_MATCH';
  coverAssessment: 'MATCH' | 'CONFLICT' | 'UNAVAILABLE';
  confidence: number;
  reasoning: string;
};

export type AiBggMatchFound = AiBggMatchDecision & {
  matchFound: true;
  bggId: number;
  matchedName: string;
  bggUrl: string;
};

export type AiBggMatchingClient = {
  findMatch(request: AiBggMatchRequest, context: { model: string }): Promise<AiBggMatchDecision>;
};

export type AiBggMatchingService = {
  findMatch(request: AiBggMatchRequest): Promise<AiBggMatchFound | null>;
};

export function createAiBggMatchingService(
  client: AiBggMatchingClient,
  options: { model: string }
): AiBggMatchingService {
  return {
    async findMatch(request): Promise<AiBggMatchFound | null> {
      const decision = normalizeDecision(await client.findMatch(request, { model: options.model }));

      if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
        throw new Error('AI BGG match confidence must be between 0 and 1');
      }

      if (!decision.matchFound) {
        return null;
      }

      if (decision.coverAssessment === 'CONFLICT') {
        throw new Error('AI BGG match cannot accept a cover conflict');
      }
      if (decision.nameAssessment !== 'MATCH') {
        throw new Error('AI BGG match requires a matching name assessment');
      }
      const bggId = decision.bggId;
      if (typeof bggId !== 'number' || !Number.isInteger(bggId) || bggId <= 0) {
        throw new Error('AI BGG match requires a positive integer BGG id');
      }
      if (!decision.matchedName) {
        throw new Error('AI BGG match requires a matched name');
      }
      if (!decision.bggUrl) {
        throw new Error('AI BGG match requires a BGG URL');
      }

      return {
        ...decision,
        matchFound: true,
        bggId,
        matchedName: decision.matchedName,
        bggUrl: decision.bggUrl
      };
    }
  };
}

function normalizeDecision(decision: AiBggMatchDecision): AiBggMatchDecision {
  return {
    ...decision,
    bggImageUrl: normalizeNullableString(decision.bggImageUrl),
    bggUrl: normalizeNullableString(decision.bggUrl),
    matchedName: normalizeNullableString(decision.matchedName),
    reasoning: normalizeString(decision.reasoning)
  };
}

function normalizeNullableString(value: string | null): string | null {
  return value === null ? null : normalizeString(value);
}

function normalizeString(value: string): string {
  return value.trim();
}
