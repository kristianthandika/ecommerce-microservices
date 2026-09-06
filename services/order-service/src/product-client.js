import { createResilientClient, CircuitOpenError } from '@ecommerce/resilient-http-client';
import { CORRELATION_ID_HEADER } from '@ecommerce/logger';
import { config } from './config.js';
import { AppError } from './middleware/errors.js';

/**
 * Client resilient ke product-service — dibuat SEKALI di level modul supaya
 * state circuit breaker persist antar-request (kalau dibuat ulang tiap
 * request, breaker tidak akan pernah OPEN).
 */
const client = createResilientClient({
  name: 'product-service',
  timeoutMs: config.resilience.timeoutMs,
  retries: config.resilience.retries,
  baseDelayMs: config.resilience.baseDelayMs,
  failureThreshold: config.resilience.failureThreshold,
  resetTimeoutMs: config.resilience.resetTimeoutMs,
});

/**
 * Ambil satu produk dari product-service, MENERUSKAN correlation ID ke hop
 * berikutnya (m3.2) supaya trace tidak putus di order→product.
 *
 * @param {string} id
 * @param {{ correlationId?: string }} ctx
 */
export async function fetchProduct(id, { correlationId } = {}) {
  const url = `${config.productServiceUrl}/products/${id}`;
  const headers = {};
  if (correlationId) headers[CORRELATION_ID_HEADER] = correlationId;

  let res;
  try {
    res = await client(url, { headers });
  } catch (err) {
    // Breaker OPEN atau semua retry habis → degradasi anggun (503), bukan crash.
    if (err instanceof CircuitOpenError) {
      throw new AppError(503, 'Layanan produk sedang tidak tersedia (circuit open)', undefined);
    }
    throw new AppError(503, 'Gagal menghubungi layanan produk', undefined);
  }

  if (res.status === 404) throw new AppError(404, `Produk ${id} tidak ditemukan`, undefined);
  if (!res.ok) throw new AppError(502, 'Respons tidak terduga dari layanan produk', undefined);

  const body = await res.json();
  return body.product;
}
