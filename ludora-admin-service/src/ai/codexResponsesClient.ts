import OpenAI from 'openai';

export type CodexResponsesClientOptions = {
  baseURL: string;
};

export type OpenAiResponsesClient = {
  create: OpenAI['responses']['create'];
};

export function createCodexResponsesClient(options: CodexResponsesClientOptions): OpenAiResponsesClient {
  return new OpenAI({ apiKey: 'codexapi-local', baseURL: options.baseURL, maxRetries: 0 }).responses;
}
