import { createResilientClient, CircuitOpenError } from '@ecommerce/resilient-http-client';
import { CORRELATION_ID_HEADER } from '@ecommerce/logger';
import { z } from 'zod';
import { config } from './config.ts';
import { AppError } from './middleware/errors.ts';

const client = createResilientClient({
  name: 'product-service',
  ...config.resilience,
  totalTimeoutMs: 7000,
});
const lineSchema = z.object({
  productId: z.uuid(),
  name: z.string().min(1),
  unitPrice: z.number().int().positive().max(1_000_000_000),
  quantity: z.number().int().positive().max(50_000),
  subtotal: z.number().int().nonnegative(),
});
const reservationSchema = z.object({
  reservation: z.object({
    id: z.uuid(),
    items: z.array(lineSchema).min(1).max(50),
    total: z.number().int().nonnegative(),
  }),
});
export async function reserveProducts(
  id: string,
  items: { productId: string; quantity: number }[],
  ctx: { correlationId?: string; signal?: AbortSignal } = {},
) {
  let response: Response;
  try {
    response = await client(
      `${config.productServiceUrl}/internal/reservations/${encodeURIComponent(id)}`,
      {
        method: 'POST',
        signal: ctx.signal,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': id,
          'x-service-token': config.internalServiceToken,
          ...(ctx.correlationId ? { [CORRELATION_ID_HEADER]: ctx.correlationId } : {}),
        },
        body: JSON.stringify({ items }),
      },
    );
  } catch (err) {
    if (err instanceof CircuitOpenError)
      throw new AppError(
        503,
        'Layanan produk sedang tidak tersedia',
        undefined,
        'UPSTREAM_UNAVAILABLE',
      );
    throw new AppError(503, 'Gagal menghubungi layanan produk', undefined, 'UPSTREAM_UNAVAILABLE');
  }
  if (response.status === 404 || response.status === 409) {
    await response.body?.cancel();
    throw new AppError(
      response.status,
      response.status === 404
        ? 'Produk tidak ditemukan'
        : 'Stok tidak cukup atau reservasi bertentangan',
      undefined,
      response.status === 404 ? 'NOT_FOUND' : 'OUT_OF_STOCK',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      502,
      'Respons tidak terduga dari layanan produk',
      undefined,
      'UPSTREAM_ERROR',
    );
  }
  try {
    const { reservation } = reservationSchema.parse(await response.json());
    if (
      reservation.id !== id ||
      reservation.total !== reservation.items.reduce((sum, line) => sum + line.subtotal, 0) ||
      reservation.items.some((line) => line.subtotal !== line.unitPrice * line.quantity)
    )
      throw new Error('Invalid totals');
    const actual = reservation.items.map((line) => [line.productId, line.quantity]).sort();
    const expected = items.map((line) => [line.productId, line.quantity]).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Invalid items');
    return reservation;
  } catch {
    throw new AppError(
      502,
      'Kontrak respons layanan produk tidak valid',
      undefined,
      'UPSTREAM_CONTRACT',
    );
  }
}

const productsSchema = z.object({
  products: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string().min(1),
        price: z.number().int().positive().max(1_000_000_000),
        stock: z.number().int().nonnegative().max(1_000_000),
      }),
    )
    .max(50),
});
export async function readProducts(
  ids: string[],
  ctx: { correlationId?: string; signal?: AbortSignal } = {},
) {
  let response: Response;
  try {
    response = await client(
      `${config.productServiceUrl}/products?ids=${encodeURIComponent(ids.join(','))}`,
      {
        signal: ctx.signal,
        headers: {
          // Membuktikan ini panggilan service-ke-service, supaya product-service
          // tidak menghitung SEMUA user order-service sebagai satu IP di limiter.
          'x-service-token': config.internalServiceToken,
          ...(ctx.correlationId ? { [CORRELATION_ID_HEADER]: ctx.correlationId } : {}),
        },
      },
    );
  } catch {
    throw new AppError(
      503,
      'Katalog produk sementara tidak tersedia',
      undefined,
      'UPSTREAM_UNAVAILABLE',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(502, 'Gagal membaca katalog produk');
  }
  try {
    return productsSchema.parse(await response.json()).products;
  } catch {
    throw new AppError(502, 'Kontrak katalog tidak valid', undefined, 'UPSTREAM_CONTRACT');
  }
}

const releaseSchema = z.object({
  reservation: z.object({ id: z.uuid(), status: z.literal('RELEASED') }),
});
/**
 * Compensation call for a cancelled order. Idempotent on product-service, so the
 * Idempotency-Key header lets the resilient client retry it safely.
 */
export async function releaseReservation(
  id: string,
  ctx: { correlationId?: string; signal?: AbortSignal } = {},
) {
  let response: Response;
  try {
    response = await client(
      `${config.productServiceUrl}/internal/reservations/${encodeURIComponent(id)}/release`,
      {
        method: 'POST',
        signal: ctx.signal,
        headers: {
          'idempotency-key': `release-${id}`,
          'x-service-token': config.internalServiceToken,
          ...(ctx.correlationId ? { [CORRELATION_ID_HEADER]: ctx.correlationId } : {}),
        },
      },
    );
  } catch {
    throw new AppError(503, 'Gagal menghubungi layanan produk', undefined, 'UPSTREAM_UNAVAILABLE');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(502, 'Pelepasan stok ditolak layanan produk', undefined, 'UPSTREAM_ERROR');
  }
  let parsed: z.infer<typeof releaseSchema>;
  try {
    parsed = releaseSchema.parse(await response.json());
  } catch {
    throw new AppError(
      502,
      'Kontrak respons layanan produk tidak valid',
      undefined,
      'UPSTREAM_CONTRACT',
    );
  }
  if (parsed.reservation.id !== id)
    throw new AppError(
      502,
      'Kontrak respons layanan produk tidak valid',
      undefined,
      'UPSTREAM_CONTRACT',
    );
  return parsed.reservation;
}
