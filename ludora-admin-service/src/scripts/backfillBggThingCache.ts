import { createBggClient } from '../bgg/bggClient.js';
import { backfillBggThingCache } from '../bgg/bggThingBackfill.js';
import { createCachedBggClient } from '../bgg/cachedBggClient.js';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db.js';

const config = loadConfig();

if (!config.databaseUrl) {
  throw new Error('LUDORA_DATABASE_URL is required');
}

if (!config.bggApiToken) {
  throw new Error('BGG_API_TOKEN is required');
}

const database = createDatabase(config.databaseUrl);
const rawBggClient = createBggClient({
  apiToken: config.bggApiToken,
  baseUrl: config.bggApiBaseUrl
});
const bggClient = createCachedBggClient(database, rawBggClient);
const startedAt = Date.now();

try {
  console.log('Starting BGG thing cache backfill.');
  console.log('Using BGG thing request type boardgame,boardgameexpansion with stats=1.');
  console.log('Requests are serialized by the BGG client at one request per second; 429 responses retry after a delay.');

  const result = await backfillBggThingCache(database, bggClient, {
    onFailure: (bggId, error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[failed] bgg_id=${bggId} ${message}`);
    },
    onProgress: ({ bggId, completed, total }) => {
      console.log(`[${completed}/${total}] cached BGG thing ${bggId}`);
    }
  });
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `BGG thing cache backfill finished: fetched=${result.fetched}, failed=${result.failed}, total=${result.total}, elapsed_seconds=${elapsedSeconds}`
  );

  if (result.failed > 0) {
    process.exitCode = 1;
  }
} finally {
  await database.close?.();
}
