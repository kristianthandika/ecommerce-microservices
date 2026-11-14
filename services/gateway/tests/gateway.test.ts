import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

/**
 * Test gateway pakai `fastify.inject()` (BAWAAN Fastify) untuk route biasa —
 * lebih cepat, tanpa port sungguhan. Upstream (auth/product/order) diwakili
 * http double yang benar-benar listen supaya proxy bisa meneruskan request.
 */
let app: FastifyInstance;
let authDouble: Server;
let productDouble: Server;
let orderDouble: Server;

function makeDouble(name: string, onProducts = false): Server {
  return createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ status: 'ok', service: name }));
    }
    if (onProducts && req.url?.startsWith('/products')) {
      res.setHeader('content-type', 'application/json');
      // Service di belakang gateway punya bawaan CORS sendiri (origin pengembangan).
      res.setHeader('access-control-allow-origin', 'http://upstream-default.example');
      res.setHeader('access-control-allow-credentials', 'true');
      if (req.url.includes('cacheable')) res.setHeader('cache-control', 'public, max-age=300');
      return res.end(JSON.stringify({ received: req.headers }));
    }
    res.statusCode = 404;
    res.end();
  });
}

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, () => resolve((server.address() as AddressInfo).port)));

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.GATEWAY_RATE_LIMIT_MAX = '20';

  authDouble = makeDouble('auth-service');
  productDouble = makeDouble('product-service', true);
  orderDouble = makeDouble('order-service');
  const [ap, pp, op] = await Promise.all([
    listen(authDouble),
    listen(productDouble),
    listen(orderDouble),
  ]);
  process.env.AUTH_SERVICE_URL = `http://127.0.0.1:${ap}`;
  process.env.PRODUCT_SERVICE_URL = `http://127.0.0.1:${pp}`;
  process.env.ORDER_SERVICE_URL = `http://127.0.0.1:${op}`;

  const { buildApp } = await import('../src/app.ts');
  app = await buildApp({ enableTracing: false });
  await app.ready();
});

it('rate-limit exhaustion returns a consistent 429 rather than 500', async () => {
  let response = await app.inject({ method: 'GET', url: '/products', remoteAddress: '192.0.2.99' });
  for (let i = 0; i < 21 && response.statusCode !== 429; i++)
    response = await app.inject({ method: 'GET', url: '/products', remoteAddress: '192.0.2.99' });
  expect(response.statusCode).toBe(429);
  expect(response.json().error.code).toBe('RATE_LIMITED');
  expect(response.headers['retry-after']).toBeDefined();
});

afterAll(async () => {
  await app?.close();
  for (const s of [authDouble, productDouble, orderDouble]) {
    if (s?.listening) await new Promise<void>((r) => s.close(() => r()));
  }
});

describe('gateway proxy, correlation & health', () => {
  it('proxy /products diteruskan ke product-service', async () => {
    const res = await app.inject({ method: 'GET', url: '/products' });
    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBeTruthy();
  });

  it('meneruskan correlation ID YANG SAMA ke service & memantulkannya ke response', async () => {
    const cid = 'test-correlation-123';
    const res = await app.inject({
      method: 'GET',
      url: '/products',
      headers: { 'x-correlation-id': cid },
    });
    expect(res.headers['x-correlation-id']).toBe(cid);
    expect(res.json().received['x-correlation-id']).toBe(cid);
  });

  it('generate correlation ID kalau klien tidak mengirimnya', async () => {
    const res = await app.inject({ method: 'GET', url: '/products' });
    expect(res.headers['x-correlation-id']).toMatch(/[0-9a-f-]{36}/);
  });

  it('meneruskan IP klien asli lewat X-Forwarded-For / X-Real-IP (anti-spoof)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    const received = res.json().received;
    expect(received['x-real-ip']).toBeTruthy();
    expect(received['x-forwarded-for']).not.toBe('1.2.3.4'); // spoof ditolak
  });

  it('membuang x-service-token kiriman klien sebelum diteruskan ke service internal', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products',
      headers: { 'x-service-token': 'forged-by-a-public-client' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().received['x-service-token']).toBeUndefined();
  });

  it('route tak dikenal → 404 dengan bentuk error seragam + correlation ID', async () => {
    const res = await app.inject({ method: 'GET', url: '/tidak-ada' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { message: 'Resource tidak ditemukan', code: 'NOT_FOUND' },
    });
    expect(res.headers['x-correlation-id']).toBeTruthy();
    // Route internal product-service tidak pernah terjangkau lewat gateway.
    const internal = await app.inject({ method: 'POST', url: '/internal/reservations/x' });
    expect(internal.statusCode).toBe(404);
    expect(internal.json().error.code).toBe('NOT_FOUND');
  });

  it('penjaga route internal memakai path yang AKAN dikirim proxy (segmen titik, backslash)', async () => {
    const { isInternalPath } = await import('../src/app.ts');
    for (const path of [
      '/v1/auth/internal/revocations',
      '/auth/internal/revocations',
      '/v1/auth/./internal/revocations',
      '/v1/auth/%2e/internal/revocations',
      '/v1/auth/%2E/internal/revocations',
      '/v1/auth/.\\internal/revocations',
      '/v1/auth/.%2Finternal/revocations',
      '/v1/auth/x/../internal/revocations',
      '/v1/auth//internal/revocations',
      '/v1/auth/%69nternal/revocations?x=1',
      '/V1/AUTH/INTERNAL',
    ])
      expect(isInternalPath(path), path).toBe(true);
    for (const path of [
      '/v1/auth/login',
      '/v1/products?q=internal',
      '/v1/orders/admin/summary',
      '/v1/auth/internalx',
    ])
      expect(isInternalPath(path), path).toBe(false);
  });

  it('kebijakan CORS dan cache ditentukan gateway, bukan bawaan service di belakangnya', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/products',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.statusCode).toBe(200);
    // Origin milik gateway (CORS_ORIGIN), bukan yang dikirim upstream.
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    // Respons tanpa cache-control tidak boleh tersimpan di browser/proxy.
    expect(res.headers['cache-control']).toBe('no-store');
    // Service yang menyatakan sendiri boleh di-cache tetap dihormati.
    const cacheable = await app.inject({ method: 'GET', url: '/v1/products?cacheable=1' });
    expect(cacheable.headers['cache-control']).toBe('public, max-age=300');
  });

  it('batas waktu request aktif (bawaan Fastify: tanpa batas)', () => {
    expect(app.server.requestTimeout).toBe(15_000);
  });

  it('security header (helmet) muncul di response gateway', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('header rate-limit aktif di level gateway', async () => {
    const response = await app.inject({ method: 'GET', url: '/products' });
    expect(response.headers['x-ratelimit-limit']).toBeDefined();
  });

  it('aggregated /health → ok saat semua up, degraded saat ada yang down', async () => {
    const up = await app.inject({ method: 'GET', url: '/health' });
    expect(up.statusCode).toBe(200);
    expect(up.json().status).toBe('ok');
    expect(up.json().services).toMatchObject({ auth: 'up', product: 'up', order: 'up' });

    await new Promise<void>((r) => orderDouble.close(() => r()));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const down = await app.inject({ method: 'GET', url: '/health' });
    expect(down.statusCode).toBe(503);
    expect(down.json().status).toBe('degraded');
    expect(down.json().services.order).toBe('down');
  });

  it('upstream yang mati → 503 UPSTREAM_UNAVAILABLE (bukan 500 seolah gateway yang bug)', async () => {
    // orderDouble sudah ditutup oleh tes sebelumnya → connection refused.
    for (const url of ['/orders', '/cart']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        error: { message: 'Layanan sementara tidak tersedia', code: 'UPSTREAM_UNAVAILABLE' },
      });
      expect(res.headers['retry-after']).toBe('5');
      expect(res.headers['x-correlation-id']).toBeTruthy();
    }
    // Service lain yang masih hidup tidak ikut terdampak.
    expect((await app.inject({ method: 'GET', url: '/products' })).statusCode).toBe(200);
  });
});
