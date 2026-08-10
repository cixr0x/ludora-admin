import OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCodexResponsesClient } from './codexResponsesClient.js';

vi.mock('openai', () => ({
  default: vi.fn(function OpenAIMock() {
    return {
      responses: {
        create: vi.fn()
      }
    };
  })
}));

describe('Codex Responses client', () => {
  beforeEach(() => {
    vi.mocked(OpenAI).mockClear();
  });

  it('constructs the SDK as a CodexAPI compatibility client', () => {
    createCodexResponsesClient({ baseURL: 'http://127.0.0.1:3001/v1' });

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'codexapi-local',
      baseURL: 'http://127.0.0.1:3001/v1'
    });
  });
});
