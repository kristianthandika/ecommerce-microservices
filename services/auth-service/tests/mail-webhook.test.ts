import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

/** Production transport: mail leaves through the operator's webhook, nothing is kept. */
const keysDir = mkdtempSync(join(tmpdir(), 'auth-webhook-'));
process.env.KEYS_DIR = keysDir;
process.env.LOG_LEVEL = 'silent';
process.env.MAIL_TRANSPORT = 'webhook';
process.env.MAIL_WEBHOOK_TOKEN = 'webhook-secret';
process.env.PUBLIC_APP_URL = 'https://shop.example/';

let app: import('express').Express;
let relay: Server;
let relayStatus = 200;
const received: { authorization?: string; body: Record<string, string> }[] = [];

beforeAll(async () => {
  relay = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      received.push({ authorization: req.headers.authorization, body: JSON.parse(raw) });
      res.statusCode = relayStatus;
      res.end();
    });
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  process.env.MAIL_WEBHOOK_URL = `http://127.0.0.1:${(relay.address() as AddressInfo).port}/send`;
  app = (await import('../src/app.ts')).createApp();
});
afterAll(async () => {
  await new Promise((resolve) => relay.close(resolve));
  rmSync(keysDir, { recursive: true, force: true });
});

describe('webhook mail transport', () => {
  it('posts the verification mail to the relay and exposes no outbox', async () => {
    const registered = await request(app)
      .post('/register')
      .send({ email: 'hook@test.local', password: 'correct-horse-battery' });
    expect(registered.status).toBe(202);
    // Mail leaves after the response, so that its timing says nothing about the address.
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].authorization).toBe('Bearer webhook-secret');
    expect(Object.keys(received[0].body).sort()).toEqual(['subject', 'text', 'to']);
    expect(received[0].body.to).toBe('hook@test.local');
    expect(received[0].body.text).toMatch(/https:\/\/shop\.example\/verify-email#token=[\w-]{43}/);
    // The training mailbox does not exist when mail really leaves the system.
    expect((await request(app).get('/admin/outbox')).status).toBe(404);
  });

  it('answers the same when the relay fails; registering again later sends a new link', async () => {
    relayStatus = 500;
    const registered = await request(app)
      .post('/register')
      .send({ email: 'unlucky@test.local', password: 'correct-horse-battery' });
    expect(registered.status).toBe(202);
    expect(registered.body).toEqual({ status: 'accepted', verificationRequired: true });
    await vi.waitFor(() => expect(received).toHaveLength(2));
  });
});
