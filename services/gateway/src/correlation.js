import { CORRELATION_ID_HEADER } from '@ecommerce/logger';

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
 *
 * Correlation ID juga dipantulkan ke response klien.
 */
export function attachCorrelation(request, reply, done) {
  const id = request.id;
  const clientIp = request.ip;

  reply.header(CORRELATION_ID_HEADER, id);

  request.raw.headers[CORRELATION_ID_HEADER] = id;
  request.raw.headers['x-forwarded-for'] = clientIp;
  request.raw.headers['x-real-ip'] = clientIp;

  done();
}
