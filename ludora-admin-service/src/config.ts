import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import type { AdminAuthOptions, AdminSameSite } from './auth/adminAuth.js';

dotenv.config({ quiet: true });

type DiscoveryRunnerMode = 'local' | 'http';

export type Config = {
  adminAuth: AdminAuthOptions;
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
  discoveryRunner: {
    apiUrl: string;
    envFile: string;
    mode: DiscoveryRunnerMode;
    packageDir: string;
    pythonExecutable: string;
  };
};

const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function loadConfig(): Config {
  const port = readPort();

  return {
    adminAuth: readAdminAuthConfig(),
    bggApiBaseUrl: process.env.BGG_API_BASE_URL ?? 'https://boardgamegeek.com/xmlapi2',
    bggApiToken: process.env.BGG_API_TOKEN,
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiBaseUrl: readOptionalEnv('OPENAI_BASE_URL'),
    openAiTranslationModel: process.env.OPENAI_TRANSLATION_MODEL ?? 'gpt-5.4-nano',
    localCoverWorkflow: readLocalCoverWorkflowConfig(),
    port,
    databaseUrl: process.env.LUDORA_DATABASE_URL,
    corsOrigin: readCorsOrigins(),
    discoveryRunner: readDiscoveryRunnerConfig()
  };
}

function readOptionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function readAdminAuthConfig(): AdminAuthOptions {
  return {
    cookieName: readEnvWithDefault('ADMIN_SESSION_COOKIE_NAME', 'ludora_admin_session'),
    cookieSameSite: readAdminCookieSameSite(),
    cookieSecure: readAdminCookieSecure(),
    password: readRequiredEnv('ADMIN_PASSWORD'),
    sessionSecret: readRequiredEnv('ADMIN_SESSION_SECRET'),
    sessionTtlHours: readAdminSessionTtlHours(),
    username: readRequiredEnv('ADMIN_USERNAME')
  };
}

function readRequiredEnv(key: string): string {
  const value = readOptionalEnv(key);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function readAdminSessionTtlHours(): number {
  const rawValue = readEnvWithDefault('ADMIN_SESSION_TTL_HOURS', '12');
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('ADMIN_SESSION_TTL_HOURS must be a positive number');
  }
  return value;
}

function readAdminCookieSecure(): boolean {
  const rawValue = readOptionalEnv('ADMIN_SESSION_COOKIE_SECURE');
  if (!rawValue) {
    return process.env.NODE_ENV === 'production';
  }
  const normalizedValue = rawValue.toLowerCase();
  if (normalizedValue === 'true') {
    return true;
  }
  if (normalizedValue === 'false') {
    return false;
  }
  throw new Error('ADMIN_SESSION_COOKIE_SECURE must be true or false');
}

function readAdminCookieSameSite(): AdminSameSite {
  const value = readEnvWithDefault('ADMIN_SESSION_COOKIE_SAMESITE', 'lax').toLowerCase();
  if (value === 'lax' || value === 'none' || value === 'strict') {
    return value;
  }
  throw new Error('ADMIN_SESSION_COOKIE_SAMESITE must be lax, none, or strict');
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

function readDiscoveryRunnerConfig(): Config['discoveryRunner'] {
  return {
    apiUrl: readEnvWithDefault('LUDORA_DISCOVERY_API_URL', 'http://localhost:8001'),
    envFile: readEnvWithDefault('LUDORA_DISCOVERY_ENV_FILE', path.resolve(process.cwd(), '.env')),
    mode: readDiscoveryRunnerMode(),
    packageDir: readEnvWithDefault('LUDORA_DISCOVERY_PACKAGE_DIR', defaultDiscoveryPackageDir()),
    pythonExecutable: readEnvWithDefault('LUDORA_DISCOVERY_PYTHON', 'python')
  };
}

function readEnvWithDefault(key: string, defaultValue: string): string {
  return readOptionalEnv(key) ?? defaultValue;
}

function readDiscoveryRunnerMode(): DiscoveryRunnerMode {
  const rawMode = process.env.LUDORA_DISCOVERY_RUNNER?.trim().toLowerCase();
  if (!rawMode || rawMode === 'local') {
    return 'local';
  }
  if (rawMode === 'http') {
    return 'http';
  }
  throw new Error('LUDORA_DISCOVERY_RUNNER must be local or http');
}

function defaultDiscoveryPackageDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), '..', '..', 'ludora-discovery');
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
