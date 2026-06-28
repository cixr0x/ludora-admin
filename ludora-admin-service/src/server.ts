import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { createBggClient } from './bgg/bggClient.js';
import { createCachedBggClient } from './bgg/cachedBggClient.js';
import { createBggItemImporter } from './bgg/bggItemImporter.js';
import { createDescriptionGenerationService } from './descriptionGeneration/descriptionGenerationService.js';
import { createOpenAiDescriptionGenerationClient } from './descriptionGeneration/openAiDescriptionGenerationClient.js';
import { createDiscoveryOperationsClient } from './discoveryOperationsClient.js';
import { createItemMatchingService } from './itemMatching/itemMatchingService.js';
import { createLocalCoverWorkflowManager, createNodeLocalCoverWorkflowDependencies } from './localCoverWorkflow.js';
import { createOpenAiProductDetailsExtractionClient } from './productDetailsExtraction/openAiProductDetailsExtractionClient.js';
import {
  createProductDetailsEnrichmentService,
  createProductDetailsExtractionService
} from './productDetailsExtraction/productDetailsExtractionService.js';
import { createOpenAiTranslationClient } from './translation/openAiTranslationClient.js';
import { createTranslationService } from './translation/translationService.js';

const config = loadConfig();

if (!config.databaseUrl) {
  throw new Error('LUDORA_DATABASE_URL is required');
}

const database = createDatabase(config.databaseUrl);
const rawBggClient = config.bggApiToken
  ? createBggClient({
      apiToken: config.bggApiToken,
      baseUrl: config.bggApiBaseUrl
    })
  : undefined;
const bggClient = rawBggClient ? createCachedBggClient(database, rawBggClient) : undefined;
const translationClient = config.openAiApiKey
  ? createOpenAiTranslationClient(config.openAiApiKey, { baseURL: config.openAiBaseUrl })
  : undefined;
const translationService = translationClient
  ? createTranslationService(database, translationClient, { model: config.openAiTranslationModel })
  : undefined;
const descriptionGenerationClient = config.openAiApiKey
  ? createOpenAiDescriptionGenerationClient(config.openAiApiKey, { baseURL: config.openAiBaseUrl })
  : undefined;
const descriptionGenerationService = descriptionGenerationClient
  ? createDescriptionGenerationService(descriptionGenerationClient, { model: config.openAiTranslationModel })
  : undefined;
const productDetailsExtractionClient = config.openAiApiKey
  ? createOpenAiProductDetailsExtractionClient(config.openAiApiKey, { baseURL: config.openAiBaseUrl })
  : undefined;
const productDetailsExtractionService = productDetailsExtractionClient
  ? createProductDetailsExtractionService(productDetailsExtractionClient, { model: config.openAiTranslationModel })
  : undefined;
const productDetailsEnrichmentService = productDetailsExtractionService
  ? createProductDetailsEnrichmentService(database, productDetailsExtractionService)
  : undefined;
const bggItemImporter = bggClient ? createBggItemImporter(database, bggClient) : undefined;
const itemMatchingService = createItemMatchingService(database, bggClient, translationService, bggItemImporter);
const operationsClient = createDiscoveryOperationsClient(config.discoveryApiUrl);
const localCoverWorkflowManager = createLocalCoverWorkflowManager(
  database,
  createNodeLocalCoverWorkflowDependencies(config.localCoverWorkflow)
);
const app = createApp({
  bggItemImporter,
  database,
  corsOrigin: config.corsOrigin,
  descriptionGenerationService,
  itemMatchingService,
  localCoverWorkflowManager,
  operationsClient,
  productDetailsEnrichmentService,
  translationService
});

const server = app.listen(config.port, () => {
  console.log(`ludora-admin-service listening on port ${config.port}`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});
