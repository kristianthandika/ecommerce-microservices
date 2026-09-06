import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createLogger, createHttpLogger } from '@ecommerce/logger';
import { config } from './config.js';
import { buildRouter } from './routes.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';

export function createApp({ logger = createLogger(config.serviceName) } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json());
  app.use(createHttpLogger(logger));
  app.use(
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }),
  );
  app.use('/', buildRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
