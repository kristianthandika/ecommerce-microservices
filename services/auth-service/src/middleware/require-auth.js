import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getKeyMaterial } from '../keys.js';
import { AppError } from './errors.js';

/**
 * Verifikasi JWT LOKAL untuk auth-service sendiri (punya public key langsung,
 * tidak perlu JWKS). Service LAIN (product/order) memverifikasi lewat jwks-rsa
 * dari endpoint JWKS — lihat masing-masing service.
 */
export function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AppError(401, 'Token tidak ada atau format salah', undefined);
  }
  const { publicKeyPem } = getKeyMaterial();
  try {
    req.user = jwt.verify(token, publicKeyPem, {
      algorithms: ['RS256'],
      issuer: config.jwt.issuer,
    });
  } catch {
    throw new AppError(401, 'Token tidak valid', undefined);
  }
  next();
}
