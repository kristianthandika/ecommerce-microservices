import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

/**
 * Test gateway m3.1 pakai `fastify.inject()` (bawaan Fastify): request diproses
 * tanpa membuka port. Upstream (auth/product/order) diwakili http double yang
 * benar-benar listen dan MEMANTULKAN path + header yang ia terima, supaya kita
 * bisa melihat apa yang sebenarnya diteruskan proxy.
 */
let app: FastifyInstance;
const doubles: Server[] = [];

function echo(name: string): Server {
  return createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ service: name, path: req.url, received: req.headers }));
  });
}
const listen = (server: Server): Promise<string> =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      doubles.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }),
  );

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.GATEWAY_RATE_LIMIT_MAX = '1000';
  process.env.AUTH_SERVICE_URL = await listen(echo('auth-service'));
  process.env.PRODUCT_SERVICE_URL = await listen(echo('product-service'));
  process.env.ORDER_SERVICE_URL = await listen(echo('order-service'));
  const { buildApp } = await import('../src/app.ts');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  for (const server of doubles) await new Promise((resolve) => server.close(resolve));
});

describe('gateway m3.1 — reverse proxy', () => {
  it('meneruskan /products ke product-service dengan path yang sama', async () => {
    const res = await app.inject({ method: 'GET', url: '/products?q=mug' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ service: 'product-service', path: '/products?q=mug' });
  });

  it('meneruskan /orders ke order-service', async () => {
    const res = await app.inject({ method: 'GET', url: '/orders' });
    expect(res.json()).toMatchObject({ service: 'order-service', path: '/orders' });
  });

  it('memotong prefix /auth: /auth/login tiba di auth-service sebagai /login', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
    expect(res.json()).toMatchObject({ service: 'auth-service', path: '/login' });
  });

  it('menimpa X-Forwarded-For kiriman klien dengan IP yang diamati gateway (anti-spoof)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    const { received } = res.json();
    expect(received['x-real-ip']).toBeTruthy();
    expect(received['x-forwarded-for']).not.toBe('1.2.3.4');
  });

  it('security header (helmet) muncul di response gateway', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('header rate-limit aktif di level gateway', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
  });
});
