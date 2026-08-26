import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCodexResponsesClient } from '../ai/codexResponsesClient.js';
import {
  createCodexAutoListEvaluationClient,
  parseAutoListAiDecision
} from './codexAutoListEvaluationClient.js';

const responsesCreate = vi.fn();

vi.mock('../ai/codexResponsesClient.js', () => ({
  createCodexResponsesClient: vi.fn(() => ({ create: responsesCreate }))
}));

describe('Codex auto-list evaluation client', () => {
  beforeEach(() => {
    responsesCreate.mockReset();
    vi.mocked(createCodexResponsesClient).mockClear();
  });

  it('uses the configured private CodexAPI transport and strict structured output', async () => {
    responsesCreate.mockResolvedValue({
      output_text: JSON.stringify(validDecision())
    });
    const client = createCodexAutoListEvaluationClient({ baseURL: 'http://127.0.0.1:3001/v1' });

    await expect(client.evaluate({
      itemImageSource: 'image_url_es',
      itemImageUrl: 'https://catalog.mx/game-es.jpg',
      itemNameEn: 'Game',
      itemNameEs: 'Juego',
      storeItemImageUrl: 'https://store.mx/game.jpg',
      storeItemName: 'Game'
    }, { model: 'gpt-5.6-terra' })).resolves.toEqual(validDecision());

    expect(createCodexResponsesClient).toHaveBeenCalledWith({ baseURL: 'http://127.0.0.1:3001/v1' });
    expect(responsesCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-terra',
      text: {
        format: expect.objectContaining({
          name: 'auto_list_evaluation',
          strict: true,
          type: 'json_schema'
        })
      }
    }));
    const request = responsesCreate.mock.calls[0]?.[0];
    expect(request.input[0].content[0].text).toContain('https://store.mx/game.jpg');
    expect(request.input[0].content[0].text).toContain('https://catalog.mx/game-es.jpg');
  });

  it.each([
    ['an extra field', { ...validDecision(), extra: true }, 'contains unexpected field extra'],
    ['a missing field', omit(validDecision(), 'reasoning'), 'missing required field reasoning'],
    ['an invalid verdict', { ...validDecision(), verdict: 'MAYBE' }, 'verdict must be PASS or NOT PASS'],
    ['a non-boolean check', { ...validDecision(), sameGame: 'yes' }, 'sameGame must be a boolean']
  ])('rejects %s', (_label, value, message) => {
    expect(() => parseAutoListAiDecision(JSON.stringify(value))).toThrow(message);
  });
});

function validDecision() {
  return {
    itemCoverLanguage: 'es',
    languageReasoning: 'Allowed direction.',
    nameMatches: true,
    nameReasoning: 'The names match.',
    reasoning: 'All checks pass.',
    sameGame: true,
    sameGameReasoning: 'The covers show the same game.',
    storeCoverLanguage: 'en',
    verdict: 'PASS'
  };
}

function omit<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
