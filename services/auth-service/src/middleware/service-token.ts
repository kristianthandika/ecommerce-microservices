import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { AppError } from './errors.ts';

/**
 * True HANYA kalau request membawa service token yang benar. Perbandingan
 * constant-time; token kosong (belum dikonfigurasi) tidak pernah cocok.
 */
export function hasServiceToken(req: Request): boolean {
  const expected = Buffer.from(config.internalServiceToken);
  const received = Buffer.from(req.get('x-service-token') ?? '');
  return (
    expected.length > 0 &&
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  );
}

/** Lindungi route internal: hanya service lain yang memegang token boleh masuk. */
export function requireServiceToken(req: Request, _res: Response, next: NextFunction): void {
  if (!hasServiceToken(req))
    throw new AppError(401, 'Service token tidak valid', undefined, 'UNAUTHORIZED');
  next();
}
