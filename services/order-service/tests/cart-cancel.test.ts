import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID, generateKeyPairSync, createPublicKey, type JsonWebKey } from 'node:crypto';
import jwt from 'jsonwebtoken';

/**
 * HTTP-level tests for optimistic cart concurrency (If-Match/ETag), order
 * cancellation with stock release (saga compensation) and idempotency retention.
 * product-service is the real domain module behind a small HTTP double.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const jwk = { ...(createPublicKey(publicKey).export({ format: 'jwk' }) as JsonWebKey), kid: 'k1' };
const sign = (sub: string, role = 'user') =>
  jwt.sign({ role }, privateKey, {
    algorithm: 'RS256',
    keyid: 'k1',
    subject: sub,
    issuer: 'auth-service',
    audience: 'ecommerce-api',
    expiresIn: '1h',
  });
const buyer = sign('buyer');
const stranger = sign('stranger');
const admin = sign('admin-1', 'admin');

let product: typeof import('../../product-service/src/products.ts');
let orders: typeof import('../src/orders.ts');
let productDown = false;
let releaseCalls = 0;
const servers: Server[] = [];
let base = '';

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.PRODUCT_RETRIES = '0';
  process.env.PRODUCT_CB_THRESHOLD = '50';
  process.env.INTERNAL_SERVICE_TOKEN = 'test-service-token-with-at-least-32-characters';
  process.env.AUTH_SERVICE_URL = await listen(
    createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    }),
  );
  product = await import('../../product-service/src/products.ts');
  process.env.PRODUCT_SERVICE_URL = await listen(
    createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (productDown) {
        res.statusCode = 503;
        return res.end('{}');
      }
      try {
        if (req.method === 'GET')
          return res.end(JSON.stringify({ products: product.listProducts() }));
        const [, , , id, action] = req.url!.split('/');
        if (action === 'release') {
          releaseCalls++;
          return res.end(JSON.stringify({ reservation: product.releaseReservation(id) }));
        }
        const { items } = await body(req);
        res.end(JSON.stringify({ reservation: product.reserveStock(id, items) }));
      } catch (err) {
        res.statusCode = (err as { status?: number }).status ?? 500;
        res.end('{}');
      }
    }),
  );
  orders = await import('../src/orders.ts');
  const app = (await import('../src/app.ts')).createApp();
  base = await listen(createServer(app));
});
afterAll(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

async function call(
  path: string,
  {
    token = buyer,
    method = 'GET',
    json,
    headers = {},
  }: {
    token?: string;
    method?: string;
    json?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    data: text ? JSON.parse(text) : null,
  };
}
const order = (productId: string, quantity: number, token = buyer) =>
  call('/orders', {
    token,
    method: 'POST',
    json: { items: [{ productId, quantity }] },
    headers: { 'idempotency-key': randomUUID() },
  });

describe('cart concurrency with If-Match / ETag', () => {
  it('exposes the cart version as a strong, uncached ETag', async () => {
    const response = await call('/cart');
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe(`"${response.data.cart.version}"`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('requires a precondition and rejects stale or malformed ones', async () => {
    const id = product.createProduct({ name: 'Etag', price: 100, stock: 10 }).id;
    const etag = (await call('/cart')).headers.get('etag')!;

    const missing = await call(`/cart/items/${id}`, { method: 'PUT', json: { quantity: 1 } });
    expect(missing.status).toBe(428);
    expect(missing.data.error.code).toBe('PRECONDITION_REQUIRED');

    const malformed = await call(`/cart/items/${id}`, {
      method: 'PUT',
      json: { quantity: 1 },
      headers: { 'if-match': 'not-an-etag' },
    });
    expect(malformed.status).toBe(400);

    const ok = await call(`/cart/items/${id}`, {
      method: 'PUT',
      json: { quantity: 2 },
      headers: { 'if-match': etag },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('etag')).not.toBe(etag);

    // A second writer still holding the old ETag is told so (lost update prevented).
    const stale = await call(`/cart/items/${id}`, {
      method: 'PUT',
      json: { quantity: 5 },
      headers: { 'if-match': etag },
    });
    expect(stale.status).toBe(412);
    expect(stale.data.error.code).toBe('CART_CHANGED');
    expect((await call('/cart')).data.cart.items[0].quantity).toBe(2);

    // DELETE carries its precondition in a header — no request body needed.
    const removed = await call(`/cart/items/${id}`, {
      method: 'DELETE',
      headers: { 'if-match': ok.headers.get('etag')! },
    });
    expect(removed.status).toBe(200);
    expect(removed.data.cart.items).toEqual([]);
    const cleared = await call('/cart', {
      method: 'DELETE',
      headers: { 'if-match': removed.headers.get('etag')! },
    });
    expect(cleared.status).toBe(204);
  });

  it('still accepts the deprecated body version for one release, flagged as deprecated', async () => {
    const id = product.createProduct({ name: 'Legacy', price: 100, stock: 10 }).id;
    const { version } = (await call('/cart')).data.cart;
    const legacy = await call(`/cart/items/${id}`, {
      method: 'PUT',
      json: { quantity: 1, version },
    });
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('deprecation')).toMatch(/^@\d+$/); // RFC 9745
    const stale = await call(`/cart/items/${id}`, { method: 'DELETE', json: { version } });
    expect(stale.status).toBe(409); // unchanged behavior for old clients
  });
});

describe('order cancellation releases stock exactly once', () => {
  it('lets the owner cancel a new order, restocks once and hides it from others', async () => {
    const p = product.createProduct({ name: 'Cancel', price: 1000, stock: 5 });
    const created = await order(p.id, 3);
    expect(created.data.order.status).toBe('CONFIRMED');
    expect(product.getProduct(p.id).stock).toBe(2);

    const foreign = await call(`/orders/${created.data.order.id}/cancel`, {
      token: stranger,
      method: 'POST',
    });
    expect(foreign.status).toBe(404);

    const cancelled = await call(`/orders/${created.data.order.id}/cancel`, {
      method: 'POST',
      json: { reason: 'Salah pilih ukuran' },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.order).toMatchObject({
      status: 'CANCELLED',
      cancelledBy: 'customer',
      cancelReason: 'Salah pilih ukuran',
    });
    expect(product.getProduct(p.id).stock).toBe(5);

    const releasesBefore = releaseCalls;
    const again = await call(`/orders/${created.data.order.id}/cancel`, { method: 'POST' });
    expect(again.status).toBe(200);
    expect(product.getProduct(p.id).stock).toBe(5);
    expect(releaseCalls).toBe(releasesBefore); // already cancelled: no second release call
    // Cancelled orders cannot be fulfilled.
    const fulfil = await call(`/orders/admin/${created.data.order.id}/fulfillment`, {
      token: admin,
      method: 'PATCH',
      json: { status: 'PROCESSING' },
    });
    expect(fulfil.status).toBe(409);
  });

  it('leaves processing orders to administrators and refuses completed or failed ones', async () => {
    const p = product.createProduct({ name: 'Processing', price: 1000, stock: 5 });
    const id = (await order(p.id, 1)).data.order.id;
    await call(`/orders/admin/${id}/fulfillment`, {
      token: admin,
      method: 'PATCH',
      json: { status: 'PROCESSING' },
    });
    expect((await call(`/orders/${id}/cancel`, { method: 'POST' })).status).toBe(409);
    const byAdmin = await call(`/orders/admin/${id}/cancel`, { token: admin, method: 'POST' });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.data.order.cancelledBy).toBe('admin');
    expect(product.getProduct(p.id).stock).toBe(5);
    // Customers cannot use the admin endpoint.
    expect((await call(`/orders/admin/${id}/cancel`, { method: 'POST' })).status).toBe(403);

    const done = (await order(p.id, 1)).data.order.id;
    for (const status of ['PROCESSING', 'COMPLETED'])
      await call(`/orders/admin/${done}/fulfillment`, {
        token: admin,
        method: 'PATCH',
        json: { status },
      });
    expect(
      (await call(`/orders/admin/${done}/cancel`, { token: admin, method: 'POST' })).status,
    ).toBe(409);

    // 6 > 4 units left, but within the per-customer hold limit: rejected for stock.
    const failed = await order(p.id, 6);
    expect(failed.status).toBe(409);
    expect(failed.data.error.code).toBe('OUT_OF_STOCK');
    const rejected = orders.queryOrders({ userId: 'buyer', status: 'FAILED' }).orders[0];
    expect((await call(`/orders/${rejected.id}/cancel`, { method: 'POST' })).status).toBe(409);
  });

  it('finishes a cancellation requested during an outage once product-service is back', async () => {
    const p = product.createProduct({ name: 'Outage', price: 1000, stock: 5 });
    const id = (await order(p.id, 2)).data.order.id;
    productDown = true;
    try {
      const accepted = await call(`/orders/${id}/cancel`, { method: 'POST' });
      expect(accepted.status).toBe(202);
      expect(accepted.data.order.status).toBe('CANCELLATION_REQUESTED');
      expect(product.getProduct(p.id).stock).toBe(3);
    } finally {
      productDown = false;
    }
    await orders.recoverPendingOrders();
    expect(orders.adminGetOrder(id).status).toBe('CANCELLED');
    expect(product.getProduct(p.id).stock).toBe(5);
  });

  it('never lets a reservation that lost the race against a cancellation take stock', async () => {
    const p = product.createProduct({ name: 'Race', price: 1000, stock: 5 });
    const key = randomUUID();
    const send = () =>
      call('/orders', {
        method: 'POST',
        json: { items: [{ productId: p.id, quantity: 2 }] },
        headers: { 'idempotency-key': key },
      });
    productDown = true;
    let id: string;
    try {
      expect((await send()).status).toBe(503); // reservation outcome unknown → PENDING
      id = orders.findOrderByKey('buyer', key)!.id;
      expect((await call(`/orders/${id}/cancel`, { method: 'POST' })).status).toBe(202);
    } finally {
      productDown = false;
    }
    await orders.recoverPendingOrders(); // releases → tombstone, never reserves
    const retried = await send();
    expect(retried.data.order).toMatchObject({ id: id!, status: 'CANCELLED' });
    expect(product.getProduct(p.id).stock).toBe(5);
    // Even a direct late reserve for that ID is refused by product-service.
    expect(() => product.reserveStock(id!, [{ productId: p.id, quantity: 2 }])).toThrow(
      'dibatalkan',
    );
  });
});

describe('idempotency key retention', () => {
  it('forgets keys of settled orders after the retention window, never of pending ones', async () => {
    const p = product.createProduct({ name: 'Retention', price: 1000, stock: 10 });
    const settledKey = randomUUID();
    const pendingKey = randomUUID();
    const send = (key: string) =>
      call('/orders', {
        method: 'POST',
        json: { items: [{ productId: p.id, quantity: 1 }] },
        headers: { 'idempotency-key': key },
      });
    const first = (await send(settledKey)).data.order;
    productDown = true;
    try {
      expect((await send(pendingKey)).status).toBe(503);
    } finally {
      productDown = false;
    }

    // Inside the window the same key replays the same order.
    expect((await send(settledKey)).data.order.id).toBe(first.id);

    const later = Date.now() + 25 * 3_600_000;
    const swept = orders.purgeExpiredIdempotency(later);
    expect(swept.keys.deleted).toBeGreaterThanOrEqual(1);
    expect(swept.keys.postponed).toBeGreaterThanOrEqual(1);
    expect(orders.findOrderByKey('buyer', settledKey)).toBeUndefined();
    expect(orders.findOrderByKey('buyer', pendingKey)?.status).toBe('PENDING');

    // After the window a reused key is a new request (documented contract).
    const reused = (await send(settledKey)).data.order;
    expect(reused.id).not.toBe(first.id);
    // The order itself is a business record and is kept.
    expect(orders.adminGetOrder(first.id).status).toBe('CONFIRMED');
  });
});
