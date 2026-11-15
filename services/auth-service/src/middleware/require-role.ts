import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errors.ts';

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin')
    throw new AppError(403, 'Akses khusus administrator', undefined, 'FORBIDDEN');
  next();
}
