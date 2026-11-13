import type { Request, Response, NextFunction } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { config } from '../config.ts';
import { getKeyMaterial } from '../keys.ts';
import { AppError } from './errors.ts';

/**
 * Verifikasi JWT LOKAL untuk auth-service sendiri (punya public key langsung,
 * tidak perlu JWKS). Service LAIN (product/order) memverifikasi lewat jwks-rsa
 * dari endpoint JWKS — lihat masing-masing service.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AppError(401, 'Token tidak ada atau format salah');
  }
  const { publicKeyPem } = getKeyMaterial();
  try {
    req.user = jwt.verify(token, publicKeyPem, {
      algorithms: ['RS256'],
      issuer: config.jwt.issuer,
      audience: 'ecommerce-api',
    }) as JwtPayload;
  } catch {
    throw new AppError(401, 'Token tidak valid');
  }
  if (
    !req.user ||
    typeof req.user.sub !== 'string' ||
    !req.user.sub ||
    typeof req.user.exp !== 'number'
  )
    throw new AppError(401, 'Klaim token tidak valid');
  next();
}
