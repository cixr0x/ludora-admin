import { describe, expect, it, vi } from 'vitest';

import { verifyAiBggMatchingCanary } from './aiBggMatchingCanary.js';
import type { AiBggMatchDecision } from './aiBggMatchingService.js';

function matchingDecision(overrides: Partial<AiBggMatchDecision> = {}): AiBggMatchDecision {
  return {
    matchFound: true,
    bggId: 296354,
    matchedName: 'Rhino Hero: Firefighter',
    bggUrl: 'https://boardgamegeek.com/boardgame/296354',
    bggImageUrl: null,
    nameAssessment: 'MATCH',
    coverAssessment: 'MATCH',
    confidence: 0.95,
    reasoning: 'Spanish HABA product and cover match.',
    ...overrides
  };
}

describe('AI BGG matching canary', () => {
  it('accepts the exact Bomberos production regression without a diagnostic image URL', async () => {
    const findMatch = vi.fn().mockResolvedValue(matchingDecision());

    await expect(verifyAiBggMatchingCanary({ findMatch }, 'gpt-5.6-terra'))
      .resolves.toMatchObject({ bggId: 296354, matchFound: true });
    expect(findMatch).toHaveBeenCalledWith({
      itemName: 'Bomberos En Accion | Haba',
      imageUrl: 'https://cdn.shopify.com/s/files/1/0556/0493/6985/files/bomberos-en-accion-haba-152327.jpg?v=1726573771'
    }, { model: 'gpt-5.6-terra' });
  });

  it.each([
    ['a no-match decision', {
      matchFound: false,
      bggId: null,
      matchedName: null,
      bggUrl: null,
      bggImageUrl: null,
      nameAssessment: 'NO_MATCH' as const,
      coverAssessment: 'UNAVAILABLE' as const,
      confidence: 0.3,
      reasoning: 'No reliable match.'
    }],
    ['a different BGG ID', {
      matchFound: true,
      bggId: 13,
      matchedName: 'Catan',
      bggUrl: 'https://boardgamegeek.com/boardgame/13',
      bggImageUrl: null,
      nameAssessment: 'MATCH' as const,
      coverAssessment: 'MATCH' as const,
      confidence: 0.95,
      reasoning: 'Wrong title.'
    }],
    ['an unavailable cover assessment', matchingDecision({ coverAssessment: 'UNAVAILABLE' })],
    ['a conflicting cover assessment', matchingDecision({ coverAssessment: 'CONFLICT' })]
  ])('fails closed for %s', async (_label, decision) => {
    await expect(verifyAiBggMatchingCanary({ findMatch: async () => decision }, 'gpt-5.6-terra'))
      .rejects.toThrow('AI BGG canary expected BGG ID 296354.');
  });
});
