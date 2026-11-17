import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errors.ts';

/**
 * RBAC (m2.1): batasi route ke role tertentu berdasar klaim `role` di JWT.
 * Pakai SETELAH requireAuth. Contoh: `router.post('/', requireAuth, requireRole('admin'), h)`.
 */
export function requireRole(...allowed: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw new AppError(401, 'Belum terautentikasi');
    if (!allowed.includes(String(req.user.role))) {
      throw new AppError(403, 'Akses ditolak: role tidak mencukupi', undefined, 'FORBIDDEN');
    }
    next();
  };
}
