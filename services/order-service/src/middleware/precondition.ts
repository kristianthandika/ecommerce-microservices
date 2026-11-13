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
 * keep working; such responses carry `Deprecation: true`. A DELETE body has no
 * defined semantics in HTTP and some proxies drop it, which is why the header wins.
 */
export interface Precondition {
  version: string;
  conflictStatus: 409 | 412;
}

const versionSchema = z.uuid();

export function cartPrecondition(req: Request, res: Response): Precondition {
  const header = req.get('if-match');
  if (header !== undefined) {
    const match = /^"([^"]+)"$/.exec(header.trim());
    const version = match && versionSchema.safeParse(match[1]);
    if (!version?.success)
      throw new AppError(
        400,
        'If-Match harus berisi satu ETag keranjang, mis. "<version>"',
        undefined,
        'INVALID_PRECONDITION',
      );
    return { version: version.data, conflictStatus: 412 };
  }
  const legacy = versionSchema.safeParse((req.body as { version?: unknown } | undefined)?.version);
  if (legacy.success) {
    res.set('Deprecation', 'true');
    return { version: legacy.data, conflictStatus: 409 };
  }
  throw new AppError(
    428,
    'Header If-Match wajib diisi dengan ETag keranjang terbaru',
    undefined,
    'PRECONDITION_REQUIRED',
  );
}

/** Exposes the cart version as a strong ETag; never cached, prices are live data. */
export function sendCartVersion(res: Response, version: string): void {
  res.set('ETag', `"${version}"`);
  res.set('Cache-Control', 'no-store');
}
