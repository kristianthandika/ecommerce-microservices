import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { CORRELATION_ID_HEADER } from '@ecommerce/logger';

const SERVICE_TOKEN_HEADER = 'x-service-token';

/**
 * Correlation ID (m3.2) + penerusan IP klien asli (m3.1) dalam SATU hook.
 *
 * `request.id` sudah = correlation ID (dari `genReqId` di konstruktor Fastify).
 * Kita memutasi `request.raw.headers` — yang diteruskan apa adanya oleh
 * @fastify/http-proxy ke service di baliknya — supaya:
 *  - correlation ID YANG SAMA ikut ke hop berikutnya (trace tidak putus), dan
 *  - X-Forwarded-For / X-Real-IP berisi IP klien yang benar-benar diamati
 *    gateway. Nilai XFF di-OVERWRITE (bukan diteruskan dari klien) karena
 *    gateway adalah trust boundary — XFF kiriman klien bisa dispoof.
 *  - header `x-service-token` kiriman klien DIBUANG (hanya sah antar-service).
 */
export function attachCorrelation(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  const id = request.id;
  const clientIp = request.ip;

  reply.header(CORRELATION_ID_HEADER, id);

  request.raw.headers[CORRELATION_ID_HEADER] = id;
  request.raw.headers['x-forwarded-for'] = clientIp;
  request.raw.headers['x-real-ip'] = clientIp;
  // Kredensial service-ke-service tidak pernah sah datang dari luar: buang di
  // trust boundary supaya klien publik tidak bisa menyodorkannya ke service internal.
  delete request.raw.headers[SERVICE_TOKEN_HEADER];

  done();
}
