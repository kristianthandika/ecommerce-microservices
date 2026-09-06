import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import httpProxy from '@fastify/http-proxy';
import { randomUUID } from 'node:crypto';
import { createLogger, CORRELATION_ID_HEADER } from '@ecommerce/logger';
import { config } from './config.js';
import { attachCorrelation } from './correlation.js';
import { aggregatedHealth } from './health.js';
import { getFastifyOtelPlugin } from './tracing.js';

/**
 * Gateway Backend-for-Frontend (m3.1): satu-satunya pintu masuk publik.
 * Reverse proxy ke tiap service, rate-limit + security header terpusat,
 * correlation ID, aggregated health, dan tracing pengantar.
 */
export async function buildApp({ enableTracing = true } = {}) {
  const app = Fastify({
    loggerInstance: createLogger('gateway'),
    // request.id = correlation ID (baca header atau generate) → ikut di log.
    genReqId(req) {
      const h = req.headers[CORRELATION_ID_HEADER];
      return (Array.isArray(h) ? h[0] : h) || randomUUID();
    },
    // Gateway adalah trust boundary: JANGAN percaya X-Forwarded-For dari klien
    // (bisa dispoof). request.ip = IP socket asli, lalu KITA yang menuliskan
    // XFF ke service di balik gateway.
    trustProxy: false,
  });

  if (enableTracing) {
    await app.register(getFastifyOtelPlugin());
  }

  await app.register(helmet, { global: true });
  await app.register(cors, { origin: config.corsOrigin, credentials: true });
  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.timeWindow,
  });

  app.addHook('onRequest', attachCorrelation);

  // Route milik gateway sendiri (bukan proxy).
  app.get('/health', aggregatedHealth);
  app.get('/', async () => ({ service: 'gateway', status: 'ok' }));

  // Reverse proxy ke tiap service. Target dari env (Konvensi Konfigurasi).
  // Correlation ID & X-Forwarded-For sudah disuntikkan ke request.raw.headers
  // oleh hook attachCorrelation, jadi diteruskan otomatis oleh proxy.
  await app.register(httpProxy, {
    upstream: config.services.auth,
    prefix: '/auth',
    rewritePrefix: '', // /auth/login → <auth>/login
  });
  await app.register(httpProxy, {
    upstream: config.services.product,
    prefix: '/products',
    rewritePrefix: '/products',
  });
  await app.register(httpProxy, {
    upstream: config.services.order,
    prefix: '/orders',
    rewritePrefix: '/orders',
  });

  return app;
}
