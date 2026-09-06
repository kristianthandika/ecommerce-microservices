import { AppError } from './errors.js';

/**
 * RBAC (m2.1): batasi route ke role tertentu berdasar klaim `role` di JWT.
 * Pakai SETELAH requireAuth. Contoh: `router.post('/', requireAuth, requireRole('admin'), h)`.
 */
export function requireRole(...allowed) {
  return (req, _res, next) => {
    if (!req.user) throw new AppError(401, 'Belum terautentikasi', undefined);
    if (!allowed.includes(req.user.role)) {
      throw new AppError(403, 'Akses ditolak: role tidak mencukupi', undefined);
    }
    next();
  };
}
