import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID, generateKeyPairSync, createPublicKey, type JsonWebKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import jwt from 'jsonwebtoken';
import { ServiceDatabase } from '@ecommerce/storage';
import { migrations } from '../src/migrations.ts';

/**
 * Relational order storage (indexes, keyset pagination, data migration) and the
 * per-customer hold limit (OWASP API6). Same HTTP harness as cart-cancel.test.ts.
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
const admin = sign('admin-1', 'admin');

let product: typeof import('../../product-service/src/products.ts');
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
  process.env.ORDER_MAX_OPEN_ORDERS = '6';
  process.env.ORDER_MAX_UNITS_PER_PRODUCT = '10';
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
      try {
        if (req.method === 'GET')
          return res.end(JSON.stringify({ products: product.listProducts() }));
        const [, , , id, action] = req.url!.split('/');
        if (action === 'release') {
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

const ordersOf = async (user: string) => {
  const ids: string[] = [];
  let cursor = '';
  for (;;) {
    const page = await call(`/orders?limit=2${cursor ? `&cursor=${cursor}` : ''}`, {
      token: sign(user),
    });
    ids.push(...page.data.orders.map((o: { id: string }) => o.id));
    if (!page.data.nextCursor) return ids;
    cursor = page.data.nextCursor;
  }
};

describe('relational order storage', () => {
  it('moves legacy order records into tables, keeping every field', () => {
    const directory = mkdtempSync(join(tmpdir(), 'order-migration-'));
    try {
      // What the previous release stored: one JSON blob per order in `records`.
      const legacy = new DatabaseSync(join(directory, 'order.sqlite'));
      legacy.exec(
        `CREATE TABLE records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
           expires_at INTEGER, PRIMARY KEY(namespace,key)); PRAGMA user_version=2;`,
      );
      const insert = legacy.prepare('INSERT INTO records (namespace,key,value) VALUES (?,?,?)');
      insert.run(
        'orders',
        'o-1',
        JSON.stringify({
          id: 'o-1',
          userId: 'u-1',
          status: 'CONFIRMED',
          total: 300,
          createdAt: '2026-01-01T00:00:00.000Z',
          shippingAddress: { recipient: 'Budi' },
          input: [{ productId: 'p-1', quantity: 3 }],
          items: [{ productId: 'p-1', name: 'A', unitPrice: 100, quantity: 3, subtotal: 300 }],
          fingerprint: 'f',
        }),
      );
      // Written before `input` existed: lines come from the reserved items.
      insert.run(
        'orders',
        'o-2',
        JSON.stringify({
          id: 'o-2',
          userId: 'u-1',
          status: 'FAILED',
          total: 0,
          createdAt: '2026-01-02T00:00:00.000Z',
          fulfillmentStatus: 'NEW',
          items: [{ productId: 'p-2', quantity: 1 }],
        }),
      );
      insert.run('carts', 'u-1', '{}');
      legacy.close();

      const db = new ServiceDatabase('order', { directory, migrations });
      try {
        const rows = db.statement('SELECT * FROM orders ORDER BY id').all();
        expect(
          rows.map((row) => [row.id, row.status, row.fulfillment_status, row.recipient]),
        ).toEqual([
          ['o-1', 'CONFIRMED', 'NEW', 'Budi'],
          ['o-2', 'FAILED', 'NEW', null],
        ]);
        expect(rows[0].updated_at).toBe('2026-01-01T00:00:00.000Z');
        // Columns are not duplicated inside the JSON details.
        const details = JSON.parse(String(rows[0].details));
        expect(details.status).toBeUndefined();
        expect(details.items[0].subtotal).toBe(300);
        expect(
          db
            .statement('SELECT order_id, product_id, quantity FROM order_lines ORDER BY order_id')
            .all(),
        ).toEqual([
          { order_id: 'o-1', product_id: 'p-1', quantity: 3 },
          { order_id: 'o-2', product_id: 'p-2', quantity: 1 },
        ]);
        expect(db.store('orders').size).toBe(0);
        expect(db.store('carts').size).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('answers list, recovery and admin queries from indexes', async () => {
    const { database } = await import('../src/database.ts');
    const plan = (sql: string, ...params: string[]) =>
      database
        .statement(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((row) => String(row.detail))
        .join(' | ');
    expect(
      plan(
        'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20',
        'u',
      ),
    ).toContain('USING INDEX orders_by_user');
    expect(
      plan(
        "SELECT * FROM orders WHERE status IN ('PENDING', 'CANCELLATION_REQUESTED') ORDER BY created_at, id LIMIT 100",
      ),
    ).toContain('USING INDEX orders_by_status');
    expect(plan('SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 20')).toContain(
      'USING INDEX orders_by_created',
    );
  });

  it('pages with a keyset cursor that neither repeats nor skips when orders arrive', async () => {
    const p = product.createProduct({ name: 'Pager', price: 100, stock: 100 });
    for (let i = 0; i < 4; i++) expect((await order(p.id, 1, sign('pager'))).status).toBe(201);
    const first = await call('/orders?limit=2', { token: sign('pager') });
    expect(first.data.total).toBe(4);
    expect(first.data.nextCursor).toEqual(expect.any(String));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newest = (await order(p.id, 1, sign('pager'))).data.order.id;
    const second = await call(`/orders?limit=2&cursor=${first.data.nextCursor}`, {
      token: sign('pager'),
    });
    const seen = [...first.data.orders, ...second.data.orders].map((o: { id: string }) => o.id);
    expect(new Set(seen).size).toBe(4);
    expect(seen).not.toContain(newest);
    // Walking every page returns each order exactly once.
    const all = await ordersOf('pager');
    expect(all).toHaveLength(5);
    expect(new Set(all).size).toBe(5);
  });

  it('rejects malformed cursors and unbounded offsets', async () => {
    for (const query of [
      'cursor=bm90LWpzb24',
      'cursor=abc&offset=20',
      'offset=10001',
      'cursor=a%2Fb',
    ]) {
      const response = await call(`/orders?${query}`);
      expect(response.status, query).toBe(400);
    }
    expect((await call('/orders?cursor=bm90LWpzb24')).data.error.code).toBe('INVALID_CURSOR');
  });
});

describe('per-customer hold limit (OWASP API6)', () => {
  it('caps the units of one product a customer holds in open orders', async () => {
    const holder = sign('holder');
    const p = product.createProduct({ name: 'Limited drop', price: 1000, stock: 100 });
    const firstKey = randomUUID();
    const first = await call('/orders', {
      token: holder,
      method: 'POST',
      json: { items: [{ productId: p.id, quantity: 6 }] },
      headers: { 'idempotency-key': firstKey },
    });
    expect(first.status).toBe(201);
    const refused = await order(p.id, 5, holder);
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatchObject({
      code: 'HOLD_LIMIT_EXCEEDED',
      details: { productId: p.id, limit: 10, held: 6, requested: 5 },
    });
    expect(product.getProduct(p.id).stock).toBe(94); // nothing reserved for the refusal
    expect((await order(p.id, 4, holder)).status).toBe(201);
    // A retry of an existing order is answered from its key, never refused.
    const retry = await call('/orders', {
      token: holder,
      method: 'POST',
      json: { items: [{ productId: p.id, quantity: 6 }] },
      headers: { 'idempotency-key': firstKey },
    });
    expect(retry.status).toBe(201);
    expect(retry.data.order.id).toBe(first.data.order.id);
    // Cancelling gives the allowance back, and so does completing an order.
    await call(`/orders/${first.data.order.id}/cancel`, { token: holder, method: 'POST' });
    const again = await order(p.id, 6, holder);
    expect(again.status).toBe(201);
    for (const status of ['PROCESSING', 'COMPLETED'])
      await call(`/orders/admin/${again.data.order.id}/fulfillment`, {
        token: admin,
        method: 'PATCH',
        json: { status },
      });
    expect((await order(p.id, 6, holder)).status).toBe(201);
    // Other customers are unaffected.
    expect((await order(p.id, 10, sign('neighbour'))).status).toBe(201);
  });

  it('caps the number of open orders per customer', async () => {
    const many = sign('many');
    const p = product.createProduct({ name: 'Small items', price: 100, stock: 100 });
    for (let i = 0; i < 6; i++) expect((await order(p.id, 1, many)).status).toBe(201);
    const refused = await order(p.id, 1, many);
    expect(refused.status).toBe(409);
    expect(refused.data.error.details).toMatchObject({ limit: 6, open: 6 });
  });

  it('cannot be bypassed with parallel requests', async () => {
    const racer = sign('racer');
    const p = product.createProduct({ name: 'Race', price: 100, stock: 100 });
    const results = await Promise.all([1, 2, 3].map(() => order(p.id, 4, racer)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409]);
    expect(product.getProduct(p.id).stock).toBe(92);
  });
});
