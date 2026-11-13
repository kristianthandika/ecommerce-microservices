import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const keysDir = mkdtempSync(join(tmpdir(), 'auth-sessions-'));
process.env.KEYS_DIR = keysDir;
process.env.LOG_LEVEL = 'silent';

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
function refreshCookie(res: request.Response) {
  const header = ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .find((cookie) => cookie.startsWith('refresh_token='));
  return header ? { value: header.split(';')[0].split('=')[1], header } : undefined;
}
async function signIn(email: string) {
  await request(app).post('/register').send({ email, password });
  const res = await request(app).post('/login').send({ email, password });
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
    expect(cookie.header).toMatch(/Path=\/api\/auth/);
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
    await request(app).post('/register').set('x-forwarded-for', ip).send({ email, password });
    for (let i = 0; i < 5; i++)
      expect((await login().send({ email, password: 'wrong-password' })).status).toBe(401);
    const locked = await login().send({ email, password });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('LOGIN_THROTTLED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(25);
    // Another account is not affected.
    await request(app)
      .post('/register')
      .set('x-forwarded-for', ip)
      .send({ email: 'other@test.local', password });
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
