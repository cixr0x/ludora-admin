import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();

if (!config.databaseUrl) {
  throw new Error('LUDORA_DATABASE_URL is required');
}

const database = createDatabase(config.databaseUrl);
const app = createApp({
  database,
  corsOrigin: config.corsOrigin
});

app.listen(config.port, () => {
  console.log(`ludora-admin-service listening on port ${config.port}`);
});
