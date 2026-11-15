import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';

const serviceToken = 'unit-test-service-token-0123456789abcdef';
let app: Express;

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.INTERNAL_SERVICE_TOKEN = serviceToken;
  app = (await import('../src/app.ts')).createApp();
});

async function burst(headers: Record<string, string>): Promise<number[]> {
  const statuses: number[] = [];
  // order-service membaca katalog untuk SEMUA user dari satu alamat IP.
  for (let batch = 0; batch < 7; batch++) {
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(app).get(`/products?ids=${randomUUID()}`).set(headers),
      ),
    );
    statuses.push(...responses.map((response) => response.status));
  }
  return statuses;
}

describe('product-service rate limiting', () => {
  it('rejects internal reservations without a valid service token', async () => {
    const path = `/internal/reservations/${randomUUID()}`;
    const body = { items: [{ productId: randomUUID(), quantity: 1 }] };
    expect((await request(app).post(path).send(body)).status).toBe(401);
    expect((await request(app).post(path).set('x-service-token', 'wrong').send(body)).status).toBe(
      401,
    );
    // Token benar → lolos autentikasi (produk acak memang tidak ada → 404).
    const authorized = await request(app)
      .post(path)
      .set('x-service-token', serviceToken)
      .send(body);
    expect(authorized.status).toBe(404);
  });

  it('never throttles service-to-service reads that present the service token', async () => {
    const statuses = await burst({ 'x-service-token': serviceToken });
    expect(statuses).toHaveLength(350);
    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it('still throttles anonymous callers and callers with a wrong token', async () => {
    const statuses = await burst({ 'x-service-token': 'x'.repeat(serviceToken.length) });
    const allowed = statuses.filter((status) => status === 200).length;
    const throttled = statuses.filter((status) => status === 429).length;
    // Kuota 300/menit dibagi dengan dua panggilan tanpa token di tes pertama.
    expect(allowed + throttled).toBe(350);
    expect(allowed).toBeLessThanOrEqual(300);
    expect(throttled).toBeGreaterThanOrEqual(50);
  });
});
