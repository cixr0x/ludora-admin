import OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCodexAiBggMatchingClient
} from './codexAiBggMatchingClient.js';
import {
  createAiBggMatchingService,
  type AiBggMatchDecision
} from './aiBggMatchingService.js';
import {
  systemPromptForAiBggMatch,
  userPromptForAiBggMatch
} from './aiBggMatchingPrompts.js';

const responsesCreate = vi.fn();

vi.mock('../ai/codexResponsesClient.js', () => ({
  createCodexResponsesClient: vi.fn(() => ({ create: responsesCreate }))
}));

function decisionFixture(overrides: Partial<AiBggMatchDecision> = {}): AiBggMatchDecision {
  return {
    matchFound: false,
    bggId: null,
    matchedName: null,
    bggUrl: null,
    bggImageUrl: null,
    nameAssessment: 'NO_MATCH',
    coverAssessment: 'UNAVAILABLE',
    confidence: 0.2,
    reasoning: 'No reliable BGG result.',
    ...overrides
  };
}

describe('AI BGG matching prompts', () => {
  it('sends only itemName and imageUrl as dynamic product data', () => {
    const payload = JSON.parse(userPromptForAiBggMatch({
      itemName: 'La Guerra del Anillo',
      imageUrl: 'https://store.mx/guerra-del-anillo.jpg'
    }));

    expect(payload).toEqual({
      itemName: 'La Guerra del Anillo',
      imageUrl: 'https://store.mx/guerra-del-anillo.jpg'
    });
    expect(Object.keys(payload)).toEqual(['itemName', 'imageUrl']);
  });

  it('places Spanish and cover behavior in the fixed prompt', () => {
    const prompt = systemPromptForAiBggMatch();

    expect(prompt).toContain('Spanish');
    expect(prompt).toContain('store item cover');
    expect(prompt).toContain('BGG cover');
    expect(prompt).toContain('conflict');
    expect(prompt).toContain('exact primary title shown on BGG');
    expect(prompt).toContain('open the public imageUrl using your web and image tools');
    expect(prompt).toContain('do not expect the store cover to be attached');
  });
});

describe('AI BGG matching service', () => {
  it('accepts a Spanish name match when the image is unavailable', async () => {
    const decision = decisionFixture({
      matchFound: true,
      bggId: 115746,
      matchedName: 'War of the Ring: Second Edition',
      bggUrl: 'https://boardgamegeek.com/boardgame/115746/war-ring-second-edition',
      nameAssessment: 'MATCH',
      coverAssessment: 'UNAVAILABLE'
    });
    const service = createAiBggMatchingService({ findMatch: async () => decision }, { model: 'gpt-6.2-sol' });

    await expect(service.findMatch({ itemName: 'La Guerra del Anillo', imageUrl: null })).resolves.toEqual(decision);
  });

  it.each([
    ['a conflicting cover', { coverAssessment: 'CONFLICT' as const }],
    ['a non-matching name assessment', { nameAssessment: 'NO_MATCH' as const }],
    ['a non-positive BGG id', { bggId: 0 }],
    ['a missing matched name', { matchedName: null }],
    ['a blank matched name', { matchedName: '   ' }],
    ['a missing BGG URL', { bggUrl: null }],
    ['a blank BGG URL', { bggUrl: '   ' }]
  ])('converts a claimed match with %s to null', async (_label, overrides) => {
    const client = {
      findMatch: vi.fn().mockResolvedValue(decisionFixture({
        matchFound: true,
        bggId: 13,
        matchedName: 'Catan',
        bggUrl: 'https://boardgamegeek.com/boardgame/13/catan',
        nameAssessment: 'MATCH',
        coverAssessment: 'MATCH',
        ...overrides
      }))
    };
    const service = createAiBggMatchingService(client, { model: 'gpt-6.2-sol' });

    await expect(service.findMatch({ itemName: 'Catan', imageUrl: 'https://store.mx/catan.jpg' }))
      .resolves.toBeNull();
    expect(client.findMatch).toHaveBeenCalledOnce();
  });

  it('converts a valid no-match decision to null', async () => {
    const service = createAiBggMatchingService({
      findMatch: async () => decisionFixture()
    }, { model: 'gpt-6.2-sol' });

    await expect(service.findMatch({ itemName: 'Unknown game', imageUrl: null })).resolves.toBeNull();
  });

  it.each([
    ['a BGG id', { bggId: 13 }],
    ['a matched name', { matchedName: 'Catan' }],
    ['a BGG URL', { bggUrl: 'https://boardgamegeek.com/boardgame/13/catan' }],
    ['a BGG image URL', { bggImageUrl: 'https://cf.geekdo-images.com/catan.jpg' }],
    ['a matching name assessment', { nameAssessment: 'MATCH' as const }],
    ['a matching cover assessment', { coverAssessment: 'MATCH' as const }],
    ['a conflicting cover assessment', { coverAssessment: 'CONFLICT' as const }]
  ])('converts a no-match decision paired with %s to null', async (_label, overrides) => {
    const client = { findMatch: vi.fn().mockResolvedValue(decisionFixture(overrides)) };
    const service = createAiBggMatchingService(client, { model: 'gpt-6.2-sol' });

    await expect(service.findMatch({ itemName: 'Unknown game', imageUrl: null }))
      .resolves.toBeNull();
    expect(client.findMatch).toHaveBeenCalledOnce();
  });

  it('rejects confidence outside the zero-to-one range', async () => {
    const service = createAiBggMatchingService({
      findMatch: async () => decisionFixture({ confidence: 1.1 })
    }, { model: 'gpt-6.2-sol' });

    await expect(service.findMatch({ itemName: 'Catan', imageUrl: null }))
      .rejects.toThrow('AI BGG match confidence must be between 0 and 1');
  });

  it('rejects a non-finite confidence value', async () => {
    const service = createAiBggMatchingService({
      findMatch: async () => decisionFixture({ confidence: Number.NaN })
    }, { model: 'gpt-6.2-sol' });

    await expect(service.findMatch({ itemName: 'Catan', imageUrl: null }))
      .rejects.toThrow('AI BGG match confidence must be between 0 and 1');
  });
});

describe('Codex AI BGG matching client', () => {
  beforeEach(() => {
    responsesCreate.mockReset();
  });

  it('requests the strict BGG decision schema and parses the response output', async () => {
    const decision = decisionFixture({
      matchFound: true,
      bggId: 13,
      matchedName: 'Catan',
      bggUrl: 'https://boardgamegeek.com/boardgame/13/catan',
      nameAssessment: 'MATCH',
      coverAssessment: 'MATCH'
    });
    responsesCreate.mockResolvedValueOnce({ output_text: JSON.stringify(decision) });
    const client = createCodexAiBggMatchingClient({ baseURL: 'http://127.0.0.1:3001/v1' });

    await expect(client.findMatch({ itemName: 'Catan', imageUrl: 'https://store.mx/catan.jpg' }, { model: 'gpt-6.2-sol' }))
      .resolves.toEqual(decision);

    expect(responsesCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-6.2-sol',
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: JSON.stringify({
            itemName: 'Catan',
            imageUrl: 'https://store.mx/catan.jpg'
          })
        }]
      }],
      text: expect.objectContaining({
        format: expect.objectContaining({
          name: 'ai_bgg_match_decision',
          strict: true,
          type: 'json_schema'
        })
      })
    }));

    const sent = responsesCreate.mock.calls[0]?.[0];
    expect(sent).not.toHaveProperty('tools');
    expect(JSON.stringify(sent)).not.toContain('input_image');
  });

  it.each(['MATCH', 'CONFLICT', 'UNAVAILABLE'])(
    'compares both image inputs after web research yields an unavailable cover (%s)',
    async (assessment) => {
      const identity = decisionFixture({
        matchFound: true,
        bggId: 296354,
        matchedName: 'In a Flash Firefighters',
        bggUrl: 'https://boardgamegeek.com/boardgame/296354/in-a-flash-firefighters',
        nameAssessment: 'MATCH',
        reasoning: 'The item name matches; the store cover could not be opened.'
      });
      const storeUrl = 'https://store.mx/bomberos.jpg';
      const bggCover = 'https://cf.geekdo-images.com/oficial.jpg';
      const fetchThing = vi.fn().mockResolvedValue({
        details: {
          bggId: 296354,
          name: 'Bomberos en acción',
          alternateNames: ['In a Flash Firefighters'],
          image: bggCover
        }
      });
      responsesCreate
        .mockResolvedValueOnce({ output_text: JSON.stringify(identity) })
        .mockResolvedValueOnce({ output_text: JSON.stringify({
          coverAssessment: assessment,
          reasoning: 'The artwork was inspected.'
        }) });
      const client = createCodexAiBggMatchingClient({ baseURL: 'http://127.0.0.1:3001/v1', bggClient: { fetchThing } });

      const decision = await client.findMatch({ itemName: 'Bomberos en acción', imageUrl: storeUrl }, { model: 'gpt-6.2-sol' });

      expect(decision).toMatchObject({
        bggId: 296354,
        nameAssessment: 'MATCH',
        coverAssessment: assessment,
        bggImageUrl: assessment === 'UNAVAILABLE' ? null : bggCover
      });
      expect(fetchThing).toHaveBeenCalledWith(296354, expect.any(AbortSignal));
      expect(responsesCreate).toHaveBeenCalledTimes(2);
      const comparison = responsesCreate.mock.calls[1]?.[0];
      expect(comparison.model).toBe('gpt-6.2-sol');
      expect(comparison.input[0].content.filter(({ type }: { type: string }) => type === 'input_image')).toEqual([
        { type: 'input_image', image_url: storeUrl, detail: 'high' },
        { type: 'input_image', image_url: bggCover, detail: 'high' }
      ]);
      expect(comparison.text.format).toMatchObject({
        type: 'json_schema',
        strict: true,
        schema: { additionalProperties: false, required: ['coverAssessment', 'reasoning'] }
      });
    }
  );

  it.each([
    [422, 'image_unavailable'],
    [429, 'rate_limit'],
    [503, 'service_unavailable'],
    [504, 'codex_timeout']
  ])('retains the name-only result if optional comparison fails with HTTP %i', async (status, code) => {
    const identity = decisionFixture({
      matchFound: true,
      bggId: 296354,
      matchedName: 'In a Flash Firefighters',
      bggUrl: 'https://boardgamegeek.com/boardgame/296354',
      nameAssessment: 'MATCH'
    });
    const fetchThing = vi.fn().mockResolvedValue({
      details: { bggId: 296354, name: 'In a Flash Firefighters', alternateNames: [], image: 'https://cf.geekdo-images.com/oficial.jpg' }
    });
    responsesCreate
      .mockResolvedValueOnce({ output_text: JSON.stringify(identity) })
      .mockRejectedValueOnce(new OpenAI.APIError(status, { code }, undefined, new Headers()));
    const client = createCodexAiBggMatchingClient({ baseURL: 'http://127.0.0.1:3001/v1', bggClient: { fetchThing } });

    await expect(client.findMatch({ itemName: 'Bomberos en acción', imageUrl: 'https://store.mx/bomberos.jpg' }, { model: 'gpt-6.2-sol' }))
      .resolves.toEqual(identity);
    expect(responsesCreate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a different ID', 13, 'Catan'],
    ['an unrelated title with the same ID', 296354, 'Catan']
  ])('keeps the name-only result when the official BGG response has %s', async (_cause, officialId, officialName) => {
    const identity = decisionFixture({
      matchFound: true,
      bggId: 296354,
      matchedName: 'In a Flash Firefighters',
      bggUrl: 'https://boardgamegeek.com/boardgame/296354',
      nameAssessment: 'MATCH'
    });
    const fetchThing = vi.fn().mockResolvedValue({
      details: { bggId: officialId, name: officialName, alternateNames: [], image: 'https://cf.geekdo-images.com/unrelated.jpg' }
    });
    responsesCreate
      .mockResolvedValueOnce({ output_text: JSON.stringify(identity) })
      .mockResolvedValueOnce({ output_text: JSON.stringify({
        coverAssessment: 'CONFLICT',
        reasoning: 'These covers depict different games.'
      }) });
    const client = createCodexAiBggMatchingClient({ baseURL: 'http://127.0.0.1:3001/v1', bggClient: { fetchThing } });

    await expect(client.findMatch({ itemName: 'Bomberos en acción', imageUrl: 'https://store.mx/bomberos.jpg' }, { model: 'gpt-6.2-sol' }))
      .resolves.toEqual(identity);
    expect(fetchThing).toHaveBeenCalledWith(296354, expect.any(AbortSignal));
    expect(responsesCreate).toHaveBeenCalledOnce();
  });

  it.each([
    ['a null image URL', null],
    ['a blank image URL', '   ']
  ])('sends a name-only BGG request for %s', async (_label, imageUrl) => {
    responsesCreate.mockResolvedValueOnce({ output_text: JSON.stringify(decisionFixture()) });
    const client = createCodexAiBggMatchingClient({ baseURL: 'http://127.0.0.1:3001/v1' });

    await expect(client.findMatch({ itemName: 'Unknown game', imageUrl }, { model: 'gpt-6.2-sol' }))
      .resolves.toEqual(decisionFixture());

    const request = responsesCreate.mock.calls[0]?.[0];
    expect(request).not.toHaveProperty('tools');
    expect(request.input).toEqual([{
      role: 'user',
      content: [{
        type: 'input_text',
        text: JSON.stringify({ itemName: 'Unknown game', imageUrl })
      }]
    }]);
  });

  it.each([
    ['a truthy string matchFound value', { matchFound: 'false' }, 'matchFound must be a boolean'],
    ['an invalid name assessment', { nameAssessment: 'LIKELY' }, 'nameAssessment must be MATCH or NO_MATCH'],
    ['an invalid cover assessment', { coverAssessment: 'LIKELY' }, 'coverAssessment must be MATCH, CONFLICT, or UNAVAILABLE'],
    ['an extra field', { unexpected: true }, 'contains unexpected field unexpected'],
    ['a missing required field', { reasoning: undefined }, 'missing required field reasoning'],
    ['a non-integer BGG id', { bggId: 13.5 }, 'bggId must be an integer or null'],
    ['a non-string nullable matched name', { matchedName: 13 }, 'matchedName must be a string or null'],
    ['a non-string nullable BGG URL', { bggUrl: 13 }, 'bggUrl must be a string or null'],
    ['a non-string nullable BGG image URL', { bggImageUrl: 13 }, 'bggImageUrl must be a string or null'],
    ['a non-numeric confidence', { confidence: '0.9' }, 'confidence must be a finite number between 0 and 1'],
    ['an out-of-range confidence', { confidence: 1.1 }, 'confidence must be a finite number between 0 and 1'],
    ['a non-string reason', { reasoning: null }, 'reasoning must be a string']
  ])('rejects %s from untrusted CodexAPI output', async (_label, overrides, expectedMessage) => {
    const client = createCodexAiBggMatchingClient({ baseURL: 'http://127.0.0.1:3001/v1' });
    responsesCreate.mockResolvedValueOnce({
      output_text: JSON.stringify({
        ...decisionFixture(),
        ...overrides
      })
    });

    await expect(client.findMatch({ itemName: 'Catan', imageUrl: null }, { model: 'gpt-6.2-sol' }))
      .rejects.toThrow(`Invalid AI BGG match decision: ${expectedMessage}`);
  });

  it.each([
    ['a BGG id', { bggId: 13 }],
    ['a matched name', { matchedName: 'Catan' }],
    ['a BGG URL', { bggUrl: 'https://boardgamegeek.com/boardgame/13/catan' }],
    ['a BGG image URL', { bggImageUrl: 'https://cf.geekdo-images.com/catan.jpg' }],
    ['a matching name assessment', { nameAssessment: 'MATCH' as const }],
    ['a matching cover assessment', { coverAssessment: 'MATCH' as const }],
    ['a conflicting cover assessment', { coverAssessment: 'CONFLICT' as const }]
  ])('parses a structurally valid no-match decision paired with %s', async (_label, overrides) => {
    const client = createCodexAiBggMatchingClient({ baseURL: 'http://127.0.0.1:3001/v1' });
    responsesCreate.mockResolvedValueOnce({
      output_text: JSON.stringify({
        ...decisionFixture(),
        ...overrides
      })
    });

    await expect(client.findMatch({ itemName: 'Unknown game', imageUrl: null }, { model: 'gpt-6.2-sol' }))
      .resolves.toEqual({
        ...decisionFixture(),
        ...overrides
      });
  });
});
