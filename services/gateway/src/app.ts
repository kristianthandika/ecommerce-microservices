import Fastify, {
  type FastifyInstance,
  type FastifyBaseLogger,
  type FastifyReply,
  type RawServerBase,
  type RouteGenericInterface,
} from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import httpProxy from '@fastify/http-proxy';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { createLogger, CORRELATION_ID_HEADER } from '@ecommerce/logger';
import { config } from './config.ts';
import { attachCorrelation } from './correlation.ts';
import { aggregatedHealth } from './health.ts';

/**
 * Kegagalan MENGHUBUNGI service di balik gateway (connection refused/reset, DNS,
 * timeout). Bawaan @fastify/reply-from memetakan sebagian di antaranya ke 500 —
 * seolah gateway yang bug. Yang benar: 504 untuk timeout, 503 untuk upstream
 * yang tidak terjangkau, supaya klien & monitoring tahu ini gangguan sementara
 * yang layak dicoba ulang.
 */
function upstreamFailure(
  reply: FastifyReply<RouteGenericInterface, RawServerBase>,
  { error }: { error: Error },
): void {
  const timedOut = (error as { statusCode?: number }).statusCode === 504;
  reply.request.log.warn({ err: error }, 'upstream tidak terjangkau');
  if (!timedOut) reply.header('retry-after', '5');
  reply.code(timedOut ? 504 : 503).send({
    error: {
      message: 'Layanan sementara tidak tersedia',
      code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
    },
  });
}

/**
 * Gateway Backend-for-Frontend (m3.1): satu-satunya pintu masuk publik.
 * Reverse proxy ke tiap service, rate-limit + security header terpusat,
 * correlation ID, aggregated health, dan tracing pengantar.
 */
export async function buildApp({
  enableTracing = true,
}: { enableTracing?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Pakai konfigurasi pino kita untuk gateway. Cast ke FastifyBaseLogger
    // supaya tipe instance tetap default (pino Logger adalah superset-nya).
    loggerInstance: createLogger('gateway') as unknown as FastifyBaseLogger,
    // request.id = correlation ID (baca header atau generate) → ikut di log.
    genReqId(req: IncomingMessage) {
      const h = req.headers[CORRELATION_ID_HEADER];
      const candidate = Array.isArray(h) ? h[0] : h;
      return candidate && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : randomUUID();
    },
    // Trust forwarded IPs only from explicitly configured frontend proxy addresses.
    trustProxy: process.env.TRUSTED_PROXY_CIDR?.split(',') ?? false,
  });

  app.setErrorHandler<{ statusCode?: number; message: string }>((error, _request, reply) => {
    const status =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;
    reply.code(status).send({
      error: {
        message: status >= 500 ? 'Layanan sementara tidak tersedia' : error.message,
        code:
          status === 429
            ? 'RATE_LIMITED'
            : status === 400
              ? 'INVALID_REQUEST'
              : status === 413
                ? 'PAYLOAD_TOO_LARGE'
                : 'GATEWAY_ERROR',
      },
    });
  });

  if (enableTracing) {
    const { getFastifyOtelPlugin } = await import('./tracing.ts');
    await app.register(getFastifyOtelPlugin());
  }

  await app.register(helmet, { global: true });
  await app.register(cors, { origin: config.corsOrigin, credentials: true });
  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.timeWindow,
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error('Terlalu banyak request'), {
        statusCode: context.statusCode,
        code: 'RATE_LIMITED',
      }),
  });

  app.addHook('onRequest', attachCorrelation);

  // Route tak dikenal memakai bentuk error yang SAMA dengan service di belakang
  // gateway ({ error: { message, code } }) — bukan format bawaan Fastify — dan
  // ikut dihitung rate-limit supaya tidak bisa dipakai memindai route tanpa batas.
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (_request, reply) => {
    reply.code(404).send({ error: { message: 'Resource tidak ditemukan', code: 'NOT_FOUND' } });
  });

  // Route milik gateway sendiri (bukan proxy).
  app.get('/health', { config: { rateLimit: false } }, aggregatedHealth);
  app.get('/', { config: { rateLimit: false } }, async () => ({
    service: 'gateway',
    status: 'ok',
  }));

  // Reverse proxy ke tiap service. Target dari env (Konvensi Konfigurasi).
  // Correlation ID & X-Forwarded-For sudah disuntikkan ke request.raw.headers
  // oleh hook attachCorrelation, jadi diteruskan otomatis oleh proxy.
  // Daftar ini = inventaris API publik (OWASP API9); openapi.json harus mencakup
  // semuanya, dicek oleh tes tiap service.
  const routes: { prefix: string; upstream: string; rewritePrefix: string }[] = [
    { prefix: '/auth', upstream: config.services.auth, rewritePrefix: '' }, // /auth/login → <auth>/login
    { prefix: '/products', upstream: config.services.product, rewritePrefix: '/products' },
    { prefix: '/orders', upstream: config.services.order, rewritePrefix: '/orders' },
    { prefix: '/cart', upstream: config.services.order, rewritePrefix: '/cart' },
  ];
  const replyOptions = { onError: upstreamFailure };
  const openapi = readFileSync(new URL('../openapi.json', import.meta.url), 'utf8');

  // Versi saat ini: /v1/... (publik: /api/v1/...).
  await app.register(
    async (v1) => {
      // Same aggregated health as /health, so clients need a single base URL.
      v1.get('/health', { config: { rateLimit: false } }, aggregatedHealth);
      v1.get('/openapi.json', async (_request, reply) =>
        reply.type('application/json').header('cache-control', 'public, max-age=300').send(openapi),
      );
      for (const route of routes) await v1.register(httpProxy, { ...route, replyOptions });
    },
    { prefix: '/v1' },
  );

  // Jalur lama tanpa versi: perilaku sama, ditandai usang (RFC 9745 Deprecation,
  // RFC 8594 Sunset) dan menunjuk penggantinya, supaya klien punya waktu pindah.
  const { legacy, publicPrefix } = config.api;
  if (legacy.enabled) {
    const deprecation = `@${Math.floor(Date.parse(legacy.deprecatedAt) / 1000)}`;
    const sunset = new Date(legacy.sunset).toUTCString();
    await app.register(async (unversioned) => {
      unversioned.addHook('onRequest', async (request, reply) => {
        reply
          .header('deprecation', deprecation)
          .header('sunset', sunset)
          .header('link', `<${publicPrefix}/v1${request.url}>; rel="successor-version"`);
        // Siapa yang masih memakai jalur lama menentukan kapan aman dimatikan.
        request.log.info({ legacyPath: request.routeOptions.url }, 'jalur API tanpa versi');
      });
      for (const route of routes) await unversioned.register(httpProxy, { ...route, replyOptions });
    });
  }

  return app;
}
