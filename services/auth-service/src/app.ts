import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createLogger, createHttpLogger, type Logger } from '@ecommerce/logger';
import { config } from './config.ts';
import { buildRouter } from './routes.ts';
import { errorHandler, notFoundHandler } from './middleware/errors.ts';
import { hasServiceToken } from './middleware/service-token.ts';

/**
 * Factory Express app — mengembalikan `app` TANPA memanggil `listen()`, supaya
 * bisa dipakai langsung oleh supertest (`request(app)`) tanpa membuka port.
 */
export function createApp({
  logger = createLogger(config.serviceName),
}: { logger?: Logger } = {}): Express {
  const app = express();

  // Di belakang gateway/Docker: percayai proxy hop pertama saja (jangan `true`
  // tanpa batas — mencegah spoofing X-Forwarded-For dari luar).
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(createHttpLogger(logger));
  app.use(express.json({ limit: '100kb' }));
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      // JWKS dan daftar pencabutan diambil service lain (bukan user) — jangan sampai
      // kuota per-IP menghalangi product/order-service memverifikasi token.
      skip: (req) =>
        req.path === '/health' || req.path === '/.well-known/jwks.json' || hasServiceToken(req),
      handler: (_req, res) =>
        res
          .status(429)
          .json({ error: { message: 'Terlalu banyak request', code: 'RATE_LIMITED' } }),
      limit: 300, // backstop: lebih longgar dari limit gateway 100/menit (catatan dua lapis di m3.1)
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.use(
    ['/login', '/register'],
    rateLimit({
      windowMs: 60000,
      limit: 20,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({
          error: { message: 'Terlalu banyak percobaan autentikasi', code: 'RATE_LIMITED' },
        }),
    }),
  );
  // Bucket tersendiri: verifikasi memeriksa password (bcrypt) dan atur ulang
  // password mengirim email, jadi keduanya dibatasi seketat login.
  app.use(
    ['/verify-email', '/password-reset'],
    rateLimit({
      windowMs: 60000,
      limit: 20,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({
          error: { message: 'Terlalu banyak percobaan autentikasi', code: 'RATE_LIMITED' },
        }),
    }),
  );
  app.use(
    ['/refresh', '/logout'],
    rateLimit({
      windowMs: 60000,
      limit: 60,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({
          error: { message: 'Terlalu banyak permintaan sesi', code: 'RATE_LIMITED' },
        }),
    }),
  );
  app.use('/', buildRouter());

  app.use(notFoundHandler);
  app.use(errorHandler); // WAJIB paling terakhir
  return app;
}
