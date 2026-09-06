import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';

/**
 * Test gateway pakai `fastify.inject()` (BAWAAN Fastify) untuk route biasa —
 * lebih cepat, tanpa port sungguhan. Upstream (auth/product/order) diwakili
 * http double yang benar-benar listen supaya proxy bisa meneruskan request.
 */
let app;
let authDouble;
let productDouble;
let orderDouble;

function makeDouble(name, onProducts) {
  return createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ status: 'ok', service: name }));
    }
    if (onProducts && req.url.startsWith('/products')) {
      // Echo header yang diterima → untuk memverifikasi penerusan gateway.
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ received: req.headers }));
    }
    res.statusCode = 404;
    res.end();
  });
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.GATEWAY_RATE_LIMIT_MAX = '1000';

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

  const { buildApp } = await import('../src/app.js');
  app = await buildApp({ enableTracing: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  for (const s of [authDouble, productDouble, orderDouble]) {
    if (s?.listening) await new Promise((r) => s.close(r));
  }
});

describe('gateway proxy, correlation & health', () => {
  it('proxy /products diteruskan ke product-service', async () => {
    const res = await app.inject({ method: 'GET', url: '/products' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.received).toBeTruthy();
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
      // Klien mencoba spoof XFF — gateway HARUS menimpanya, bukan mempercayainya.
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    const received = res.json().received;
    expect(received['x-real-ip']).toBeTruthy();
    expect(received['x-forwarded-for']).not.toBe('1.2.3.4'); // spoof ditolak
  });

  it('security header (helmet) muncul di response gateway', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('header rate-limit aktif di level gateway', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
  });

  it('aggregated /health → ok saat semua up, degraded saat ada yang down', async () => {
    const up = await app.inject({ method: 'GET', url: '/health' });
    expect(up.statusCode).toBe(200);
    expect(up.json().status).toBe('ok');
    expect(up.json().services).toMatchObject({ auth: 'up', product: 'up', order: 'up' });

    // Matikan order-service double → health harus degraded (503).
    await new Promise((r) => orderDouble.close(r));
    const down = await app.inject({ method: 'GET', url: '/health' });
    expect(down.statusCode).toBe(503);
    expect(down.json().status).toBe('degraded');
    expect(down.json().services.order).toBe('down');
  });
});
