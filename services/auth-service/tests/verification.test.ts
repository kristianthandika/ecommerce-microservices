import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { cookieOf, mailedToken, mailsFor, nextIp, settle } from './helpers.ts';

/** Email verification with the training transport (`outbox`). */
const keysDir = mkdtempSync(join(tmpdir(), 'auth-verification-'));
process.env.KEYS_DIR = keysDir;
process.env.LOG_LEVEL = 'silent';
process.env.SEED_ADMIN_ENABLED = 'true';
process.env.SEED_ADMIN_EMAIL = 'admin@test.local';
process.env.SEED_ADMIN_PASSWORD = 'administrator-password-123';

let app: import('express').Express;
let verification: typeof import('../src/verification.ts');
let users: typeof import('../src/users.ts');
let adminToken = '';
const password = 'correct-horse-battery';
// Every request gets its own client address: the per-IP limiter is not under test.
const post = (path: string) => request(app).post(path).set('x-forwarded-for', nextIp());
const claims = (token: string) => jwt.decode(token) as { email_verified: boolean };

beforeAll(async () => {
  app = (await import('../src/app.ts')).createApp();
  verification = await import('../src/verification.ts');
  users = await import('../src/users.ts');
  await users.seedAdmin();
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

describe('email verification', () => {
  it('creates accounts pending and mails a single-use link in the URL fragment', async () => {
    const email = 'new@test.local';
    const registered = await post('/register').send({ email: ' New@Test.Local ', password });
    expect(registered.status).toBe(202);
    expect(registered.body).toEqual({ status: 'accepted', verificationRequired: true });
    await settle();

    const outbox = await outboxFor(email);
    expect(outbox.status).toBe(200);
    expect(outbox.headers['cache-control']).toBe('no-store');
    expect(outbox.body.messages).toHaveLength(1);
    const mail = outbox.body.messages[0];
    expect(mail.to).toBe(email);
    expect(mail.link).toMatch(/^http:\/\/localhost:3000\/verify-email#token=[A-Za-z0-9_-]{43}$/);
    expect(mail.text).toContain(mail.link);
    // The outbox is an administrator tool.
    expect((await request(app).get('/admin/outbox')).status).toBe(401);
  });

  it('verifies with the mailed token and the password, once; then the account can sign in', async () => {
    const email = 'confirm@test.local';
    await post('/register').send({ email, password });
    const token = await mailedToken(email);

    const verified = await post('/verify-email').send({ token, password });
    expect(verified.status).toBe(200);
    expect(verified.headers['cache-control']).toBe('no-store');
    expect(verified.body.user).toMatchObject({ email, emailVerified: true });
    // The browser that verified is remembered, so a lockout made by others cannot stop it.
    expect(cookieOf(verified, 'device_id')?.header).toMatch(/HttpOnly/);

    const login = await post('/login').send({ email, password });
    expect(login.status).toBe(200);
    expect(login.body.user.emailVerified).toBe(true);
    expect(claims(login.body.token).email_verified).toBe(true);
    // A verified user is not an administrator.
    expect((await outboxFor(email, login.body.token)).status).toBe(403);

    const again = await post('/verify-email').send({ token, password });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_VERIFICATION_TOKEN');
    for (const bad of ['short', 'x'.repeat(43), '../../etc/passwd'])
      expect((await post('/verify-email').send({ token: bad, password })).status).toBe(400);
    // The link alone, without a password, is not a valid request.
    expect((await post('/verify-email').send({ token })).status).toBe(400);
  });

  it('rejects expired tokens', async () => {
    const email = 'late@test.local';
    await post('/register').send({ email, password });
    const account = users.findAccountByEmail(email)!;
    const sentAt = Date.now() - 25 * 3_600_000;
    await verification.sendVerification(account, sentAt);
    const { listOutbox } = await import('../src/mailer.ts');
    const oldest = listOutbox({ to: email }, sentAt + 1000).at(-1)!;
    const token = oldest.link!.split('#token=')[1];
    await expect(verification.verifyEmail(token, password)).rejects.toThrow('tidak berlaku');
    // Only time made it invalid: one second after sending it was still good.
    expect((await verification.verifyEmail(token, password, sentAt + 1000)).emailVerified).toBe(
      true,
    );
  });

  it('mails an address at most once per minute, without telling the requester', async () => {
    const email = 'repeat@test.local';
    const first = await post('/register').send({ email, password });
    const second = await post('/register').send({ email, password });
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    await settle();
    expect(await mailsFor(email)).toHaveLength(1);
    // After the cooldown a new registration leads to a new link again.
    const later = await users.register({ email, password }, Date.now() + 61_000);
    expect(later.mail).toBe('verification');
    expect((await users.register({ email, password }, Date.now() + 62_000)).mail).toBe('none');
  });

  it('stops mailing an address after ten mails of one kind in a day', async () => {
    const { reserveMail } = await import('../src/mailer.ts');
    const address = 'flooded@test.local';
    const start = Date.now();
    // One per minute is allowed, until the daily limit is reached.
    for (let i = 0; i < 10; i++)
      expect(reserveMail('password-reset', address, start + i * 61_000)).toBe(true);
    expect(reserveMail('password-reset', address, start + 11 * 61_000)).toBe(false);
    expect(reserveMail('password-reset', address, start + 23 * 3_600_000)).toBe(false);
    // The limit is per kind and per address, and lifts a day after the first mail.
    expect(reserveMail('verification', address, start + 11 * 61_000)).toBe(true);
    expect(reserveMail('password-reset', 'other@test.local', start + 11 * 61_000)).toBe(true);
    expect(reserveMail('password-reset', address, start + 24 * 3_600_000 + 1)).toBe(true);
  });

  it('keeps legacy accounts out until they prove their mailbox, and the seeded admin trusted', async () => {
    const { database } = await import('../src/database.ts');
    const legacy = {
      id: randomUUID(),
      email: 'legacy@test.local',
      role: 'user',
      passwordHash: await bcrypt.hash(password, 10),
    };
    database.store('users_email').set(legacy.email, legacy);
    database.store('users_id').set(legacy.id, legacy);
    // Written before verification existed: no sign-in until the address is confirmed.
    expect((await post('/login').send({ email: legacy.email, password })).status).toBe(401);
    // Registering the address again must not replace a real account's password...
    await post('/register').send({ email: legacy.email, password: 'somebody-elses-password' });
    const token = await mailedToken(legacy.email);
    expect(
      (await post('/verify-email').send({ token, password: 'somebody-elses-password' })).status,
    ).toBe(401);
    // ...it only mails the owner a link, who confirms with the password they always had.
    const verified = await post('/verify-email').send({ token, password });
    expect(verified.body.user).toMatchObject({ id: legacy.id, emailVerified: true });
    expect((await post('/login').send({ email: legacy.email, password })).status).toBe(200);
    // Never deleted by the cleanup of abandoned registrations.
    users.purgeExpiredPending(Date.now() + 48 * 3_600_000);
    expect(users.getUserById(legacy.id)).not.toBeNull();
    expect(claims(adminToken).email_verified).toBe(true);
  });

  it('ends a session whose account is no longer verified at the next refresh', async () => {
    const { database } = await import('../src/database.ts');
    const { startSession } = await import('../src/sessions.ts');
    const stale = { id: randomUUID(), email: 'stale@test.local', role: 'user', passwordHash: 'x' };
    database.store('users_email').set(stale.email, stale);
    database.store('users_id').set(stale.id, stale);
    // A session from before the rule existed.
    const session = startSession(stale.id);
    const refreshed = await post('/refresh')
      .set({ origin: 'http://localhost:3000', 'x-requested-with': 'fetch' })
      .set('cookie', `refresh_token=${session.token}`);
    expect(refreshed.status).toBe(401);
    expect(refreshed.body.error.code).toBe('INVALID_SESSION');
  });
});
