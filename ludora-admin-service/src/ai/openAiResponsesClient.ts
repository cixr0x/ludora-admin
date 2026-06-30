import OpenAI from 'openai';

export type OpenAiClientOptions = {
  baseURL?: string;
};

export type OpenAiResponsesClient = {
  create: OpenAI['responses']['create'];
};

export function createOpenAiResponsesClient(apiKey: string, options: OpenAiClientOptions = {}): OpenAiResponsesClient {
  const openai = new OpenAI({
    apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {})
  });

  return openai.responses;
}
