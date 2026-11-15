import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { AppError } from './middleware/errors.ts';
import { validate } from './middleware/validate.ts';
import { requireAuth } from './middleware/require-auth.ts';
import { requireAdmin } from './middleware/require-role.ts';
import { requireServiceToken } from './middleware/service-token.ts';
import { getKeyMaterial } from './keys.ts';
import { register, login, getUserById, accessTokenFor } from './users.ts';
import { config } from './config.ts';
import {
  credentialsSchema,
  verifyEmailSchema,
  passwordResetRequestSchema,
  passwordResetConfirmSchema,
  outboxQuerySchema,
} from './schemas.ts';
import {
  startSession,
  rotateSession,
  endSession,
  endAccessSession,
  endSessionForMissingUser,
  listRevokedSessions,
} from './sessions.ts';
import { sendVerification, sendAccountExistsNotice, verifyEmail } from './verification.ts';
import { requestPasswordReset, confirmPasswordReset } from './password-reset.ts';
import { issueDevice } from './devices.ts';
import { listOutbox } from './mailer.ts';

type Credentials = z.infer<typeof credentialsSchema>;

const cookieOptions = () => ({
  httpOnly: true, // tidak terbaca JavaScript → tidak bisa dicuri lewat XSS
  secure: config.refresh.cookieSecure,
  sameSite: 'strict' as const, // tidak pernah dikirim dari situs lain (CSRF)
  path: config.refresh.cookiePath, // hanya dikirim ke endpoint auth, bukan ke API lain
});

/** Value of one of our own cookies (opaque base64url tokens); anything else is ignored. */
function readCookie(req: Request, cookieName: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === cookieName) {
      const value = rest.join('=');
      return /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}
const readRefreshCookie = (req: Request) => readCookie(req, config.refresh.cookieName);
const readDeviceCookie = (req: Request) => readCookie(req, config.device.cookieName);

/**
 * Marks this browser as one the account signed in from (see devices.ts). Sent with
 * the same restrictions as the refresh cookie; it is not a credential.
 */
function sendDeviceCookie(req: Request, res: Response, userId: string): void {
  const device = issueDevice(userId, readDeviceCookie(req));
  res.cookie(config.device.cookieName, device.token, {
    ...cookieOptions(),
    maxAge: Math.max(0, device.expiresAt - Date.now()),
  });
}

/**
 * Runs mail work after the response was written. What is sent (or whether anything
 * is) depends on whether the address has an account, so the response must not wait
 * for it: its timing would give that away.
 */
function afterResponse(req: Request, what: string, work: () => Promise<unknown>): void {
  setImmediate(() => {
    work().catch((err: unknown) => req.log?.error({ err }, `${what} gagal dikirim`));
  });
}

function sendSession(
  res: Response,
  session: { token: string; expiresAt: number },
  body: { token: string; user: unknown; expiresIn: number },
): void {
  res.cookie(config.refresh.cookieName, session.token, {
    ...cookieOptions(),
    maxAge: Math.max(0, session.expiresAt - Date.now()),
  });
  // Token tidak boleh tersimpan di cache browser/proxy mana pun.
  res.set('Cache-Control', 'no-store');
  res.json(body);
}

/**
 * Pertahanan CSRF berlapis untuk endpoint yang memakai cookie: SameSite=Strict
 * (lapis 1), header kustom yang memaksa preflight CORS untuk origin lain (lapis 2),
 * dan Origin — bila dikirim browser — harus termasuk daftar yang diizinkan (lapis 3).
 */
function requireSameSiteRequest(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (!req.get('x-requested-with') || (origin && !config.refresh.allowedOrigins.includes(origin)))
    throw new AppError(403, 'Permintaan lintas situs ditolak', undefined, 'CSRF_REJECTED');
  next();
}

export function buildRouter(): Router {
  const router = Router();

  // Health check — dipakai gateway (m3.3) & Docker healthcheck (m4.4).
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'auth-service' });
  });

  // Endpoint JWKS standar — service lain mem-fetch public key dari sini.
  router.get('/.well-known/jwks.json', (_req: Request, res: Response) => {
    const { jwk } = getKeyMaterial();
    // Public key aman di-cache; konsumen tetap me-refresh sendiri saat menemui `kid` baru.
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ keys: [jwk] });
  });

  // Perhatikan: TIDAK ada try/catch — handler async yang throw/reject otomatis
  // diteruskan ke error handler oleh Express 5.
  //
  // Jawabannya SELALU sama, baik alamatnya baru, masih menunggu verifikasi, maupun
  // sudah punya akun: apa yang terjadi hanya diberitahukan lewat email ke alamat itu
  // (OWASP API2: pendaftaran tidak boleh bisa dipakai menebak siapa yang punya akun).
  router.post('/register', validate(credentialsSchema), async (req: Request, res: Response) => {
    const { user, mail } = await register(req.validated as Credentials);
    if (mail === 'verification')
      afterResponse(req, 'email verifikasi', () => sendVerification(user));
    if (mail === 'account-exists')
      afterResponse(req, 'pemberitahuan pendaftaran', () => sendAccountExistsNotice(user));
    res.set('Cache-Control', 'no-store');
    res.status(202).json({
      status: 'accepted',
      // Fakta konfigurasi, bukan fakta tentang alamat ini.
      verificationRequired: config.emailVerification.required,
    });
  });

  // Tautan di email membawa token di fragment URL; halaman frontend mengirimnya ke
  // sini BERSAMA password akun. Tautan saja tidak mengaktifkan apa pun.
  router.post('/verify-email', validate(verifyEmailSchema), async (req: Request, res: Response) => {
    const { token, password } = req.validated as { token: string; password: string };
    const user = await verifyEmail(token, password);
    // Pemilik kotak surat yang tahu password-nya: browser ini boleh masuk walau
    // email tersebut sedang ditahan backoff login.
    sendDeviceCookie(req, res, user.id);
    res.set('Cache-Control', 'no-store');
    res.json({ user });
  });

  // Lupa password: jawaban sama untuk alamat mana pun; tautan hanya dikirim bila ada akunnya.
  router.post(
    '/password-reset',
    validate(passwordResetRequestSchema),
    (req: Request, res: Response) => {
      const { email } = req.validated as { email: string };
      afterResponse(req, 'email atur ulang password', () => requestPasswordReset(email));
      res.set('Cache-Control', 'no-store');
      res.status(202).json({ status: 'accepted' });
    },
  );

  // Password baru dari tautan atur ulang. Semua sesi akun berakhir; pengguna masuk lagi.
  router.post(
    '/password-reset/confirm',
    validate(passwordResetConfirmSchema),
    async (req: Request, res: Response) => {
      const { token, password } = req.validated as { token: string; password: string };
      const user = await confirmPasswordReset(token, password);
      sendDeviceCookie(req, res, user.id);
      res.set('Cache-Control', 'no-store');
      res.json({ user });
    },
  );
  // Kotak surat pelatihan: hanya ada bila email TIDAK benar-benar dikirim keluar.
  if (config.mail.transport === 'outbox')
    router.get('/admin/outbox', requireAuth, requireAdmin, (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      res.json({ messages: listOutbox(outboxQuerySchema.parse(req.query)) });
    });

  // Internal (service-ke-service): daftar sesi yang dicabut. Diblokir di gateway dan
  // wajib service token.
  router.get('/internal/revocations', requireServiceToken, (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json({ revoked: listRevokedSessions() });
  });

  router.post('/login', validate(credentialsSchema), async (req: Request, res: Response) => {
    let user: Awaited<ReturnType<typeof login>>;
    try {
      user = await login(req.validated as Credentials, readDeviceCookie(req));
    } catch (err) {
      if (err instanceof AppError && err.code === 'LOGIN_THROTTLED')
        res.set(
          'Retry-After',
          String((err.details as { retryAfterSeconds: number }).retryAfterSeconds),
        );
      throw err;
    }
    const session = startSession(user.id);
    sendDeviceCookie(req, res, user.id);
    sendSession(res, session, accessTokenFor(user.id, session.familyId, session.expiresAt));
  });

  // Tukar refresh token (cookie HttpOnly) dengan access token baru + refresh token baru.
  router.post('/refresh', requireSameSiteRequest, (req: Request, res: Response) => {
    const presented = readRefreshCookie(req);
    try {
      if (!presented)
        throw new AppError(
          401,
          'Sesi berakhir. Silakan masuk kembali.',
          undefined,
          'INVALID_REFRESH',
        );
      const rotation = rotateSession(presented);
      if (rotation.kind === 'reused') {
        req.log?.warn({ userId: rotation.userId }, 'refresh token dipakai ulang — sesi dicabut');
        throw new AppError(
          401,
          'Sesi dicabut demi keamanan. Silakan masuk kembali.',
          undefined,
          'REFRESH_REUSED',
        );
      }
      let access: ReturnType<typeof accessTokenFor>;
      try {
        access = accessTokenFor(rotation.userId, rotation.familyId, rotation.expiresAt);
      } catch (err) {
        endSessionForMissingUser(rotation.token);
        throw err;
      }
      sendSession(res, rotation, access);
    } catch (err) {
      // Cookie yang tidak lagi berlaku dihapus; REFRESH_RACE tidak, cookie baru sudah terpasang.
      if (err instanceof AppError && err.status === 401)
        res.clearCookie(config.refresh.cookieName, cookieOptions());
      throw err;
    }
  });

  router.post('/logout', requireSameSiteRequest, (req: Request, res: Response) => {
    const presented = readRefreshCookie(req);
    if (presented) endSession(presented);
    // A cleared/expired refresh cookie must not leave the browser's access token
    // usable. Validate an optional bearer independently, preserving idempotent logout.
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme === 'Bearer' && token) {
      let claims: jwt.JwtPayload | undefined;
      try {
        const decoded = jwt.verify(token, getKeyMaterial().publicKeyPem, {
          algorithms: ['RS256'],
          issuer: config.jwt.issuer,
          audience: 'ecommerce-api',
        });
        if (typeof decoded !== 'string') claims = decoded;
      } catch {
        /* A bad bearer must not prevent revoking a valid refresh cookie. */
      }
      if (
        typeof claims?.sid === 'string' &&
        /^[A-Za-z0-9_-]{1,64}$/.test(claims.sid) &&
        typeof claims.sub === 'string' &&
        claims.sub &&
        typeof claims.exp === 'number'
      )
        endAccessSession(claims.sid, claims.exp);
    }
    res.clearCookie(config.refresh.cookieName, cookieOptions());
    res.status(204).end();
  });

  // Route terproteksi contoh — butuh token valid.
  router.get('/me', requireAuth, (req: Request, res: Response) => {
    const user = getUserById(String(req.user?.sub));
    if (!user) throw new AppError(401, 'Sesi tidak berlaku', undefined, 'INVALID_SESSION');
    res.json({ user });
  });

  return router;
}
