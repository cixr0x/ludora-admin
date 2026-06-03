import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export type Config = {
  bggApiBaseUrl: string;
  bggApiToken?: string;
  openAiApiKey?: string;
  openAiTranslationModel: string;
  port: number;
  databaseUrl?: string;
  corsOrigin: string[];
  discoveryApiUrl: string;
};

const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function loadConfig(): Config {
  const port = readPort();

  return {
    bggApiBaseUrl: process.env.BGG_API_BASE_URL ?? 'https://boardgamegeek.com/xmlapi2',
    bggApiToken: process.env.BGG_API_TOKEN,
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiTranslationModel: process.env.OPENAI_TRANSLATION_MODEL ?? 'gpt-5.4-nano',
    port,
    databaseUrl: process.env.LUDORA_DATABASE_URL,
    corsOrigin: readCorsOrigins(),
    discoveryApiUrl: process.env.LUDORA_DISCOVERY_API_URL ?? 'http://localhost:8001'
  };
}

function readPort(): number {
  const rawPort = process.env.PORT ?? '4001';
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('PORT must be a positive integer');
  }

  return port;
}

function readCorsOrigins(): string[] {
  const rawOrigins = process.env.CORS_ORIGIN;
  if (!rawOrigins) {
    return DEFAULT_CORS_ORIGINS;
  }

  const origins = rawOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length > 0 ? origins : DEFAULT_CORS_ORIGINS;
}
