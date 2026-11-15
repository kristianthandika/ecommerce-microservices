import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

/**
 * Error aplikasi dengan HTTP status eksplisit. `throw new AppError(...)` di
 * dalam handler async → Express 5 otomatis meneruskannya ke error handler
 * (TANPA try/catch manual).
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, message: string, details?: unknown, code = 'APP_ERROR') {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 404 untuk route yang tidak dikenal — dikembalikan sebagai JSON konsisten. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { message: 'Resource tidak ditemukan', code: 'NOT_FOUND' } });
}

/**
 * Error handler terpusat — HARUS didaftarkan PALING TERAKHIR, setelah semua
 * route. Mengembalikan bentuk JSON error yang konsisten dan TIDAK membocorkan
 * stack trace ke client. Error validasi zod dipetakan ke 400 dengan detail
 * field yang gagal (berbeda dari 500 untuk error tak terduga).
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,

  _next: NextFunction,
): void {
  const parserError = err as { type?: string };
  const parserStatus =
    parserError?.type === 'entity.parse.failed'
      ? 400
      : parserError?.type === 'entity.too.large'
        ? 413
        : undefined;
  if (parserStatus) {
    res.status(parserStatus).json({
      error: {
        message: parserStatus === 400 ? 'JSON tidak valid' : 'Payload terlalu besar',
        code: parserStatus === 400 ? 'INVALID_JSON' : 'PAYLOAD_TOO_LARGE',
      },
    });
    return;
  }
  const clientStatus = clientErrorStatus(err);
  req.log?.[
    (err instanceof AppError && err.status < 500) || err instanceof ZodError || clientStatus
      ? 'warn'
      : 'error'
  ]({ err }, 'request gagal');

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        message: 'Validasi gagal',
        code: 'VALIDATION_ERROR',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { message: err.message, code: err.code, details: err.details },
    });
    return;
  }

  // Request yang cacat sebelum sampai ke route (percent-encoding rusak di URL,
  // Content-Encoding/charset tak didukung, body terkompresi rusak) adalah kesalahan
  // klien. Tanpa cabang ini siapa pun bisa memicu 500 sesuka hati dan memenuhi log
  // error/alert dengan kegagalan palsu. Pesan aslinya tidak diteruskan ke klien.
  if (clientStatus) {
    res.status(clientStatus).json({
      error: {
        message: 'Request tidak valid',
        code: clientStatus === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'BAD_REQUEST',
      },
    });
    return;
  }

  // Error tak terduga → 500 generik, jangan bocorkan detail internal.
  res.status(500).json({ error: { message: 'Terjadi kesalahan internal', code: 'INTERNAL' } });
}

/** Status 4xx yang ditempelkan Express/body-parser pada error-nya (konvensi http-errors). */
function clientErrorStatus(err: unknown): number | undefined {
  if (err instanceof AppError || err instanceof ZodError) return undefined;
  const { status, statusCode } = (err ?? {}) as { status?: unknown; statusCode?: unknown };
  const value = typeof status === 'number' ? status : statusCode;
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value < 500
    ? value
    : undefined;
}
