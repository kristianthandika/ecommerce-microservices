import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

let server: Server;
let cart: typeof import('../src/cart.ts');
let checkout: typeof import('../src/checkout.ts');
let orders: typeof import('../src/orders.ts');
let product: typeof import('../../product-service/src/products.ts');
let dropNextReceipt = false;
const address = {
  recipient: 'Test Buyer',
  phone: '081234567890',
  street: 'Jalan Pengujian 123',
  city: 'Bandung',
  province: 'Jawa Barat',
  postalCode: '40123',
  notes: '',
};
beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.INTERNAL_SERVICE_TOKEN = 'test-service-token-with-at-least-32-characters';
  product = await import('../../product-service/src/products.ts');
  server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify({ products: product.listProducts() }));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { items } = JSON.parse(Buffer.concat(chunks).toString());
    try {
      const reservation = product.reserveStock(req.url!.split('/').pop()!, items);
      if (dropNextReceipt) {
        dropNextReceipt = false;
        req.socket.destroy();
        return;
      }
      res.end(JSON.stringify({ reservation }));
    } catch {
      res.statusCode = 409;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  process.env.PRODUCT_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cart = await import('../src/cart.ts');
  checkout = await import('../src/checkout.ts');
  orders = await import('../src/orders.ts');
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
describe('persistent cart and checkout', () => {
  it('isolates user carts and rejects stale updates', () => {
    const owner = randomUUID();
    const other = randomUUID();
    const id = randomUUID();
    const first = cart.getCart(owner);
    const changed = cart.changeItem(owner, id, 2, 'set', first.version);
    expect(cart.getCart(other).items).toEqual([]);
    expect(() => cart.changeItem(owner, id, 3, 'set', first.version)).toThrow('Keranjang berubah');
    expect(cart.getCart(owner).version).toBe(changed.version);
    expect(cart.changeItem(owner, id, 0, 'remove', changed.version).items).toHaveLength(0);
  });
  it('creates one order for concurrent different keys on the same cart and freezes address/prices', async () => {
    const owner = randomUUID();
    const p = product.createProduct({ name: 'Checkout', price: 500, stock: 10 });
    const snapshot = cart.changeItem(owner, p.id, 2, 'set');
    const aliasKey = randomUUID();
    const [first, second] = await Promise.all([
      checkout.checkoutCart(owner, snapshot.version, address, { idempotencyKey: randomUUID() }),
      checkout.checkoutCart(owner, snapshot.version, address, { idempotencyKey: aliasKey }),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.total).toBe(1000);
    expect(first.shippingAddress).toEqual(address);
    expect(product.getProduct(p.id).stock).toBe(8);
    expect(cart.getCart(owner).items).toHaveLength(0);
    product.updateProduct(p.id, { price: 900 });
    expect(orders.getOrder(first.id, owner).total).toBe(1000);
    expect(() => orders.getOrder(first.id, 'other')).toThrow('tidak ditemukan');
    await expect(
      checkout.checkoutCart(
        owner,
        snapshot.version,
        { ...address, city: 'Bogor' },
        { idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(orders.updateFulfillment(first.id, 'PROCESSING').fulfillmentStatus).toBe('PROCESSING');
    expect(orders.updateFulfillment(first.id, 'COMPLETED').fulfillmentStatus).toBe('COMPLETED');
    expect(() => orders.updateFulfillment(first.id, 'PROCESSING')).toThrow('Urutan status');
    const newer = cart.changeItem(owner, p.id, 1, 'set');
    await expect(
      checkout.checkoutCart(owner, newer.version, address, { idempotencyKey: aliasKey }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      orders.createOrder(
        { userId: owner, items: [{ productId: p.id, quantity: 1 }] },
        { idempotencyKey: aliasKey },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('rejects stale and empty checkout snapshots', async () => {
    const owner = randomUUID();
    const empty = cart.getCart(owner);
    await expect(
      checkout.checkoutCart(owner, empty.version, address, { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ status: 400 });
    cart.changeItem(owner, randomUUID(), 1, 'set');
    await expect(
      checkout.checkoutCart(owner, empty.version, address, { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('keeps rejected items and renews the version for a fresh attempt after restocking', async () => {
    const owner = randomUUID();
    const p = product.createProduct({ name: 'Restock', price: 100, stock: 1 });
    const snapshot = cart.changeItem(owner, p.id, 2, 'set');
    await expect(
      checkout.checkoutCart(owner, snapshot.version, address, { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ status: 409 });
    const retry = cart.getCart(owner);
    expect(retry.version).not.toBe(snapshot.version);
    expect(retry.items).toEqual(snapshot.items);
    product.updateProduct(p.id, { stock: 2 });
    expect(
      (await checkout.checkoutCart(owner, retry.version, address, { idempotencyKey: randomUUID() }))
        .status,
    ).toBe('CONFIRMED');
    expect(product.getProduct(p.id).stock).toBe(0);
  });
  it('retries a lost reservation receipt without allocating stock twice', async () => {
    const owner = randomUUID();
    const p = product.createProduct({ name: 'Receipt', price: 100, stock: 5 });
    const snapshot = cart.changeItem(owner, p.id, 2, 'set');
    dropNextReceipt = true;
    const order = await checkout.checkoutCart(owner, snapshot.version, address, {
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe('CONFIRMED');
    expect(product.getProduct(p.id).stock).toBe(3);
  });
  it('preserves changes made to the cart while a snapshot is being checked out', async () => {
    const owner = randomUUID();
    const p = product.createProduct({ name: 'Concurrent', price: 100, stock: 5 });
    const snapshot = cart.changeItem(owner, p.id, 1, 'set');
    const pending = checkout.checkoutCart(owner, snapshot.version, address, {
      idempotencyKey: randomUUID(),
    });
    const newer = cart.changeItem(owner, randomUUID(), 1, 'set');
    await pending;
    expect(cart.getCart(owner).version).toBe(newer.version);
    expect(cart.getCart(owner).items).toHaveLength(2);
  });
});
