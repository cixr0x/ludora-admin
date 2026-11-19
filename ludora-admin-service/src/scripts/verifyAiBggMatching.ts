import { createBggClient } from '../bgg/bggClient.js';
import { verifyAiBggMatchingCanary } from '../aiBggMatching/aiBggMatchingCanary.js';
import { createCodexAiBggMatchingClient } from '../aiBggMatching/codexAiBggMatchingClient.js';
import { loadConfig } from '../config.js';

const config = loadConfig();
const bggClient = config.bggApiToken
  ? createBggClient({ apiToken: config.bggApiToken, baseUrl: config.bggApiBaseUrl })
  : undefined;
const client = createCodexAiBggMatchingClient({ baseURL: config.codexApiBaseUrl, bggClient });
const decision = await verifyAiBggMatchingCanary(client, config.codexAiModel);

console.log(JSON.stringify({ status: 'ok', bggId: decision.bggId }));
