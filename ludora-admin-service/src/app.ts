import cors from 'cors';
import express, { type ErrorRequestHandler, type Express } from 'express';

import type { AmazonTitleExtractionService } from './amazonTitleExtraction/amazonTitleExtractionService.js';
import type { AdminAuthOptions } from './auth/adminAuth.js';
import { requireAdminAuth } from './auth/adminAuth.js';
import type { BggItemImporter } from './bgg/bggItemImporter.js';
import type { DescriptionGenerationService } from './descriptionGeneration/descriptionGenerationService.js';
import type { Database } from './db.js';
import type { DiscoveryOperationsClient } from './discoveryOperations.js';
import type { CoverFlatteningWorkflowManager } from './coverFlatteningWorkflow.js';
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
import { createTutorialCurationRouter } from './routes/tutorialCuration.js';
import { createTranslationRouter } from './routes/translation.js';
import type { TranslationService } from './translation/translationService.js';
import type { LocalCoverWorkflowManager } from './localCoverWorkflow.js';
import type { ProductDetailsEnrichmentService } from './productDetailsExtraction/productDetailsExtractionService.js';

type HttpError = Error & {
  status?: number;
  type?: string;
};

type CreateAppOptions = {
  adminAuth?: AdminAuthOptions;
  amazonTitleExtractionService?: AmazonTitleExtractionService;
  bggItemImporter?: BggItemImporter;
  coverFlatteningWorkflowManager?: CoverFlatteningWorkflowManager;
  database: Database;
  corsOrigin?: string | string[];
  descriptionGenerationService?: DescriptionGenerationService;
  externalCoverImageOptimizer?: ExternalCoverImageOptimizerRunner;
  itemMatchingService?: ItemMatchingService;
  localCoverWorkflowManager?: LocalCoverWorkflowManager;
  operationsClient?: DiscoveryOperationsClient;
  productDetailsEnrichmentService?: ProductDetailsEnrichmentService;
  translationService?: TranslationService;
};

export function createApp({
  adminAuth,
  amazonTitleExtractionService,
  bggItemImporter,
  coverFlatteningWorkflowManager,
  database,
  corsOrigin,
  descriptionGenerationService,
  externalCoverImageOptimizer,
  itemMatchingService,
  localCoverWorkflowManager,
  operationsClient,
  productDetailsEnrichmentService,
  translationService
}: CreateAppOptions): Express {
  const app = express();

  app.use(cors({ credentials: Boolean(adminAuth), origin: corsOrigin }));
  app.use(express.json());
  app.use(createHealthRouter());
  if (adminAuth) {
    app.use(createAuthRouter(adminAuth));
    app.use(requireAdminAuth(adminAuth));
  }
  app.use(createDiscoveryRouter(database, itemMatchingService, bggItemImporter, productDetailsEnrichmentService));
  app.use(createAmazonTitleExtractionRouter(amazonTitleExtractionService));
  app.use(createDescriptionGenerationRouter(descriptionGenerationService));
  app.use(createTranslationRouter(translationService));
  app.use(createTutorialCurationRouter(database));
  if (coverFlatteningWorkflowManager) {
    app.use(createCoverFlatteningWorkflowRouter(coverFlatteningWorkflowManager));
  }
  if (localCoverWorkflowManager) {
    app.use(createLocalCoverWorkflowRouter(localCoverWorkflowManager));
  }
  if (operationsClient) {
    app.use(createOperationsRouter(operationsClient, database, externalCoverImageOptimizer));
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
