import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export type Config = {
  port: number;
  databaseUrl?: string;
  corsOrigin: string;
};

export function loadConfig(): Config {
  const port = readPort();

  return {
    port,
    databaseUrl: process.env.LUDORA_DATABASE_URL,
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173'
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
