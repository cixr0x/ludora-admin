import cors from 'cors';
import express, { type ErrorRequestHandler, type Express } from 'express';

import type { AmazonTitleExtractionService } from './amazonTitleExtraction/amazonTitleExtractionService.js';
import type { AdminAuthOptions } from './auth/adminAuth.js';
import { requireAdminAuth, requireInternalApiAuth } from './auth/adminAuth.js';
import type { BggItemImporter } from './bgg/bggItemImporter.js';
import type { DescriptionGenerationService } from './descriptionGeneration/descriptionGenerationService.js';
import type { Database } from './db.js';
import type { DiscoveryOperationsClient } from './discoveryOperations.js';
import type { CoverFlatteningWorkflowManager } from './coverFlatteningWorkflow.js';
import type { ContinuousItemUpdateWorkerManager } from './continuousItemUpdateWorkerManager.js';
import type { ItemMatchingService } from './itemMatching/itemMatchingService.js';
import { createAmazonTitleExtractionRouter } from './routes/amazonTitleExtraction.js';
import { createAuthRouter } from './routes/auth.js';
import { createDescriptionGenerationRouter } from './routes/descriptionGeneration.js';
import { createCoverFlatteningWorkflowRouter } from './routes/coverFlatteningWorkflow.js';
import { createDiscoveryRouter } from './routes/discovery.js';
import { createHealthRouter } from './routes/health.js';
import { createLocalCoverWorkflowRouter } from './routes/localCoverWorkflow.js';
import {
  createOperationsRouter,
  type ExternalCoverImageOptimizerRunner
} from './routes/operations.js';
import { createStoresRouter } from './routes/stores.js';
import { createStoreItemReviewRouter } from './routes/storeItemReview.js';
import { createTutorialCurationRouter } from './routes/tutorialCuration.js';
import { createTranslationRouter } from './routes/translation.js';
import { createPublicWebBotAuthRouter, createWebBotAuthSigningRouter } from './routes/webBotAuth.js';
import { createStoreItemTranslateAndApproveWorkflow } from './storeItemReview/storeItemTranslateAndApproveWorkflow.js';
import type { TranslationService } from './translation/translationService.js';
import type { LocalCoverWorkflowManager } from './localCoverWorkflow.js';
import type { ProductDetailsEnrichmentService } from './productDetailsExtraction/productDetailsExtractionService.js';
import type { StoreProfileDetectionService } from './storeProfileDetection/storeProfileDetectionService.js';
import type { StoreItemUpdateScheduleManager } from './storeItemUpdateScheduleManager.js';
import type { WebBotAuthService } from './webBotAuth/webBotAuthService.js';

type HttpError = Error & {
  status?: number;
  type?: string;
};

type CreateAppOptions = {
  adminAuth?: AdminAuthOptions;
  amazonTitleExtractionService?: AmazonTitleExtractionService;
  bggItemImporter?: BggItemImporter;
  coverFlatteningWorkflowManager?: CoverFlatteningWorkflowManager;
  continuousItemUpdateWorkerManager?: ContinuousItemUpdateWorkerManager;
  database: Database;
  corsOrigin?: string | string[];
  descriptionGenerationService?: DescriptionGenerationService;
  externalCoverImageOptimizer?: ExternalCoverImageOptimizerRunner;
  itemMatchingService?: ItemMatchingService;
  localCoverWorkflowManager?: LocalCoverWorkflowManager;
  operationsClient?: DiscoveryOperationsClient;
  productDetailsEnrichmentService?: ProductDetailsEnrichmentService;
  storeProfileDetectionService?: StoreProfileDetectionService;
  storeItemUpdateScheduleManager?: StoreItemUpdateScheduleManager;
  translationService?: TranslationService;
  webBotAuthService?: WebBotAuthService;
};

export function createApp({
  adminAuth,
  amazonTitleExtractionService,
  bggItemImporter,
  coverFlatteningWorkflowManager,
  continuousItemUpdateWorkerManager,
  database,
  corsOrigin,
  descriptionGenerationService,
  externalCoverImageOptimizer,
  itemMatchingService,
  localCoverWorkflowManager,
  operationsClient,
  productDetailsEnrichmentService,
  storeProfileDetectionService,
  storeItemUpdateScheduleManager,
  translationService,
  webBotAuthService
}: CreateAppOptions): Express {
  const app = express();

  app.use(cors({ credentials: Boolean(adminAuth), origin: corsOrigin }));
  app.use(express.json());
  app.use(createHealthRouter());
  if (webBotAuthService) {
    app.use(createPublicWebBotAuthRouter(webBotAuthService));
  }
  if (adminAuth) {
    app.use(createAuthRouter(adminAuth));
    app.use(requireAdminAuth(adminAuth));
  }
  app.use(createStoresRouter(database, storeProfileDetectionService));
  app.use(createDiscoveryRouter(database, itemMatchingService, bggItemImporter, productDetailsEnrichmentService));
  app.use(
    createStoreItemReviewRouter(
      descriptionGenerationService
        ? createStoreItemTranslateAndApproveWorkflow(database, descriptionGenerationService)
        : undefined
    )
  );
  app.use(createAmazonTitleExtractionRouter(amazonTitleExtractionService));
  app.use(createDescriptionGenerationRouter(descriptionGenerationService));
  app.use(createTranslationRouter(translationService));
  app.use(createTutorialCurationRouter(database));
  if (webBotAuthService && adminAuth) {
    app.use(
      '/admin/web-bot-auth/signatures',
      requireInternalApiAuth(adminAuth),
      createWebBotAuthSigningRouter(webBotAuthService)
    );
  }
  if (coverFlatteningWorkflowManager) {
    app.use(createCoverFlatteningWorkflowRouter(coverFlatteningWorkflowManager));
  }
  if (localCoverWorkflowManager) {
    app.use(createLocalCoverWorkflowRouter(localCoverWorkflowManager));
  }
  if (operationsClient) {
    app.use(
      createOperationsRouter(
        operationsClient,
        database,
        externalCoverImageOptimizer,
        continuousItemUpdateWorkerManager,
        storeItemUpdateScheduleManager
      )
    );
  }
  app.use(jsonErrorHandler);

  return app;
}

const jsonErrorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (isJsonParseError(error)) {
    response.status(400).json({
      error: {
        message: 'Invalid JSON body'
      }
    });
    return;
  }

  const message = error instanceof Error ? error.message : 'Internal server error';
  const httpError = error as HttpError;
  const status = typeof httpError.status === 'number' ? httpError.status : 500;

  response.status(status).json({
    error: {
      message
    }
  });
};

function isJsonParseError(error: unknown): error is HttpError {
  const httpError = error as HttpError;
  return error instanceof SyntaxError && httpError.status === 400 && httpError.type === 'entity.parse.failed';
}
