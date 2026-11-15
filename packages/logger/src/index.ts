import pino, { type Logger, type LoggerOptions } from 'pino';
import { pinoHttp, type HttpLogger } from 'pino-http';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Header standar untuk correlation ID di seluruh sistem.
 * Dipakai gateway (generate), tiap service (log), dan resilient-http-client
 * (teruskan ke hop berikutnya).
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Factory logger pino terkonfigurasi — SATU konfigurasi dipakai ulang semua
 * service (m0.2). Format JSON terstruktur, level dari env `LOG_LEVEL`.
 *
 * Pretty-print HANYA aktif kalau `LOG_PRETTY=true` (mis. saat `npm run dev`
 * manual) dan `pino-pretty` tersedia — BUKAN default. Di container/production
 * biarkan JSON supaya bisa di-parse agregator log.
 *
 * @param name nama service, jadi field `service` di tiap baris log
 */
export function createLogger(name: string): Logger {
  const level = process.env.LOG_LEVEL || 'info';
  const usePretty = process.env.LOG_PRETTY === 'true';

  const options: LoggerOptions = {
    level,
    base: { service: name },
    // Jangan pernah bocorkan kredensial ke log.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-service-token"]',
        'res.headers["set-cookie"]',
        'password',
        '*.password',
        'req.body.password',
      ],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (usePretty) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    };
  }

  return pino(options);
}

/**
 * Identitas dari token yang SUDAH diverifikasi middleware auth (`req.user`): ID
 * pengguna, role, dan sesi. Request anonim atau yang ditolak tidak punya pelaku.
 */
function actorOf(req: IncomingMessage): { userId?: string; role?: string; sessionId?: string } {
  const user = (req as IncomingMessage & { user?: Record<string, unknown> }).user;
  if (!user || typeof user.sub !== 'string') return {};
  return {
    userId: user.sub,
    ...(typeof user.role === 'string' ? { role: user.role } : {}),
    ...(typeof user.sid === 'string' ? { sessionId: user.sid } : {}),
  };
}

/**
 * Middleware `pino-http` untuk service Express — request-scoped logging yang
 * SELALU menyertakan correlation ID.
 *
 * - `genReqId` membaca header `x-correlation-id` (yang diteruskan gateway di
 *   m3.2); kalau belum ada, generate baru supaya service tetap tertelusuri
 *   walau dipanggil langsung tanpa gateway.
 * - `req.log` (child logger) otomatis membawa `reqId` = correlation ID, jadi
 *   pakai `req.log.info(...)` di handler, bukan logger global, agar korelasi
 *   ikut di setiap baris.
 */
export function createHttpLogger(logger: Logger): HttpLogger {
  return pinoHttp({
    logger,
    genReqId(req: IncomingMessage, res: ServerResponse) {
      const existing = req.headers[CORRELATION_ID_HEADER];
      const candidate = Array.isArray(existing) ? existing[0] : existing;
      const id = candidate && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : randomUUID();
      // Pantulkan balik ke response supaya klien/gateway bisa melihatnya.
      res.setHeader(CORRELATION_ID_HEADER, id);
      return id;
    },
    // Sertakan correlation ID sebagai field eksplisit di setiap log line.
    customProps(req) {
      return { correlationId: req.id };
    },
    // Jejak audit: baris "request completed/errored" mencatat SIAPA pelakunya. Tanpa
    // ini aksi istimewa (hapus produk, ubah status order, baca outbox) tidak bisa
    // ditelusuri ke akun mana pun, karena header Authorization disensor.
    customSuccessObject: (req, _res, val: object) => ({ ...val, ...actorOf(req) }),
    customErrorObject: (req, _res, _err, val: object) => ({ ...val, ...actorOf(req) }),
    // 4xx = warn, 5xx = error, sisanya info. Bukan semua request jadi error.
    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  });
}

export type { Logger };
