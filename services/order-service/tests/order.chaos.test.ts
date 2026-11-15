import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, createPublicKey, createHash, type JsonWebKey } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

/**
 * Chaos test m2.3 — BEDA dari test route biasa: order-service DAN test-double
 * product-service benar-benar `.listen()` di port sungguhan, supaya panggilan
 * network asli bisa gagal & pulih. Membuktikan retry, circuit breaker, dan
 * graceful degradation bekerja end-to-end.
 */

// --- keypair + JWK + kid (meniru auth-service) ---
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const jwkBase = createPublicKey(publicKey).export({ format: 'jwk' }) as JsonWebKey;
const kid = createHash('sha256')
  .update(JSON.stringify({ e: jwkBase.e, kty: jwkBase.kty, n: jwkBase.n }))
  .digest('base64url');
const jwk = { ...jwkBase, kid, use: 'sig', alg: 'RS256' };
const token = jwt.sign({ role: 'user', sid: 'test-session', email_verified: true }, privateKey, {
  algorithm: 'RS256',
  keyid: kid,
  subject: 'user-1',
  issuer: 'auth-service',
  audience: 'ecommerce-api',
  expiresIn: '1h',
});

let authServer: Server;
let productDouble: Server;
let orderServer: Server;
let orderBase: string;

type Mode = 'ok' | '503' | 'hang';
let mode: Mode = 'ok';
let productHits = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const port = (s: Server): number => (s.address() as AddressInfo).port;

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.PRODUCT_TIMEOUT_MS = '400';
  process.env.PRODUCT_RETRIES = '1';
  process.env.PRODUCT_RETRY_BASE_MS = '20';
  process.env.PRODUCT_CB_THRESHOLD = '3';
  process.env.PRODUCT_CB_RESET_MS = '600';
  // Resilience, not the per-customer hold limit, is under test: outages leave orders PENDING.
  process.env.ORDER_MAX_OPEN_ORDERS = '100';
  process.env.ORDER_MAX_UNITS_PER_PRODUCT = '1000';

  authServer = createServer((req, res) => {
    if (req.url?.startsWith('/.well-known/jwks.json')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    } else if (req.url === '/internal/revocations') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ revoked: [] }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => authServer.listen(0, r));
  process.env.AUTH_SERVICE_URL = `http://127.0.0.1:${port(authServer)}`;

  productDouble = createServer((req, res) => {
    productHits += 1;
    if (mode === 'hang') return; // sengaja tidak merespons → memicu timeout
    if (mode === '503') {
      res.statusCode = 503;
      return res.end('unavailable');
    }
    const id = req.url?.split('/').pop();
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        reservation: {
          id,
          items: [
            {
              productId: '11111111-1111-4111-8111-111111111111',
              name: 'Kaos',
              unitPrice: 100000,
              quantity: 2,
              subtotal: 200000,
            },
          ],
          total: 200000,
        },
      }),
    );
  });
  await new Promise<void>((r) => productDouble.listen(0, r));
  process.env.PRODUCT_SERVICE_URL = `http://127.0.0.1:${port(productDouble)}`;

  const app = (await import('../src/app.ts')).createApp();
  orderServer = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  orderBase = `http://127.0.0.1:${port(orderServer)}`;
});

afterAll(async () => {
  for (const s of [orderServer, productDouble, authServer]) {
    if (s?.listening) await new Promise<void>((r) => s.close(() => r()));
  }
});

async function postOrder(): Promise<Response> {
  return fetch(`${orderBase}/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({
      items: [{ productId: '11111111-1111-4111-8111-111111111111', quantity: 2 }],
    }),
  });
}

describe('order-service chaos', () => {
  it('(1) alur normal saat product-service hidup → order dibuat (201)', async () => {
    mode = 'ok';
    const res = await postOrder();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { order: { total: number; status: string } };
    expect(body.order.total).toBe(200000); // 100000 * 2
    expect(body.order.status).toBe('CONFIRMED');
  });

  it('(2) product-service tidak merespons (timeout) → order TETAP merespons graceful (503, bukan hang/crash)', async () => {
    mode = 'hang';
    const res = await postOrder();
    expect(res.status).toBe(503);
  });

  it('(3) setelah circuit breaker OPEN, panggilan ke product-service TIDAK bertambah linear', async () => {
    mode = '503';
    productHits = 0;

    for (let i = 0; i < 4; i += 1) await postOrder();
    const hitsAfterOpen = productHits;

    for (let i = 0; i < 5; i += 1) await postOrder();

    expect(productHits).toBe(hitsAfterOpen); // tidak bertambah setelah OPEN
    expect(hitsAfterOpen).toBeLessThan(9 * 2); // jauh di bawah "linear"
  });

  it('(4) setelah product-service pulih & resetTimeout lewat → breaker menutup, order sukses lagi', async () => {
    mode = 'ok';
    await sleep(700);
    const res = await postOrder();
    expect(res.status).toBe(201);
  });
});
