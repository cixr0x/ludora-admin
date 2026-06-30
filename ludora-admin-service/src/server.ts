import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { createAmazonTitleExtractionService } from './amazonTitleExtraction/amazonTitleExtractionService.js';
import { createOpenAiAmazonTitleExtractionClient } from './amazonTitleExtraction/openAiAmazonTitleExtractionClient.js';
import { createBggClient } from './bgg/bggClient.js';
import { createCachedBggClient } from './bgg/cachedBggClient.js';
import { createBggItemImporter } from './bgg/bggItemImporter.js';
import { createDescriptionGenerationService } from './descriptionGeneration/descriptionGenerationService.js';
import { createOpenAiDescriptionGenerationClient } from './descriptionGeneration/openAiDescriptionGenerationClient.js';
import { createDiscoveryOperationsClient } from './discoveryOperationsClient.js';
import { createItemMatchingService } from './itemMatching/itemMatchingService.js';
import { createLocalDiscoveryOperationsClient } from './localDiscoveryOperationsClient.js';
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
const amazonTitleExtractionClient = config.openAiApiKey
  ? createOpenAiAmazonTitleExtractionClient(config.openAiApiKey, { baseURL: config.openAiBaseUrl })
  : undefined;
const amazonTitleExtractionService = amazonTitleExtractionClient
  ? createAmazonTitleExtractionService(amazonTitleExtractionClient, { model: config.openAiTranslationModel })
  : undefined;
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
const localOperationsClient =
  config.discoveryRunner.mode === 'local'
    ? createLocalDiscoveryOperationsClient({
        envFile: config.discoveryRunner.envFile,
        packageDir: config.discoveryRunner.packageDir,
        pythonExecutable: config.discoveryRunner.pythonExecutable
      })
    : undefined;
const operationsClient =
  config.discoveryRunner.mode === 'http'
    ? createDiscoveryOperationsClient(config.discoveryRunner.apiUrl)
    : localOperationsClient;
const shutdownOperationsClient = localOperationsClient
  ? () => localOperationsClient.shutdown()
  : async () => undefined;
const localCoverWorkflowManager = createLocalCoverWorkflowManager(
  database,
  createNodeLocalCoverWorkflowDependencies(config.localCoverWorkflow)
);
const app = createApp({
  amazonTitleExtractionService,
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

let isShuttingDown = false;

async function shutdown(): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  const closeServer = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  try {
    await shutdownOperationsClient();
    await closeServer;
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  void shutdown();
});

process.on('SIGTERM', () => {
  void shutdown();
});
