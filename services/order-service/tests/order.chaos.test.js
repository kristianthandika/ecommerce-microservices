import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { generateKeyPairSync, createPublicKey, createHash } from 'node:crypto';
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
const jwkBase = createPublicKey(publicKey).export({ format: 'jwk' });
const kid = createHash('sha256')
  .update(JSON.stringify({ e: jwkBase.e, kty: jwkBase.kty, n: jwkBase.n }))
  .digest('base64url');
const jwk = { ...jwkBase, kid, use: 'sig', alg: 'RS256' };
const token = jwt.sign({ role: 'user' }, privateKey, {
  algorithm: 'RS256',
  keyid: kid,
  subject: 'user-1',
  issuer: 'auth-service',
  expiresIn: '1h',
});

let authServer;
let productDouble;
let orderServer;
let orderBase;

// Kontrol perilaku product-service double.
let mode = 'ok'; // 'ok' | '503' | 'hang'
let productHits = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  // Parameter resilience kecil supaya test cepat & deterministik.
  process.env.PRODUCT_TIMEOUT_MS = '400';
  process.env.PRODUCT_RETRIES = '1';
  process.env.PRODUCT_RETRY_BASE_MS = '20';
  process.env.PRODUCT_CB_THRESHOLD = '3';
  process.env.PRODUCT_CB_RESET_MS = '600';

  // Fake JWKS (auth-service) — selalu hidup.
  authServer = createServer((req, res) => {
    if (req.url.startsWith('/.well-known/jwks.json')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => authServer.listen(0, r));
  process.env.AUTH_SERVICE_URL = `http://127.0.0.1:${authServer.address().port}`;

  // Test double product-service (port sungguhan) dengan perilaku terkontrol.
  productDouble = createServer((req, res) => {
    productHits += 1;
    if (mode === 'hang') return; // sengaja tidak merespons → memicu timeout
    if (mode === '503') {
      res.statusCode = 503;
      return res.end('unavailable');
    }
    const id = req.url.split('/').pop();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ product: { id, name: 'Kaos', price: 100000, stock: 100 } }));
  });
  await new Promise((r) => productDouble.listen(0, r));
  process.env.PRODUCT_SERVICE_URL = `http://127.0.0.1:${productDouble.address().port}`;

  // order-service asli — benar-benar listen.
  const app = (await import('../src/app.js')).createApp();
  orderServer = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  orderBase = `http://127.0.0.1:${orderServer.address().port}`;
});

afterAll(async () => {
  // Tutup semua server dengan benar (promisify) supaya test tidak menggantung.
  for (const s of [orderServer, productDouble, authServer]) {
    if (s?.listening) await new Promise((r) => s.close(r));
  }
});

async function postOrder() {
  return fetch(`${orderBase}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ items: [{ productId: 'p1', quantity: 2 }] }),
  });
}

describe('order-service chaos', () => {
  it('(1) alur normal saat product-service hidup → order dibuat (201)', async () => {
    mode = 'ok';
    const res = await postOrder();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.order.total).toBe(200000); // 100000 * 2
    expect(body.order.status).toBe('CONFIRMED');
  });

  it('(2) product-service tidak merespons (timeout) → order TETAP merespons graceful (503, bukan hang/crash)', async () => {
    mode = 'hang';
    const res = await postOrder();
    expect(res.status).toBe(503); // degradasi anggun setelah timeout+retry habis
  });

  it('(3) setelah circuit breaker OPEN, panggilan ke product-service TIDAK bertambah linear', async () => {
    mode = '503';
    productHits = 0;

    // Dorong sampai breaker OPEN.
    for (let i = 0; i < 4; i += 1) await postOrder();
    const hitsAfterOpen = productHits;

    // Kirim lebih banyak request saat OPEN → harus ditolak cepat tanpa
    // memanggil product-service lagi.
    for (let i = 0; i < 5; i += 1) await postOrder();

    expect(productHits).toBe(hitsAfterOpen); // tidak bertambah setelah OPEN
    expect(hitsAfterOpen).toBeLessThan(9 * 2); // jauh di bawah "linear" (9 req * 2 attempt)
  });

  it('(4) setelah product-service pulih & resetTimeout lewat → breaker menutup, order sukses lagi', async () => {
    mode = 'ok';
    await sleep(700); // > resetTimeoutMs → HALF_OPEN
    const res = await postOrder();
    expect(res.status).toBe(201); // HALF_OPEN → sukses → CLOSED
  });
});
