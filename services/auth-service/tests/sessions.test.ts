import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { cookieOf, nextIp, signUp } from './helpers.ts';

const keysDir = mkdtempSync(join(tmpdir(), 'auth-sessions-'));
process.env.KEYS_DIR = keysDir;
process.env.LOG_LEVEL = 'silent';
const SERVICE_TOKEN = 'test-service-token-with-at-least-32-characters';
process.env.INTERNAL_SERVICE_TOKEN = SERVICE_TOKEN;

let app: import('express').Express;
let sessions: typeof import('../src/sessions.ts');
const password = 'correct-horse-battery';
const browser = { origin: 'http://localhost:3000', 'x-requested-with': 'fetch' };

beforeAll(async () => {
  app = (await import('../src/app.ts')).createApp();
  sessions = await import('../src/sessions.ts');
});
afterAll(() => rmSync(keysDir, { recursive: true, force: true }));

/** The refresh cookie value from a Set-Cookie header, plus its attributes. */
const refreshCookie = (res: request.Response) => cookieOf(res, 'refresh_token');
async function signIn(email: string) {
  const clientIp = nextIp();
  await signUp(app, email, password, clientIp);
  const res = await request(app)
    .post('/login')
    .set('x-forwarded-for', clientIp)
    .send({ email, password });
  expect(res.status).toBe(200);
  return { res, cookie: refreshCookie(res)! };
}
const refresh = (value: string, headers: Record<string, string> = browser) =>
  request(app).post('/refresh').set(headers).set('cookie', `refresh_token=${value}`);

describe('access and refresh tokens', () => {
  it('issues a 15-minute access token and a locked-down refresh cookie', async () => {
    const { res, cookie } = await signIn('ttl@test.local');
    const claims = jwt.decode(res.body.token) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(900);
    expect(res.body.expiresIn).toBe(900);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(cookie.header).toMatch(/HttpOnly/);
    expect(cookie.header).toMatch(/Secure/);
    expect(cookie.header).toMatch(/SameSite=Strict/);
    expect(cookie.header).toMatch(/Path=\/api\/v1\/auth;/);
    // The refresh token itself never appears in the JSON body.
    expect(JSON.stringify(res.body)).not.toContain(cookie.value);
  });

  it('rotates on every refresh and returns the current user and role', async () => {
    const { cookie } = await signIn('rotate@test.local');
    const first = await refresh(cookie.value);
    expect(first.status).toBe(200);
    expect(first.body.user.email).toBe('rotate@test.local');
    const next = refreshCookie(first)!;
    expect(next.value).not.toBe(cookie.value);
    expect((await refresh(next.value)).status).toBe(200);
  });

  it('treats a concurrent refresh in another tab as a race, not as theft', async () => {
    const { cookie } = await signIn('tabs@test.local');
    const results = await Promise.all([refresh(cookie.value), refresh(cookie.value)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!;
    // The session survives: the newly issued token still works.
    expect((await refresh(refreshCookie(winner)!.value)).status).toBe(200);
  });

  it('revokes the whole session when an old refresh token is replayed later', () => {
    const start = sessions.startSession('victim', 1_000_000);
    const rotated = sessions.rotateSession(start.token, 1_000_000);
    expect(rotated.kind).toBe('rotated');
    const stolenReplay = sessions.rotateSession(start.token, 1_000_000 + 60_000);
    expect(stolenReplay.kind).toBe('reused');
    // The legitimate user's newer token is revoked as well — attacker and victim
    // both have to sign in again, which ends the attacker's access.
    expect(() =>
      sessions.rotateSession((rotated as { token: string }).token, 1_000_000 + 61_000),
    ).toThrow('Sesi berakhir');
  });

  it('logout revokes the session and clears the cookie', async () => {
    const { cookie } = await signIn('logout@test.local');
    const res = await request(app)
      .post('/logout')
      .set(browser)
      .set('cookie', `refresh_token=${cookie.value}`);
    expect(res.status).toBe(204);
    expect(refreshCookie(res)?.header).toMatch(/Expires=Thu, 01 Jan 1970/);
    const after = await refresh(cookie.value);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('INVALID_REFRESH');
  });

  it('stops accepting the access token of a session that logged out', async () => {
    const { res, cookie } = await signIn('revoke@test.local');
    const { sid } = jwt.decode(res.body.token) as { sid: string };
    expect(sid).toEqual(expect.any(String));
    const me = () => request(app).get('/me').set('authorization', `Bearer ${res.body.token}`);
    expect((await me()).status).toBe(200);
    // A second session of the same user is untouched by the first one's logout.
    const other = await request(app).post('/login').send({ email: 'revoke@test.local', password });
    await request(app).post('/logout').set(browser).set('cookie', `refresh_token=${cookie.value}`);
    const refused = await me();
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('SESSION_REVOKED');
    expect(
      (await request(app).get('/me').set('authorization', `Bearer ${other.body.token}`)).status,
    ).toBe(200);

    // What other services poll: service token required, entry lives past token expiry.
    expect((await request(app).get('/internal/revocations')).status).toBe(401);
    const list = await request(app)
      .get('/internal/revocations')
      .set('x-service-token', SERVICE_TOKEN);
    expect(list.status).toBe(200);
    const entry = list.body.revoked.find((item: { sid: string }) => item.sid === sid);
    expect(entry.until).toBeGreaterThan(Date.now() + 900_000);
    expect(sessions.listRevokedSessions(entry.until + 1)).not.toContainEqual(entry);
  });

  it('revokes access tokens too when a stolen refresh token is detected', () => {
    const start = sessions.startSession('victim-2', 2_000_000);
    sessions.rotateSession(start.token, 2_000_000);
    expect(sessions.isSessionRevoked(start.familyId, 2_000_000)).toBe(false);
    expect(sessions.rotateSession(start.token, 2_000_000 + 60_000).kind).toBe('reused');
    expect(sessions.isSessionRevoked(start.familyId, 2_000_000 + 60_001)).toBe(true);
    // The newest access token was issued at 2,000,000 and lives 15 minutes: the entry
    // stays until then (plus one minute for clock differences) and not longer.
    expect(sessions.isSessionRevoked(start.familyId, 2_000_000 + 959_000)).toBe(true);
    expect(sessions.isSessionRevoked(start.familyId, 2_000_000 + 961_000)).toBe(false);
  });

  it('revokes a signed access token even when its refresh cookie is missing', async () => {
    const { res, cookie } = await signIn('missing-cookie@test.local');
    const result = await request(app)
      .post('/logout')
      .set(browser)
      .set('authorization', `Bearer ${res.body.token}`);
    expect(result.status).toBe(204);
    const denied = await request(app).get('/me').set('authorization', `Bearer ${res.body.token}`);
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe('SESSION_REVOKED');
    expect((await refresh(cookie.value)).status).toBe(401);
  });

  it('cannot revoke another session by forging the bearer payload', async () => {
    const { res } = await signIn('forged-logout@test.local');
    const [header, , signature] = res.body.token.split('.');
    const payload = jwt.decode(res.body.token) as jwt.JwtPayload;
    const forged = `${header}.${Buffer.from(JSON.stringify({ ...payload, sub: 'forged' })).toString('base64url')}.${signature}`;
    expect(
      (await request(app).post('/logout').set(browser).set('authorization', `Bearer ${forged}`))
        .status,
    ).toBe(204);
    expect(
      (await request(app).get('/me').set('authorization', `Bearer ${res.body.token}`)).status,
    ).toBe(200);
  });

  it('still revokes a valid cookie when the bearer is invalid or expired', async () => {
    const { getKeyMaterial } = await import('../src/keys.ts');
    const { config } = await import('../src/config.ts');
    const { privateKeyPem } = getKeyMaterial();
    for (const kind of ['invalid', 'expired']) {
      const { res, cookie } = await signIn(`${kind}-bearer@test.local`);
      const claims = jwt.decode(res.body.token) as jwt.JwtPayload;
      const bearer =
        kind === 'invalid'
          ? 'malformed'
          : jwt.sign({ sid: claims.sid }, privateKeyPem, {
              algorithm: 'RS256',
              subject: claims.sub,
              issuer: config.jwt.issuer,
              audience: 'ecommerce-api',
              expiresIn: -1,
            });
      expect(
        (
          await request(app)
            .post('/logout')
            .set(browser)
            .set('authorization', `Bearer ${bearer}`)
            .set('cookie', `refresh_token=${cookie.value}`)
        ).status,
      ).toBe(204);
      expect((await refresh(cookie.value)).status).toBe(401);
      expect(
        (await request(app).get('/me').set('authorization', `Bearer ${res.body.token}`)).status,
      ).toBe(401);
    }
  });

  it('never issues an access token that outlives the remaining refresh session', async () => {
    const { res } = await signIn('absolute-expiry@test.local');
    const { accessTokenFor } = await import('../src/users.ts');
    const { sid } = jwt.decode(res.body.token) as { sid: string };
    const deadline = Date.now() + 25_500;
    const access = accessTokenFor(res.body.user.id, sid, deadline);
    const claims = jwt.decode(access.token) as { iat: number; exp: number };
    expect(claims.exp).toBe(Math.floor(deadline / 1000));
    expect(access.expiresIn).toBe(claims.exp - claims.iat);
    expect(access.expiresIn).toBeLessThanOrEqual(26);
    expect(() => accessTokenFor(res.body.user.id, sid, Date.now() - 1000)).toThrow(
      'Sesi tidak berlaku',
    );
  });

  it('retains bearer revocations even when the expired family record was swept', async () => {
    const { res } = await signIn('swept-family@test.local');
    const { database } = await import('../src/database.ts');
    const { sid } = jwt.decode(res.body.token) as { sid: string };
    database.store('refresh_families').delete(sid);
    expect(
      (
        await request(app)
          .post('/logout')
          .set(browser)
          .set('authorization', `Bearer ${res.body.token}`)
      ).status,
    ).toBe(204);
    expect(
      (await request(app).get('/me').set('authorization', `Bearer ${res.body.token}`)).status,
    ).toBe(401);
    expect(sessions.isSessionRevoked(sid)).toBe(true);
  });

  it('rejects cross-site refresh attempts (CSRF) and requests without a cookie', async () => {
    const { cookie } = await signIn('csrf@test.local');
    const noHeader = await refresh(cookie.value, { origin: 'http://localhost:3000' });
    expect(noHeader.status).toBe(403);
    const foreign = await refresh(cookie.value, {
      origin: 'https://evil.example',
      'x-requested-with': 'fetch',
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('CSRF_REJECTED');
    // Non-browser clients send no Origin and are allowed with the custom header.
    expect((await refresh(cookie.value, { 'x-requested-with': 'cli' })).status).toBe(200);
    expect((await request(app).post('/refresh').set(browser)).status).toBe(401);
  });
});

describe('revocation list stays short', () => {
  it('publishes no entry for a session whose access token has already expired', () => {
    const idle = sessions.startSession('idle-user', 3_000_000);
    // Logged out 20 minutes later: the 15-minute access token is long gone.
    sessions.endSession(idle.token, 3_000_000 + 20 * 60_000);
    expect(sessions.isSessionRevoked(idle.familyId, 3_000_000 + 20 * 60_000 + 1)).toBe(false);
    expect(() => sessions.rotateSession(idle.token, 3_000_000 + 20 * 60_000 + 2)).toThrow(
      'Sesi berakhir',
    );
  });

  it('ends every session of an account at once, listing only the ones still usable', () => {
    const now = 4_000_000;
    const old = sessions.startSession('many-sessions', now);
    const recent = sessions.startSession('many-sessions', now + 30 * 60_000);
    const other = sessions.startSession('somebody-else', now + 30 * 60_000);
    const ended = sessions.endAllSessions('many-sessions', 'password-reset', now + 31 * 60_000);
    expect(ended).toBe(2);
    const at = now + 31 * 60_000 + 1;
    expect(sessions.isSessionRevoked(recent.familyId, at)).toBe(true);
    expect(sessions.isSessionRevoked(old.familyId, at)).toBe(false); // token expired long ago
    expect(sessions.isSessionRevoked(other.familyId, at)).toBe(false);
    for (const session of [old, recent])
      expect(() => sessions.rotateSession(session.token, at)).toThrow('Sesi berakhir');
    expect(sessions.rotateSession(other.token, at).kind).toBe('rotated');
  });
});

describe('device cookies keep a known browser out of an attacker-made lockout', () => {
  const deviceCookie = (res: request.Response) => cookieOf(res, 'device_id');
  const attempt = (email: string, pass: string, device?: string) => {
    const req = request(app).post('/login').set('x-forwarded-for', nextIp());
    return (device ? req.set('cookie', `device_id=${device}`) : req).send({
      email,
      password: pass,
    });
  };

  it('marks the browser on a successful login with a locked-down cookie', async () => {
    const { res } = await signIn('device-attrs@test.local');
    const cookie = deviceCookie(res)!;
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.header).toMatch(/HttpOnly/);
    expect(cookie.header).toMatch(/Secure/);
    expect(cookie.header).toMatch(/SameSite=Strict/);
    expect(cookie.header).toMatch(/Path=\/api\/v1\/auth;/);
    expect(JSON.stringify(res.body)).not.toContain(cookie.value);
  });

  it('lets the owner sign in from a known browser while the email is locked for everyone else', async () => {
    const email = 'device-victim@test.local';
    const { res } = await signIn(email);
    const device = deviceCookie(res)!.value;
    // An attacker sends wrong passwords until the per-email backoff engages.
    for (let i = 0; i < 5; i++) expect((await attempt(email, 'wrong-password')).status).toBe(401);
    const stranger = await attempt(email, password);
    expect(stranger.status).toBe(429);
    expect(stranger.body.error.code).toBe('LOGIN_THROTTLED');
    // The owner, in the browser they used before, is not affected.
    const owner = await attempt(email, password, device);
    expect(owner.status).toBe(200);
    // Their login does not lift the lock for clients without the cookie.
    expect((await attempt(email, password)).status).toBe(429);
    // The cookie is replaced on every successful login.
    expect(deviceCookie(owner)!.value).not.toBe(device);
    expect((await attempt(email, password, deviceCookie(owner)!.value)).status).toBe(200);
  });

  it('gives a stolen cookie only a few guesses, and none for another account', async () => {
    const email = 'device-stolen@test.local';
    const other = 'device-other@test.local';
    const { res } = await signIn(email);
    const device = deviceCookie(res)!.value;
    await signIn(other);
    // Lock both accounts for clients without a cookie.
    for (const target of [email, other])
      for (let i = 0; i < 5; i++) await attempt(target, 'wrong-password');
    // The cookie belongs to one account; it does not unlock the other.
    expect((await attempt(other, password, device)).status).toBe(429);
    // Five wrong passwords use the cookie up...
    for (let i = 0; i < 5; i++)
      expect((await attempt(email, 'wrong-password', device)).status).toBe(401);
    // ...after which it is an ordinary, locked-out client again.
    expect((await attempt(email, password, device)).status).toBe(429);
  });

  it('ignores malformed or unknown cookies', async () => {
    const email = 'device-unknown@test.local';
    await signIn(email);
    for (let i = 0; i < 5; i++) await attempt(email, 'wrong-password');
    for (const forged of ['x', 'a'.repeat(43), '../../etc/passwd'])
      expect((await attempt(email, password, forged)).status).toBe(429);
  });
});

describe('per-account login throttling', () => {
  // Each test uses its own client IP so the per-IP limiter (20/min) cannot be
  // mistaken for the per-account backoff under test.
  let ip = '';
  let seq = 0;
  beforeEach(() => {
    ip = `198.51.100.${++seq}`;
  });
  const login = () => request(app).post('/login').set('x-forwarded-for', ip);
  it('backs off after five failures, even for the right password, then recovers', async () => {
    const email = 'throttle@test.local';
    await signUp(app, email, password);
    for (let i = 0; i < 5; i++)
      expect((await login().send({ email, password: 'wrong-password' })).status).toBe(401);
    const locked = await login().send({ email, password });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('LOGIN_THROTTLED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(25);
    // Another account is not affected.
    await signUp(app, 'other@test.local', password);
    expect((await login().send({ email: 'other@test.local', password })).status).toBe(200);
  });

  it('answers unknown emails exactly like known ones, so throttling reveals nothing', async () => {
    const email = 'nobody@test.local';
    for (let i = 0; i < 5; i++) expect((await login().send({ email, password })).status).toBe(401);
    const locked = await login().send({ email, password });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('LOGIN_THROTTLED');
  });

  it('doubles the delay per further failure up to 15 minutes and forgets after a quiet window', () => {
    const email = 'backoff@test.local';
    let now = 5_000_000;
    for (let i = 0; i < 5; i++) sessions.recordLoginFailure(email, now);
    expect(() => sessions.assertLoginAllowed(email, now + 29_000)).toThrow();
    expect(() => sessions.assertLoginAllowed(email, now + 31_000)).not.toThrow();
    sessions.recordLoginFailure(email, (now += 31_000)); // 6th → 60 s
    expect(() => sessions.assertLoginAllowed(email, now + 59_000)).toThrow();
    for (let i = 0; i < 10; i++) sessions.recordLoginFailure(email, (now += 1000));
    expect(() => sessions.assertLoginAllowed(email, now + 14 * 60_000)).toThrow();
    expect(() => sessions.assertLoginAllowed(email, now + 15 * 60_000 + 1)).not.toThrow();
    // A failure after a quiet window starts counting from one again.
    sessions.recordLoginFailure(email, now + 60 * 60_000);
    expect(() => sessions.assertLoginAllowed(email, now + 60 * 60_000 + 1)).not.toThrow();
  });
});
