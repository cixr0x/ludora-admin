import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export type Config = {
  bggApiBaseUrl: string;
  bggApiToken?: string;
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  openAiTranslationModel: string;
  localCoverWorkflow: {
    gimpPath: string;
    publicBaseUrl: string;
    s3Bucket: string;
    s3Prefix: string;
    s3Region: string;
    workDir: string;
  };
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
    openAiBaseUrl: readOptionalEnv('OPENAI_BASE_URL'),
    openAiTranslationModel: process.env.OPENAI_TRANSLATION_MODEL ?? 'gpt-5.4-nano',
    localCoverWorkflow: readLocalCoverWorkflowConfig(),
    port,
    databaseUrl: process.env.LUDORA_DATABASE_URL,
    corsOrigin: readCorsOrigins(),
    discoveryApiUrl: process.env.LUDORA_DISCOVERY_API_URL ?? 'http://localhost:8001'
  };
}

function readOptionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function readLocalCoverWorkflowConfig(): Config['localCoverWorkflow'] {
  return {
    gimpPath: process.env.LUDORA_COVER_GIMP_PATH ?? 'gimp-3.exe',
    publicBaseUrl: process.env.LUDORA_COVER_PUBLIC_BASE_URL ?? 'https://ludora.s3.us-east-2.amazonaws.com',
    s3Bucket: process.env.LUDORA_COVER_S3_BUCKET ?? 'ludora',
    s3Prefix: process.env.LUDORA_COVER_S3_PREFIX ?? 'boardgame',
    s3Region: process.env.LUDORA_COVER_S3_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-2',
    workDir: process.env.LUDORA_COVER_WORK_DIR ?? 'C:\\Users\\mcp13\\OneDrive\\Documentos\\boardgame'
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
