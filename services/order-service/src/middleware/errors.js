import { ZodError } from 'zod';

/**
 * Error aplikasi dengan HTTP status eksplisit. `throw new AppError(...)` di
 * dalam handler async → Express 5 otomatis meneruskannya ke error handler
 * (TANPA try/catch manual).
 */
export class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
  }
}

/** 404 untuk route yang tidak dikenal — dikembalikan sebagai JSON konsisten. */
export function notFoundHandler(req, res) {
  res.status(404).json({ error: { message: 'Resource tidak ditemukan', code: 'NOT_FOUND' } });
}

/**
 * Error handler terpusat — HARUS didaftarkan PALING TERAKHIR, setelah semua
 * route. Mengembalikan bentuk JSON error yang konsisten dan TIDAK membocorkan
 * stack trace ke client. Error validasi zod dipetakan ke 400 dengan detail
 * field yang gagal (berbeda dari 500 untuk error tak terduga).
 */
// eslint-disable-next-line no-unused-vars -- signature 4 argumen wajib untuk error handler Express
export function errorHandler(err, req, res, next) {
  req.log?.error({ err }, 'request gagal');

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        message: 'Validasi gagal',
        code: 'VALIDATION_ERROR',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { message: err.message, code: err.code || 'APP_ERROR', details: err.details },
    });
  }

  // Error tak terduga → 500 generik, jangan bocorkan detail internal.
  return res.status(500).json({ error: { message: 'Terjadi kesalahan internal', code: 'INTERNAL' } });
}
