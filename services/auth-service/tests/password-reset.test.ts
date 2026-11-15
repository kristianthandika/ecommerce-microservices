import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { cookieOf, mailedToken, mailsFor, nextIp, settle, signUp } from './helpers.ts';

/** Password reset by mailed link (training transport). */
const keysDir = mkdtempSync(join(tmpdir(), 'auth-reset-'));
process.env.KEYS_DIR = keysDir;
process.env.LOG_LEVEL = 'silent';

let app: import('express').Express;
let reset: typeof import('../src/password-reset.ts');
const password = 'correct-horse-battery';
const newPassword = 'a-brand-new-password';
const browser = { origin: 'http://localhost:3000', 'x-requested-with': 'fetch' };
const post = (path: string) => request(app).post(path).set('x-forwarded-for', nextIp());
const resetLinks = async (email: string) =>
  (await mailsFor(email)).filter((mail) => mail.link?.includes('/reset-password#token='));

beforeAll(async () => {
  app = (await import('../src/app.ts')).createApp();
  reset = await import('../src/password-reset.ts');
});
afterAll(() => rmSync(keysDir, { recursive: true, force: true }));

describe('password reset', () => {
  it('answers every address the same way and mails only the ones with an account', async () => {
    const email = 'forgot@test.local';
    await signUp(app, email, password);
    const known = await post('/password-reset').send({ email: ' Forgot@Test.Local ' });
    const unknown = await post('/password-reset').send({ email: 'nobody@test.local' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
    expect(known.body).toEqual({ status: 'accepted' });
    expect(known.headers['cache-control']).toBe('no-store');
    await settle();

    const links = await resetLinks(email);
    expect(links).toHaveLength(1);
    expect(links[0].link).toMatch(
      /^http:\/\/localhost:3000\/reset-password#token=[A-Za-z0-9_-]{43}$/,
    );
    expect(await mailsFor('nobody@test.local')).toHaveLength(0);
    // A second request within a minute sends nothing more, and says nothing about it.
    expect((await post('/password-reset').send({ email })).status).toBe(202);
    await settle();
    expect(await resetLinks(email)).toHaveLength(1);
    expect((await post('/password-reset').send({ email: 'not-an-email' })).status).toBe(400);
  });

  it('sets the new password once, ends every session and forgets known devices', async () => {
    const email = 'compromised@test.local';
    await signUp(app, email, password);
    // Two sessions exist, one of them perhaps an attacker's.
    const first = await post('/login').send({ email, password });
    const second = await post('/login').send({ email, password });
    const oldDevice = cookieOf(second, 'device_id')!.value;
    const refreshOf = (res: request.Response) => cookieOf(res, 'refresh_token')!.value;

    await post('/password-reset').send({ email });
    const token = await mailedToken(email, 'reset-password');
    expect((await post('/password-reset/confirm').send({ token, password: 'short' })).status).toBe(
      400,
    );
    const confirmed = await post('/password-reset/confirm').send({ token, password: newPassword });
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers['cache-control']).toBe('no-store');
    expect(confirmed.body.user).toMatchObject({ email, emailVerified: true });
    expect(confirmed.body).not.toHaveProperty('token'); // the user signs in afterwards

    // Access tokens and refresh tokens of both earlier sessions are refused.
    for (const session of [first, second]) {
      const me = await request(app).get('/me').set('authorization', `Bearer ${session.body.token}`);
      expect(me.status).toBe(401);
      expect(me.body.error.code).toBe('SESSION_REVOKED');
      const refreshed = await post('/refresh')
        .set(browser)
        .set('cookie', `refresh_token=${refreshOf(session)}`);
      expect(refreshed.status).toBe(401);
    }
    expect((await post('/login').send({ email, password })).status).toBe(401);
    expect((await post('/login').send({ email, password: newPassword })).status).toBe(200);

    // The link works once.
    const again = await post('/password-reset/confirm').send({
      token,
      password: 'another-password-9',
    });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_RESET_TOKEN');

    // Devices from before the reset are no longer trusted; the browser that reset is.
    for (let i = 0; i < 5; i++) await post('/login').send({ email, password: 'wrong-password' });
    const locked = (device: string) =>
      post('/login').set('cookie', `device_id=${device}`).send({ email, password: newPassword });
    expect((await locked(oldDevice)).status).toBe(429);
    expect((await locked(cookieOf(confirmed, 'device_id')!.value)).status).toBe(200);
  });

  it('rejects expired and malformed tokens', async () => {
    const email = 'slow@test.local';
    await signUp(app, email, password);
    const sentAt = Date.now() - 61 * 60_000;
    expect(await reset.requestPasswordReset(email, sentAt)).toBe(true);
    const { listOutbox } = await import('../src/mailer.ts');
    const token = listOutbox({ to: email }, sentAt + 1000)
      .find((mail) => mail.link?.includes('/reset-password#'))!
      .link!.split('#token=')[1];
    await expect(reset.confirmPasswordReset(token, newPassword)).rejects.toThrow('tidak berlaku');
    expect((await post('/login').send({ email, password })).status).toBe(200);
    // Only time made it invalid.
    expect((await reset.confirmPasswordReset(token, newPassword, sentAt + 1000)).email).toBe(email);
    for (const bad of ['short', 'x'.repeat(43), '../../etc/passwd'])
      expect(
        (await post('/password-reset/confirm').send({ token: bad, password: newPassword })).status,
      ).toBe(400);
  });

  it('hands an address back to its owner when somebody else registered it', async () => {
    const email = 'mine@test.local';
    // Registered by a stranger, never verified.
    await post('/register').send({ email, password: 'strangers-password-1' });
    // The owner of the mailbox asks for a reset link and chooses a password.
    await post('/password-reset').send({ email });
    const token = await mailedToken(email, 'reset-password');
    const confirmed = await post('/password-reset/confirm').send({ token, password: newPassword });
    expect(confirmed.body.user.emailVerified).toBe(true);
    expect((await post('/login').send({ email, password: newPassword })).status).toBe(200);
    expect((await post('/login').send({ email, password: 'strangers-password-1' })).status).toBe(
      401,
    );
    // The stranger's activation link died with the reset.
    const stale = await post('/verify-email').send({
      token: await mailedToken(email),
      password: 'strangers-password-1',
    });
    expect(stale.status).toBe(400);
  });
});
