import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import httpProxy from '@fastify/http-proxy';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createLogger, CORRELATION_ID_HEADER } from '@ecommerce/logger';
import { config } from './config.ts';
import { attachCorrelation } from './correlation.ts';

/**
 * Gateway m3.2 — menambah correlation ID: `genReqId` membaca/menghasilkan
 * `x-correlation-id`, dan hook `attachCorrelation` memantulkannya ke response
 * serta meneruskannya (bersama X-Forwarded-For anti-spoof) ke service di
 * baliknya. Health agregat & tracing ditambahkan di m3.3.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: createLogger('gateway') as unknown as FastifyBaseLogger,
    genReqId(req: IncomingMessage) {
      const h = req.headers[CORRELATION_ID_HEADER];
      return (Array.isArray(h) ? h[0] : h) || randomUUID();
    },
    trustProxy: false,
  });

  await app.register(helmet, { global: true });
  await app.register(cors, { origin: config.corsOrigin, credentials: true });
  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.timeWindow,
  });

  app.addHook('onRequest', attachCorrelation);

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
