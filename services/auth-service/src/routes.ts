import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from './middleware/errors.ts';
import { validate } from './middleware/validate.ts';
import { requireAuth } from './middleware/require-auth.ts';
import { getKeyMaterial } from './keys.ts';
import { register, login, getUserById, accessTokenFor } from './users.ts';
import { config } from './config.ts';
import { credentialsSchema } from './schemas.ts';
import { startSession, rotateSession, endSession, endSessionForMissingUser } from './sessions.ts';

type Credentials = z.infer<typeof credentialsSchema>;

const cookieOptions = () => ({
  httpOnly: true, // tidak terbaca JavaScript → tidak bisa dicuri lewat XSS
  secure: config.refresh.cookieSecure,
  sameSite: 'strict' as const, // tidak pernah dikirim dari situs lain (CSRF)
  path: config.refresh.cookiePath, // hanya dikirim ke endpoint auth, bukan ke API lain
});

function readRefreshCookie(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === config.refresh.cookieName) {
      const value = rest.join('=');
      return /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

function sendSession(
  res: Response,
  session: { token: string; expiresAt: number },
  body: { token: string; user: unknown },
): void {
  res.cookie(config.refresh.cookieName, session.token, {
    ...cookieOptions(),
    maxAge: Math.max(0, session.expiresAt - Date.now()),
  });
  // Token tidak boleh tersimpan di cache browser/proxy mana pun.
  res.set('Cache-Control', 'no-store');
  res.json({ ...body, expiresIn: config.jwt.expiresInSeconds });
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
  router.post('/register', validate(credentialsSchema), async (req: Request, res: Response) => {
    const user = await register(req.validated as Credentials);
    res.status(201).json({ user });
  });

  router.post('/login', validate(credentialsSchema), async (req: Request, res: Response) => {
    let result: Awaited<ReturnType<typeof login>>;
    try {
      result = await login(req.validated as Credentials);
    } catch (err) {
      if (err instanceof AppError && err.code === 'LOGIN_THROTTLED')
        res.set(
          'Retry-After',
          String((err.details as { retryAfterSeconds: number }).retryAfterSeconds),
        );
      throw err;
    }
    sendSession(res, startSession(result.user.id), result);
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
        access = accessTokenFor(rotation.userId);
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
