import { randomBytes } from 'node:crypto';

import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { createAmazonTitleExtractionService } from './amazonTitleExtraction/amazonTitleExtractionService.js';
import { createOpenAiAmazonTitleExtractionClient } from './amazonTitleExtraction/openAiAmazonTitleExtractionClient.js';
import { createBggClient } from './bgg/bggClient.js';
import { createCachedBggClient } from './bgg/cachedBggClient.js';
import { createBggItemImporter } from './bgg/bggItemImporter.js';
import { createContinuousItemUpdateWorkerManager } from './continuousItemUpdateWorkerManager.js';
import { createDescriptionGenerationService } from './descriptionGeneration/descriptionGenerationService.js';
import {
  createCoverFlatteningWorkflowManager,
  createNodeCoverFlatteningWorkflowDependencies
} from './coverFlatteningWorkflow.js';
import { createOpenAiDescriptionGenerationClient } from './descriptionGeneration/openAiDescriptionGenerationClient.js';
import { createDiscoveryOperationsClient } from './discoveryOperationsClient.js';
import { createNodeExternalCoverImageOptimizerDependencies, optimizeExternalCoverImages } from './externalCoverImageOptimizer.js';
import { createItemMatchingService } from './itemMatching/itemMatchingService.js';
import { createLocalDiscoveryOperationsClient } from './localDiscoveryOperationsClient.js';
import { createLocalCoverWorkflowManager, createNodeLocalCoverWorkflowDependencies } from './localCoverWorkflow.js';
import { createOpenAiProductDetailsExtractionClient } from './productDetailsExtraction/openAiProductDetailsExtractionClient.js';
import {
  createProductDetailsEnrichmentService,
  createProductDetailsExtractionService
} from './productDetailsExtraction/productDetailsExtractionService.js';
import { createRuntimeManagerLifecycle } from './runtimeManagerLifecycle.js';
import { createOpenAiStoreProfileDetectionClient } from './storeProfileDetection/openAiStoreProfileDetectionClient.js';
import { createStoreProfileDetectionService } from './storeProfileDetection/storeProfileDetectionService.js';
import { createStoreItemUpdateScheduleManager } from './storeItemUpdateScheduleManager.js';
import { createStoreItemUpdateScheduleService } from './storeItemUpdateScheduleService.js';
import { createOpenAiTranslationClient } from './translation/openAiTranslationClient.js';
import { createTranslationService } from './translation/translationService.js';
import { createWebBotAuthService } from './webBotAuth/webBotAuthService.js';

const config = loadConfig();
const internalApiToken = config.internalApiToken ?? randomBytes(32).toString('hex');
const webBotAuthService = config.webBotAuth.privateJwkPath
  ? await createWebBotAuthService({
      contactEmail: config.webBotAuth.contactEmail,
      identityOrigin: config.webBotAuth.identityOrigin,
      privateJwkPath: config.webBotAuth.privateJwkPath
    })
  : undefined;

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
const codexOptions = { baseURL: config.codexApiBaseUrl };
const amazonTitleExtractionClient = createOpenAiAmazonTitleExtractionClient(codexOptions);
const amazonTitleExtractionService = createAmazonTitleExtractionService(amazonTitleExtractionClient, { model: config.codexAiModel });
const translationClient = createOpenAiTranslationClient(codexOptions);
const translationService = createTranslationService(database, translationClient, { model: config.codexAiModel });
const descriptionGenerationClient = createOpenAiDescriptionGenerationClient(codexOptions);
const descriptionGenerationService = createDescriptionGenerationService(descriptionGenerationClient, { model: config.codexAiModel });
const productDetailsExtractionClient = createOpenAiProductDetailsExtractionClient(codexOptions);
const productDetailsExtractionService = createProductDetailsExtractionService(productDetailsExtractionClient, { model: config.codexAiModel });
const productDetailsEnrichmentService = createProductDetailsEnrichmentService(database, productDetailsExtractionService);
const storeProfileAiClient = createOpenAiStoreProfileDetectionClient(codexOptions);
const storeProfileDetectionService = createStoreProfileDetectionService({
  aiClient: storeProfileAiClient,
  model: config.codexAiModel
});
const bggItemImporter = bggClient ? createBggItemImporter(database, bggClient) : undefined;
const itemMatchingService = createItemMatchingService(database, bggClient, translationService, bggItemImporter);
const localOperationsClient =
  config.discoveryRunner.mode === 'local'
    ? createLocalDiscoveryOperationsClient({
        envFile: config.discoveryRunner.envFile,
        internalApiToken,
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
const continuousItemUpdateWorkerManager =
  config.continuousItemUpdateWorker.enabled && config.discoveryRunner.mode === 'local'
    ? createContinuousItemUpdateWorkerManager({
        adminApiUrl: `http://127.0.0.1:${config.port}`,
        envFile: config.discoveryRunner.envFile,
        internalApiToken,
        leaseSeconds: config.continuousItemUpdateWorker.leaseSeconds,
        packageDir: config.discoveryRunner.packageDir,
        pollSeconds: config.continuousItemUpdateWorker.pollSeconds,
        pythonExecutable: config.discoveryRunner.pythonExecutable
      })
    : undefined;
const storeItemUpdateScheduleManager = config.continuousItemUpdateWorker.enabled
  ? createStoreItemUpdateScheduleManager({
      scheduleService: createStoreItemUpdateScheduleService(database)
    })
  : undefined;
const runtimeManagerLifecycle = createRuntimeManagerLifecycle({
  continuousItemUpdateWorkerManager,
  dailyItemDiscoveryEnabled: config.dailyItemDiscoverySchedule.enabled,
  operationsClient,
  storeItemUpdateScheduleManager
});
const localCoverWorkflowManager = createLocalCoverWorkflowManager(
  database,
  createNodeLocalCoverWorkflowDependencies(config.localCoverWorkflow)
);
const externalCoverImageOptimizerDependencies = createNodeExternalCoverImageOptimizerDependencies(config.localCoverWorkflow);
const coverFlatteningWorkflowManager = createCoverFlatteningWorkflowManager(
  database,
  createNodeCoverFlatteningWorkflowDependencies({
    config: { ...config.localCoverWorkflow, workDir: config.coverFlatteningWorkDir },
    packageDir: config.discoveryRunner.packageDir,
    pythonExecutable: config.discoveryRunner.pythonExecutable
  })
);
const app = createApp({
  adminAuth: { ...config.adminAuth, internalApiToken },
  amazonTitleExtractionService,
  bggItemImporter,
  coverFlatteningWorkflowManager,
  continuousItemUpdateWorkerManager,
  database,
  corsOrigin: config.corsOrigin,
  descriptionGenerationService,
  externalCoverImageOptimizer: {
    run: (options) => optimizeExternalCoverImages(database, externalCoverImageOptimizerDependencies, options)
  },
  itemMatchingService,
  localCoverWorkflowManager,
  operationsClient,
  productDetailsEnrichmentService,
  storeProfileDetectionService,
  storeItemUpdateScheduleManager,
  translationService,
  webBotAuthService
});

const server = app.listen(config.port, config.host, () => {
  console.log(`ludora-admin-service listening on ${config.host}:${config.port}`);
  runtimeManagerLifecycle.start();
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
    await runtimeManagerLifecycle.shutdown();
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
