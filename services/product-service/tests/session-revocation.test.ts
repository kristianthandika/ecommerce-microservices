import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID, generateKeyPairSync, createPublicKey, type JsonWebKey } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';

/** product-service refuses access tokens of sessions that auth-service revoked. */
const SERVICE_TOKEN = 'test-service-token-with-at-least-32-characters';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const jwk = { ...(createPublicKey(publicKey).export({ format: 'jwk' }) as JsonWebKey), kid: 'k1' };
const admin = (sid: string) =>
  jwt.sign({ role: 'admin', sid }, privateKey, {
    algorithm: 'RS256',
    keyid: 'k1',
    subject: 'admin-1',
    issuer: 'auth-service',
    audience: 'ecommerce-api',
    expiresIn: '15m',
  });

const revoked: string[] = [];
let authDouble: Server;
let app: Express;

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.INTERNAL_SERVICE_TOKEN = SERVICE_TOKEN;
  process.env.REVOCATION_MAX_AGE_MS = '500';
  authDouble = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (!req.url?.startsWith('/internal/revocations'))
      return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.headers['x-service-token'] !== SERVICE_TOKEN) {
      res.statusCode = 401;
      return res.end('{}');
    }
    res.end(
      JSON.stringify({ revoked: revoked.map((sid) => ({ sid, until: Date.now() + 60_000 })) }),
    );
  });
  await new Promise<void>((resolve) => authDouble.listen(0, resolve));
  process.env.AUTH_SERVICE_URL = `http://127.0.0.1:${(authDouble.address() as AddressInfo).port}`;
  app = (await import('../src/app.ts')).createApp();
});
afterAll(() => new Promise<void>((resolve) => authDouble.close(() => resolve())));

describe('revoked sessions', () => {
  it('refuses an administrator token after its session was revoked', async () => {
    const stolen = randomUUID();
    const summary = (sid: string) =>
      request(app)
        .get('/products/admin/summary')
        .set('authorization', `Bearer ${admin(sid)}`);
    expect((await summary(stolen)).status).toBe(200);
    revoked.push(stolen);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const refused = await summary(stolen);
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('SESSION_REVOKED');
    expect((await summary(randomUUID())).status).toBe(200);
  });
});
