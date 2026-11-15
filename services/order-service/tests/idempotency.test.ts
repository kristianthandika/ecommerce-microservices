import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

let server: Server;
let orders: typeof import('../src/orders.ts');
let hits = 0;
let mode = 'ok';
// Reservation ID whose response is held back until `release()` is called.
let held: string | undefined;
let release: () => void = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const productId = randomUUID();
beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.PRODUCT_RETRIES = '0';
  server = createServer(async (req, res) => {
    hits++;
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (mode === 'invalid') return res.end('{"reservation":{}}');
    const id = req.url?.split('/').pop();
    if (id === held) await new Promise<void>((r) => (release = r));
    res.end(
      JSON.stringify({
        reservation: {
          id,
          items: [{ productId, name: 'Product', unitPrice: 100, quantity: 2, subtotal: 200 }],
          total: 200,
        },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.PRODUCT_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  orders = await import('../src/orders.ts');
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
describe('order idempotency and ownership', () => {
  it('coalesces concurrent retries, rejects key reuse and hides other users orders', async () => {
    const input = {
      userId: 'owner',
      items: [
        { productId, quantity: 1 },
        { productId, quantity: 1 },
      ],
    };
    const ctx = { idempotencyKey: randomUUID() };
    const before = hits;
    const [first, second] = await Promise.all([
      orders.createOrder(input, ctx),
      orders.createOrder(input, ctx),
    ]);
    expect(first.id).toBe(second.id);
    expect(hits - before).toBe(1);
    expect(first.items).toHaveLength(1);
    expect(() => orders.getOrder(first.id, 'intruder')).toThrow('tidak ditemukan');
    await expect(
      orders.createOrder({ ...input, items: [{ productId, quantity: 3 }] }, ctx),
    ).rejects.toMatchObject({ status: 409 });
    expect((await orders.createOrder(input, ctx)).id).toBe(first.id);
  });
  it('rejects malformed upstream contracts and retains recoverable pending work', async () => {
    mode = 'invalid';
    const input = { userId: 'owner', items: [{ productId, quantity: 2 }] };
    const ctx = { idempotencyKey: randomUUID() };
    await expect(orders.createOrder(input, ctx)).rejects.toMatchObject({ status: 502 });
    mode = 'ok';
    await orders.recoverPendingOrders();
    expect((await orders.createOrder(input, ctx)).status).toBe('CONFIRMED');
  });
  it('never lets a stale recovery snapshot overwrite an order settled in the meantime', async () => {
    const older = { userId: 'owner', items: [{ productId, quantity: 2 }] };
    const newer = { userId: 'other', items: [{ productId, quantity: 2 }] };
    const olderCtx = { idempotencyKey: randomUUID() };
    const newerCtx = { idempotencyKey: randomUUID() };
    mode = 'invalid';
    await expect(orders.createOrder(older, olderCtx)).rejects.toMatchObject({ status: 502 });
    await sleep(5); // distinct createdAt, so recovery handles `older` first
    await expect(orders.createOrder(newer, newerCtx)).rejects.toMatchObject({ status: 502 });
    mode = 'ok';

    // Recovery snapshots both PENDING orders, then blocks on the older one.
    held = orders.findOrderByKey('owner', olderCtx.idempotencyKey)!.id;
    const recovery = orders.recoverPendingOrders();
    await sleep(50);

    // Meanwhile the customer retries the newer order and an admin starts processing it.
    const confirmed = await orders.createOrder(newer, newerCtx);
    expect(confirmed.status).toBe('CONFIRMED');
    orders.updateFulfillment(confirmed.id, 'PROCESSING');
    const before = hits;

    held = undefined;
    release();
    await recovery;

    expect(orders.adminGetOrder(confirmed.id).fulfillmentStatus).toBe('PROCESSING');
    expect(hits).toBe(before); // the settled order is not reserved again
    expect((await orders.createOrder(older, olderCtx)).status).toBe('CONFIRMED');
  });
});
