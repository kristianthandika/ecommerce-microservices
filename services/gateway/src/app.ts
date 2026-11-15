import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import httpProxy from '@fastify/http-proxy';
import { createLogger } from '@ecommerce/logger';
import { config } from './config.ts';

/**
 * Gateway m3.1 — reverse proxy + rate-limit + helmet + CORS terpusat, dan
 * penerusan IP klien asli lewat X-Forwarded-For / X-Real-IP (anti-spoof).
 * Correlation ID (m3.2), health agregat & tracing (m3.3) ditambahkan kemudian.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: createLogger('gateway') as unknown as FastifyBaseLogger,
    // Gateway = trust boundary: JANGAN percaya XFF dari klien (bisa dispoof).
    trustProxy: false,
  });

  await app.register(helmet, { global: true });
  await app.register(cors, { origin: config.corsOrigin, credentials: true });
  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.timeWindow,
  });

  // Tulis X-Forwarded-For / X-Real-IP = IP klien yang benar-benar diamati
  // gateway → service di baliknya (express-rate-limit) melihat IP klien asli,
  // bukan IP gateway. OVERWRITE (bukan teruskan) demi anti-spoof.
  app.addHook('onRequest', (request, _reply, done) => {
    request.raw.headers['x-forwarded-for'] = request.ip;
    request.raw.headers['x-real-ip'] = request.ip;
    done();
  });

  app.get('/', async () => ({ service: 'gateway', status: 'ok' }));

  await app.register(httpProxy, {
    upstream: config.services.auth,
    prefix: '/auth',
    rewritePrefix: '',
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
