import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createLogger, createHttpLogger, type Logger } from '@ecommerce/logger';
import { config } from './config.ts';
import { buildRouter } from './routes.ts';
import { errorHandler, notFoundHandler } from './middleware/errors.ts';
import { hasServiceToken } from './middleware/service-token.ts';

export function createApp({
  logger = createLogger(config.serviceName),
}: { logger?: Logger } = {}): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(createHttpLogger(logger));
  app.use(express.json({ limit: '100kb' }));
  app.use(
    rateLimit({
      // Backstop di belakang gateway (100/menit/IP), sengaja lebih longgar.
      windowMs: 60 * 1000,
      // Panggilan service-ke-service datang dari SATU IP (order-service) atas
      // nama semua user. Kalau ikut dihitung per-IP, seluruh user berbagi satu
      // kuota dan keranjang mati bersamaan — jadi caller yang membuktikan diri
      // dengan service token dikecualikan. Path saja TIDAK cukup jadi alasan.
      skip: (req) => req.path === '/health' || hasServiceToken(req),
      handler: (_req, res) =>
        res
          .status(429)
          .json({ error: { message: 'Terlalu banyak request', code: 'RATE_LIMITED' } }),
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use('/', buildRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
