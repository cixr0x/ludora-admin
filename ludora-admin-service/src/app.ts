import cors from 'cors';
import express, { type ErrorRequestHandler, type Express } from 'express';

import type { Database } from './db.js';
import { createDiscoveryRouter } from './routes/discovery.js';
import { createHealthRouter } from './routes/health.js';

type HttpError = Error & {
  status?: number;
  type?: string;
};

type CreateAppOptions = {
  database: Database;
  corsOrigin?: string;
};

export function createApp({ database, corsOrigin }: CreateAppOptions): Express {
  const app = express();

  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());
  app.use(createHealthRouter());
  app.use(createDiscoveryRouter(database));
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

  response.status(500).json({
    error: {
      message
    }
  });
};

function isJsonParseError(error: unknown): error is HttpError {
  const httpError = error as HttpError;
  return error instanceof SyntaxError && httpError.status === 400 && httpError.type === 'entity.parse.failed';
}
