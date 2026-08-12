import { verifyAiBggMatchingCanary } from '../aiBggMatching/aiBggMatchingCanary.js';
import { createCodexAiBggMatchingClient } from '../aiBggMatching/codexAiBggMatchingClient.js';
import { loadConfig } from '../config.js';

const config = loadConfig();
const client = createCodexAiBggMatchingClient({ baseURL: config.codexApiBaseUrl });
const decision = await verifyAiBggMatchingCanary(client, config.codexAiModel);

console.log(JSON.stringify({ status: 'ok', bggId: decision.bggId }));
