import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from './errors.ts';

/**
 * Optimistic concurrency with standard HTTP preconditions (RFC 9110 §13.1.1).
 *
 * The client reads `ETag: "<version>"` and sends it back as `If-Match` on every
 * change. A stale version yields 412 Precondition Failed; a missing precondition
 * yields 428 Precondition Required (RFC 6585), so lost updates cannot happen silently.
 *
 * The `version` body field is still accepted for one release so existing clients
 * keep working; such responses carry `Deprecation` (RFC 9745). A DELETE body has no
 * defined semantics in HTTP and some proxies drop it, which is why the header wins.
 */
export interface Precondition {
  version: string;
  conflictStatus: 409 | 412;
}

const versionSchema = z.uuid();
/** RFC 9745 structured date: when the body `version` field became deprecated. */
export const BODY_VERSION_DEPRECATED = `@${Date.UTC(2026, 10, 14) / 1000}`;

/**
 * TODO m12.1 — ganti jalur sementara ini dengan precondition HTTP standar:
 * - `If-Match: "<version>"` → `{ version, conflictStatus: 412 }`
 * - header ada tetapi formatnya salah → 400 `INVALID_PRECONDITION`
 * - tanpa header: `version` di body (jalur lama) tetap diterima dengan
 *   `res.set('Deprecation', BODY_VERSION_DEPRECATED)` dan konflik 409
 * - tanpa keduanya → 428 `PRECONDITION_REQUIRED`
 */
export function cartPrecondition(req: Request, _res: Response): Precondition {
  const legacy = versionSchema.safeParse((req.body as { version?: unknown } | undefined)?.version);
  if (legacy.success) return { version: legacy.data, conflictStatus: 409 };
  throw new AppError(400, 'version keranjang wajib diisi', undefined, 'VALIDATION_ERROR');
}

/** TODO m12.1 — kirim versi sebagai `ETag: "<version>"` dan `Cache-Control: no-store`. */
export function sendCartVersion(_res: Response, _version: string): void {}
