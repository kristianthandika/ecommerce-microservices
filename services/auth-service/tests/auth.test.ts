import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { mailedToken, mailsFor, nextIp, settle, signUp } from './helpers.ts';

// Set KEYS_DIR ke folder sementara SEBELUM modul di-import (config membacanya).
const keysDir = mkdtempSync(join(tmpdir(), 'auth-keys-'));
process.env.KEYS_DIR = keysDir;
process.env.LOG_LEVEL = 'silent';

let app: import('express').Express;
let keys: typeof import('../src/keys.ts');
let users: typeof import('../src/users.ts');
const post = (path: string) => request(app).post(path).set('x-forwarded-for', nextIp());

beforeAll(async () => {
  app = (await import('../src/app.ts')).createApp();
  keys = await import('../src/keys.ts');
  users = await import('../src/users.ts');
});

afterAll(() => {
  rmSync(keysDir, { recursive: true, force: true });
});

describe('auth-service end-to-end', () => {
  const creds = { email: 'user@test.local', password: 'password123' };
  const accepted = { status: 'accepted', verificationRequired: true };

  it('register → 202 dengan jawaban generik, tanpa data akun', async () => {
    const res = await post('/register').send(creds);
    expect(res.status).toBe(202);
    expect(res.body).toEqual(accepted);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('akun belum bisa dipakai masuk sebelum email diverifikasi (jawaban = password salah)', async () => {
    const res = await post('/login').send(creds);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('body tidak valid → 400 dengan detail field (bukan 500)', async () => {
    const res = await post('/register').send({ email: 'bukan-email', password: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('verifikasi (tautan + password) → login → akses route terproteksi berhasil', async () => {
    const verified = await post('/verify-email').send({
      token: await mailedToken(creds.email),
      password: creds.password,
    });
    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({ email: creds.email, emailVerified: true });
    expect(verified.body.user).not.toHaveProperty('passwordHash');

    const login = await post('/login').send(creds);
    expect(login.status).toBe(200);
    const { token } = login.body;
    expect(token).toBeTruthy();

    const me = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(creds.email);
  });

  it('token invalid ditolak (401)', async () => {
    const res = await request(app).get('/me').set('Authorization', 'Bearer token.palsu.xxx');
    expect(res.status).toBe(401);
  });

  it('JWKS mengembalikan JWK ber-kid yang benar-benar bisa memverifikasi token', async () => {
    const login = await post('/login').send(creds);
    const { token } = login.body;

    const jwks = await request(app).get('/.well-known/jwks.json');
    expect(jwks.status).toBe(200);
    const jwk = jwks.body.keys[0];
    expect(jwk).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256' });
    expect(jwk.kid).toBeTruthy();

    // kid di header token HARUS cocok dengan kid di JWKS.
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.kid).toBe(jwk.kid);

    // Bangun public key dari JWK endpoint, verifikasi token → membuktikan
    // service lain bisa memakainya (bukan cuma cek endpoint 200).
    const pubKey = createPublicKey({ key: jwk, format: 'jwk' });
    const decoded = jwt.verify(token, pubKey, {
      algorithms: ['RS256'],
      issuer: 'auth-service',
      audience: 'ecommerce-api',
    }) as jwt.JwtPayload;
    expect(decoded.email).toBe(creds.email);
    expect(decoded.email_verified).toBe(true);
  });

  it('load keypair yang sudah ada TIDAK generate ulang (kid stabil lintas restart)', async () => {
    const { kid: kid1 } = keys.getKeyMaterial();
    keys._resetKeyCache(); // simulasikan restart proses
    const { kid: kid2 } = keys.getKeyMaterial();
    expect(kid2).toBe(kid1);
    expect(existsSync(join(keysDir, 'private.pem'))).toBe(true);
    expect(existsSync(join(keysDir, 'public.pem'))).toBe(true);
  });
});

describe('registration reveals nothing and cannot occupy an address', () => {
  const password = 'correct-horse-battery';

  it('answers a taken address exactly like a new one; only the owner is told by mail', async () => {
    const email = 'owner@test.local';
    await signUp(app, email, password);
    const fresh = await post('/register').send({ email: 'fresh@test.local', password });
    const taken = await post('/register').send({ email, password: 'attacker-password-1' });
    expect(taken.status).toBe(fresh.status);
    expect(taken.body).toEqual(fresh.body);
    await settle();

    // Nothing about the account changed: the owner's password still works, the other does not.
    expect((await post('/login').send({ email, password })).status).toBe(200);
    expect((await post('/login').send({ email, password: 'attacker-password-1' })).status).toBe(
      401,
    );
    // The owner hears about it; no new activation link exists for the attempt.
    const mails = await mailsFor(email);
    expect(mails.filter((mail) => mail.subject.includes('Percobaan pendaftaran'))).toHaveLength(1);
    expect(mails.filter((mail) => mail.link?.includes('/verify-email#'))).toHaveLength(1);
  });

  it('lets the next registration replace the password of an unverified account', async () => {
    const email = 'squatted@test.local';
    // Somebody registers an address they do not own...
    await post('/register').send({ email, password: 'squatter-password-1' });
    const link = await mailedToken(email);
    const squatter = users.findAccountByEmail(email);
    // ...and later its owner registers. Same pending account, new password.
    expect((await post('/register').send({ email, password })).status).toBe(202);
    expect(users.findAccountByEmail(email)).toEqual(squatter);

    const withOldPassword = await post('/verify-email').send({
      token: link,
      password: 'squatter-password-1',
    });
    expect(withOldPassword.status).toBe(401);
    expect((await post('/verify-email').send({ token: link, password })).status).toBe(200);
    expect((await post('/login').send({ email, password: 'squatter-password-1' })).status).toBe(
      401,
    );
    expect((await post('/login').send({ email, password })).status).toBe(200);
  });

  it('needs the password as well as the link, so a mailbox owner cannot activate a foreign registration', async () => {
    const email = 'victim@test.local';
    await post('/register').send({ email, password: 'attacker-chose-this-1' });
    const token = await mailedToken(email);
    // The victim opens the link but does not know the attacker's password.
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await post('/verify-email').send({ token, password: `victim-guess-${attempt}` });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    // After five wrong passwords the link is void, even with the right one.
    const burnt = await post('/verify-email').send({ token, password: 'attacker-chose-this-1' });
    expect(burnt.status).toBe(400);
    expect(burnt.body.error.code).toBe('INVALID_VERIFICATION_TOKEN');
    expect((await post('/login').send({ email, password: 'attacker-chose-this-1' })).status).toBe(
      401,
    );
  });

  it('deletes accounts that were never verified once their time is up', async () => {
    const email = 'abandoned@test.local';
    await post('/register').send({ email, password });
    const kept = await signUp(app, 'kept@test.local', password);
    expect(users.findAccountByEmail(email)).not.toBeNull();

    expect(users.purgeExpiredPending(Date.now() + 23 * 3_600_000).deleted).toBe(0);
    const swept = users.purgeExpiredPending(Date.now() + 25 * 3_600_000);
    expect(swept.deleted).toBeGreaterThanOrEqual(1);
    expect(users.findAccountByEmail(email)).toBeNull();
    // Verified accounts are never part of this.
    expect(users.getUserById(kept.id)).toMatchObject({ email: 'kept@test.local' });
  });
});

describe('audit regressions', () => {
  it('normalizes email and keeps one account when registrations race', async () => {
    const email = `race-${Date.now()}@test.local`;
    const results = await Promise.all([
      post('/register').send({ email: email.toUpperCase(), password: 'password111' }),
      post('/register').send({ email, password: 'password222' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([202, 202]);
    const account = users.findAccountByEmail(email);
    expect(account).not.toBeNull();
    // A later registration still addresses that same single account.
    await post('/register').send({ email: ` ${email} `, password: 'password333' });
    expect(users.findAccountByEmail(email)).toEqual(account);
    const verified = await post('/verify-email').send({
      token: await mailedToken(email),
      password: 'password333',
    });
    expect(verified.body.user.id).toBe(account!.id);
  });
  it('rejects passwords exceeding 72 UTF-8 bytes, including multibyte characters', async () => {
    for (const password of ['a'.repeat(73), 'é'.repeat(37)]) {
      const result = await post('/register').send({ email: 'long@test.local', password });
      expect(result.status).toBe(400);
    }
  });
  it('maps malformed JSON to 400 and oversized payloads to 413', async () => {
    expect((await post('/login').set('content-type', 'application/json').send('{')).status).toBe(
      400,
    );
    expect((await post('/login').send({ value: 'a'.repeat(110000) })).status).toBe(413);
  });
  it('health polling never consumes business API rate limits', async () => {
    for (let i = 0; i < 305; i++) expect((await request(app).get('/health')).status).toBe(200);
  });
});
