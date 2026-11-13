import type { Request, Response, NextFunction } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';
import { config } from '../config.ts';
import { AppError } from './errors.ts';
import { createSigningKeyResolver } from './signing-keys.ts';

/**
 * Distributed auth (m2.1): verifikasi JWT TANPA memanggil auth-service di tiap
 * request. `jwks-rsa` mem-fetch public key dari endpoint JWKS auth-service;
 * hasilnya di-cache di memory oleh `createSigningKeyResolver` — jadi HANYA
 * panggilan pertama yang benar-benar menghubungi auth-service; verifikasi
 * berikutnya dari cache.
 *
 * Cache & rate-limit bawaan `jwks-rsa` SENGAJA dimatikan: keduanya dihitung per
 * `kid`, sehingga token palsu ber-`kid` acak bisa menghabiskan kuotanya dan
 * membuat user sah ditolak (lihat signing-keys.ts).
 *
 * URL auth-service dari `AUTH_SERVICE_URL` (default localhost) — BUKAN hardcode
 * hostname Docker.
 */
const client = new JwksClient({
  jwksUri: `${config.authServiceUrl}/.well-known/jwks.json`,
  cache: false,
  rateLimit: false,
  timeout: 3000,
});

const getSigningKey = createSigningKeyResolver(async () => {
  const keys = await client.getSigningKeys();
  return new Map(keys.map((key) => [key.kid, key.getPublicKey()]));
});

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AppError(401, 'Token tidak ada atau format salah');
  }

  const decodedHeader = jwt.decode(token, { complete: true })?.header;
  if (
    !decodedHeader?.kid ||
    decodedHeader.alg !== 'RS256' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(decodedHeader.kid)
  ) {
    throw new AppError(401, 'Token tidak punya kid');
  }

  // Melempar 401 (kid tak dikenal) atau 503 (key set belum pernah berhasil
  // diambil / sudah terlalu basi karena auth-service tak terjangkau).
  const publicKey = await getSigningKey(decodedHeader.kid);

  try {
    req.user = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
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
