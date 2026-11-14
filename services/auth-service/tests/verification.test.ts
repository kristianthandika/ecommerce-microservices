import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';

/** Email verification with the training transport (`outbox`). */
const keysDir = mkdtempSync(join(tmpdir(), 'auth-verification-'));
process.env.KEYS_DIR = keysDir;
process.env.LOG_LEVEL = 'silent';
process.env.SEED_ADMIN_ENABLED = 'true';
process.env.SEED_ADMIN_EMAIL = 'admin@test.local';
process.env.SEED_ADMIN_PASSWORD = 'administrator-password-123';

let app: import('express').Express;
let verification: typeof import('../src/verification.ts');
let adminToken = '';
const password = 'correct-horse-battery';
const browser = { origin: 'http://localhost:3000', 'x-requested-with': 'fetch' };
// Every request gets its own client address: the per-IP limiter is not under test.
let seq = 0;
const post = (path: string) =>
  request(app)
    .post(path)
    .set('x-forwarded-for', `203.0.113.${++seq % 250}`);
const claims = (token: string) => jwt.decode(token) as { email_verified: boolean };

beforeAll(async () => {
  app = (await import('../src/app.ts')).createApp();
  verification = await import('../src/verification.ts');
  await (await import('../src/users.ts')).seedAdmin();
  const admin = await post('/login').send({
    email: 'admin@test.local',
    password: 'administrator-password-123',
  });
  adminToken = admin.body.token;
});
afterAll(() => rmSync(keysDir, { recursive: true, force: true }));

async function outboxFor(address: string, token = adminToken) {
  return request(app)
    .get(`/admin/outbox?to=${encodeURIComponent(address)}`)
    .set('authorization', `Bearer ${token}`);
}
async function mailedToken(address: string): Promise<string> {
  const mail = (await outboxFor(address)).body.messages[0];
  return mail.link.split('#token=')[1];
}

describe('email verification', () => {
  it('creates accounts unverified and mails a single-use link in the URL fragment', async () => {
    const email = 'new@test.local';
    const registered = await post('/register').send({ email: ' New@Test.Local ', password });
    expect(registered.status).toBe(201);
    expect(registered.body.user.emailVerified).toBe(false);
    const login = await post('/login').send({ email, password });
    expect(login.body.user.emailVerified).toBe(false);
    expect(claims(login.body.token).email_verified).toBe(false);

    const outbox = await outboxFor(email);
    expect(outbox.status).toBe(200);
    expect(outbox.headers['cache-control']).toBe('no-store');
    expect(outbox.body.messages).toHaveLength(1);
    const mail = outbox.body.messages[0];
    expect(mail.to).toBe(email);
    expect(mail.link).toMatch(/^http:\/\/localhost:3000\/verify-email#token=[A-Za-z0-9_-]{43}$/);
    expect(mail.text).toContain(mail.link);
    // The outbox is an administrator tool; the account itself cannot read it.
    expect((await outboxFor(email, login.body.token)).status).toBe(403);
    expect((await request(app).get('/admin/outbox')).status).toBe(401);
  });

  it('verifies with the mailed token once; the next token refresh carries the new status', async () => {
    const email = 'confirm@test.local';
    await post('/register').send({ email, password });
    const login = await post('/login').send({ email, password });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const token = await mailedToken(email);

    const verified = await post('/verify-email').send({ token });
    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({ email, emailVerified: true });
    // The old access token still says "unverified" until the session refreshes.
    expect(claims(login.body.token).email_verified).toBe(false);
    const refreshed = await post('/refresh').set(browser).set('cookie', cookie);
    expect(claims(refreshed.body.token).email_verified).toBe(true);

    const again = await post('/verify-email').send({ token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_VERIFICATION_TOKEN');
    for (const bad of ['short', 'x'.repeat(43), '../../etc/passwd'])
      expect((await post('/verify-email').send({ token: bad })).status).toBe(400);
  });

  it('rejects expired tokens', async () => {
    const email = 'late@test.local';
    const { id } = (await post('/register').send({ email, password })).body.user;
    const sentAt = Date.now() - 25 * 3_600_000;
    await verification.sendVerification({ id, email }, sentAt);
    const { listOutbox } = await import('../src/mailer.ts');
    const oldest = listOutbox({ to: email }, sentAt + 1000).at(-1)!;
    const token = oldest.link!.split('#token=')[1];
    expect((await outboxFor(email)).body.messages).toHaveLength(1);
    expect(() => verification.verifyEmail(token)).toThrow('tidak berlaku');
    // Only time made it invalid: one second after sending it was still good.
    expect(verification.verifyEmail(token, sentAt + 1000).emailVerified).toBe(true);
  });

  it('resends for the signed-in user at most once per minute, and never once verified', async () => {
    const email = 'resend@test.local';
    await post('/register').send({ email, password });
    const login = await post('/login').send({ email, password });
    const resend = () =>
      post('/email-verification').set('authorization', `Bearer ${login.body.token}`);

    const throttled = await resend();
    expect(throttled.status).toBe(429);
    expect(throttled.body.error.code).toBe('VERIFICATION_THROTTLED');
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
    expect((await outboxFor(email)).body.messages).toHaveLength(1);

    await verification.resendVerification(login.body.user.id, Date.now() + 61_000);
    const messages = (await outboxFor(email)).body.messages;
    expect(messages).toHaveLength(2);
    // Either link works; verifying makes further resends pointless.
    const token = messages[1].link.split('#token=')[1];
    expect((await post('/verify-email').send({ token })).status).toBe(200);
    await expect(
      verification.resendVerification(login.body.user.id, Date.now() + 200_000),
    ).rejects.toThrow('sudah terverifikasi');
    expect((await post('/email-verification')).status).toBe(401);
  });

  it('requires verification for legacy regular accounts while keeping the seeded admin trusted', async () => {
    const { database } = await import('../src/database.ts');
    const legacy = {
      id: randomUUID(),
      email: 'legacy@test.local',
      role: 'user',
      passwordHash: await bcrypt.hash(password, 10),
    };
    database.store('users_email').set(legacy.email, legacy);
    database.store('users_id').set(legacy.id, legacy);
    const login = await post('/login').send({ email: legacy.email, password });
    expect(login.body.user.emailVerified).toBe(false);
    expect(claims(login.body.token).email_verified).toBe(false);
    expect(claims(adminToken).email_verified).toBe(true);
  });
});
