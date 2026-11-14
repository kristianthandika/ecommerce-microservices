import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID, generateKeyPairSync, createPublicKey, type JsonWebKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createRevocationChecker } from '../src/middleware/revocations.ts';

/**
 * Access tokens of a revoked session are refused within seconds (not at expiry),
 * and only accounts with a verified email may create orders.
 */
const SERVICE_TOKEN = 'test-service-token-with-at-least-32-characters';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const jwk = { ...(createPublicKey(publicKey).export({ format: 'jwk' }) as JsonWebKey), kid: 'k1' };
const sign = (claims: Record<string, unknown> = {}, sub = 'buyer') =>
  jwt.sign({ role: 'user', sid: 'default-session', ...claims }, privateKey, {
    algorithm: 'RS256',
    keyid: 'k1',
    subject: sub,
    issuer: 'auth-service',
    audience: 'ecommerce-api',
    expiresIn: '15m',
  });

const revoked: string[] = [];
let listHits = 0;
let unauthenticatedListCalls = 0;
let listDown = false;
const servers: Server[] = [];
let base = '';
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.INTERNAL_SERVICE_TOKEN = SERVICE_TOKEN;
  process.env.REVOCATION_MAX_AGE_MS = '500';
  process.env.PRODUCT_SERVICE_URL = 'http://127.0.0.1:9'; // not used by these requests
  process.env.AUTH_SERVICE_URL = await listen(
    createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (!req.url?.startsWith('/internal/revocations'))
        return res.end(JSON.stringify({ keys: [jwk] }));
      if (req.headers['x-service-token'] !== SERVICE_TOKEN) {
        unauthenticatedListCalls++;
        res.statusCode = 401;
        return res.end('{}');
      }
      if (listDown) {
        res.statusCode = 503;
        return res.end('{}');
      }
      listHits++;
      res.end(
        JSON.stringify({ revoked: revoked.map((sid) => ({ sid, until: Date.now() + 60_000 })) }),
      );
    }),
  );
  const app = (await import('../src/app.ts')).createApp();
  base = await listen(createServer(app));
});
afterAll(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

async function call(path: string, token: string, init: { method?: string; json?: unknown } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

describe('revoked sessions', () => {
  const sidA = randomUUID();
  const sidB = randomUUID();
  const sessionA = sign({ sid: sidA });
  const sessionB = sign({ sid: sidB });

  it('refuses a revoked session within the refresh window, and only that session', async () => {
    expect((await call('/cart', sessionA)).status).toBe(200);
    expect((await call('/cart', sessionB)).status).toBe(200);
    revoked.push(sidA); // what auth-service publishes after a logout
    await sleep(600);
    const refused = await call('/cart', sessionA);
    expect(refused.status).toBe(401);
    expect(refused.data.error.code).toBe('SESSION_REVOKED');
    // The same user's other session works; tokens without a session ID cannot bypass logout.
    expect((await call('/cart', sessionB)).status).toBe(200);
    for (const sid of [undefined, '', 123])
      expect((await call('/cart', sign({ sid }))).status).toBe(401);
  });

  it('answers from memory while the list is fresh and authenticates as a service', async () => {
    await sleep(600);
    await call('/cart', sessionB); // refreshes once
    const before = listHits;
    await Promise.all(Array.from({ length: 10 }, () => call('/cart', sessionB)));
    expect(listHits).toBe(before);
    expect(unauthenticatedListCalls).toBe(0);
  });

  it('denies known revoked sessions and fails closed for others when the list is stale', async () => {
    listDown = true;
    try {
      await sleep(600);
      expect((await call('/cart', sessionA)).status).toBe(401);
      const unavailable = await call('/cart', sessionB);
      expect(unavailable.status).toBe(503);
      expect(unavailable.data.error.code).toBe('SESSION_CHECK_UNAVAILABLE');
    } finally {
      listDown = false;
      await sleep(600);
    }
  });
});

describe('revocation list cache', () => {
  it('fails closed on the first fetch failure and coalesces concurrent callers during cooldown', async () => {
    let calls = 0;
    const checker = createRevocationChecker(async () => {
      calls++;
      throw new Error('offline');
    });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => checker('unknown')));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    await expect(checker('unknown')).rejects.toMatchObject({
      status: 503,
      code: 'SESSION_CHECK_UNAVAILABLE',
    });
    expect(calls).toBe(1);
  });

  it('waits for a refresh when stale, shares it, and backs off after a failure', async () => {
    let clock = 0;
    let fetches = 0;
    let fail = false;
    const errors: unknown[] = [];
    const isRevoked = createRevocationChecker(
      async () => {
        fetches++;
        if (fail) throw new Error('auth-service down');
        return ['gone'];
      },
      { maxAgeMs: 5000, cooldownMs: 5000, now: () => clock, onError: (err) => errors.push(err) },
    );
    // First use: concurrent callers share one fetch and get its result.
    expect(await Promise.all([isRevoked('gone'), isRevoked('alive'), isRevoked('gone')])).toEqual([
      true,
      false,
      true,
    ]);
    expect(fetches).toBe(1);
    clock = 4999;
    await isRevoked('alive');
    expect(fetches).toBe(1); // still fresh
    clock = 5000;
    fail = true;
    await expect(isRevoked('alive')).rejects.toMatchObject({ status: 503 });
    expect(await isRevoked('gone')).toBe(true); // known revocation survives the failure
    expect(fetches).toBe(2);
    expect(errors).toHaveLength(1);
    clock = 9999;
    await expect(isRevoked('alive')).rejects.toMatchObject({ status: 503 });
    expect(fetches).toBe(2); // inside the cooldown: no request storm against a dead service
    clock = 10_000;
    fail = false;
    expect(await isRevoked('alive')).toBe(false);
    expect(fetches).toBe(3);
  });
});

describe('verified email is required to create orders', () => {
  const order = { items: [{ productId: randomUUID(), quantity: 1 }] };
  const checkout = {
    version: randomUUID(),
    shippingAddress: {
      recipient: 'Test Buyer',
      phone: '081234567890',
      street: 'Jalan Test 123',
      city: 'Bandung',
      province: 'Jawa Barat',
      postalCode: '40123',
    },
  };

  it('refuses unverified accounts at both order-creating endpoints, but not the cart', async () => {
    const unverified = sign({ email_verified: false }, 'newcomer');
    for (const [path, json] of [
      ['/orders', order],
      ['/cart/checkout', checkout],
    ] as const) {
      const response = await call(path, unverified, { method: 'POST', json });
      expect(response.status, path).toBe(403);
      expect(response.data.error.code).toBe('EMAIL_NOT_VERIFIED');
    }
    expect((await call('/cart', unverified)).status).toBe(200);
    expect((await call('/orders', unverified)).status).toBe(200);
  });

  it('allows only the literal verified claim, including on pre-upgrade tokens', async () => {
    for (const token of [sign({ email_verified: true }, 'regular')]) {
      // No Idempotency-Key: reaching that check proves the email gate was passed.
      const response = await call('/orders', token, { method: 'POST', json: order });
      expect(response.status).toBe(400);
      expect(response.data.error.code).not.toBe('EMAIL_NOT_VERIFIED');
    }
    for (const email_verified of [undefined, false, 'true', 1]) {
      const response = await call('/orders', sign({ email_verified }), {
        method: 'POST',
        json: order,
      });
      expect(response.status).toBe(403);
      expect(response.data.error.code).toBe('EMAIL_NOT_VERIFIED');
    }
  });
});
