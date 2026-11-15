import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errors.ts';

/**
 * OWASP API6: only accounts with a verified email may create orders, so every
 * account that holds stock is backed by a working mailbox. `email_verified` is set
 * by auth-service (OIDC claim name). Missing or non-boolean claims are rejected;
 * users of older tokens must sign in again and verify their email.
 */
export function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.email_verified !== true)
    throw new AppError(
      403,
      'Verifikasi email Anda sebelum membuat pesanan. Periksa kotak masuk atau kirim ulang tautannya.',
      undefined,
      'EMAIL_NOT_VERIFIED',
    );
  next();
}
