import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

process.loadEnvFile('.env');
// Deliberately the unversioned (deprecated) paths and the legacy body `version`:
// this suite doubles as the backward-compatibility test for existing clients.
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000/api';
const run = randomUUID();
const password = `Shop-${randomUUID()}`;
const email = `shop-${run}@test.local`;
const address = {
  recipient: `Buyer ${run.slice(0, 8)}`,
  phone: '081234567890',
  street: 'Jalan Pengujian 123',
  city: 'Bandung',
  province: 'Jawa Barat',
  postalCode: '40123',
  notes: 'Panggil penerima saat tiba',
};
const checks = [];
const createdProducts = [];
let admin, buyer, other, first, second, snapshot, order;
const checkoutAlias = randomUUID();
async function api(path, { method = 'GET', token, body, key } = {}, attempt = 0) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 429 && attempt < 2) {
    await response.body?.cancel();
    const seconds = Math.min(61, Math.max(1, Number(response.headers.get('retry-after') ?? 60)));
    console.log(`Respecting rate limit; waiting ${seconds}s`);
    await sleep(seconds * 1000);
    return api(path, { method, token, body, key }, attempt + 1);
  }
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, passed: false, error: error.message });
    throw error;
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function compose(...args) {
  execFileSync('docker', ['compose', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
  });
}
async function healthy() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await api('/health')).data.status === 'ok') return;
    } catch {
      /* wait for restart */
    }
    await sleep(1000);
  }
  throw new Error('Stack not ready');
}
async function getCart(token = buyer) {
  const result = await api('/cart', { token });
  assert.equal(result.status, 200);
  return result.data.cart;
}
async function setItem(id, quantity) {
  const cart = await getCart();
  const result = await api(`/cart/items/${id}`, {
    method: 'PUT',
    token: buyer,
    body: { quantity, version: cart.version },
  });
  assert.equal(result.status, 200);
  return result.data.cart;
}
async function createProduct(stock, price = 25000) {
  const result = await api('/products', {
    method: 'POST',
    token: admin,
    body: { name: `Shop ${run} ${createdProducts.length}`, price, stock },
  });
  assert.equal(result.status, 201);
  createdProducts.push(result.data.product.id);
  return result.data.product;
}
try {
  await healthy();
  await check('new SPA routes and bootstrap sessions', async () => {
    for (const path of ['/cart', '/checkout', '/orders', '/admin'])
      assert.equal((await fetch(base.replace(/\/api$/, '') + path)).status, 200);
    const result = await api('/auth/login', {
      method: 'POST',
      body: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD },
    });
    assert.equal(result.status, 200);
    admin = result.data.token;
    // Accounts become usable only after their address was confirmed with the mailed link
    // and their password (training mailbox). Mail leaves after the HTTP response.
    for (const account of [email, `other-${email}`]) {
      assert.equal(
        (await api('/auth/register', { method: 'POST', body: { email: account, password } }))
          .status,
        202,
      );
      let link;
      for (let attempt = 0; attempt < 20 && !link; attempt++) {
        const mailbox = await api(`/auth/admin/outbox?to=${encodeURIComponent(account)}`, {
          token: admin,
        });
        link = mailbox.data.messages.find((message) => message.link?.includes('/verify-email#'));
        if (!link) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const token = link.link.split('#token=')[1];
      assert.equal(
        (await api('/auth/verify-email', { method: 'POST', body: { token, password } })).status,
        200,
      );
    }
    buyer = (await api('/auth/login', { method: 'POST', body: { email, password } })).data.token;
    other = (
      await api('/auth/login', { method: 'POST', body: { email: `other-${email}`, password } })
    ).data.token;
    first = await createProduct(10);
    second = await createProduct(5, 15000);
  });
  await check('persistent cart CRUD, quoted totals and optimistic concurrency', async () => {
    assert.equal((await api('/cart')).status, 401);
    const initial = await getCart();
    await setItem(first.id, 2);
    await setItem(second.id, 3);
    let cart = await getCart();
    assert.equal(cart.total, 95000);
    assert.equal(cart.quantity, 5);
    assert.equal((await getCart(other)).quantity, 0);
    assert.equal(
      (
        await api(`/cart/items/${first.id}`, {
          method: 'PUT',
          token: buyer,
          body: { quantity: 3, version: initial.version },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await api(`/cart/items/${second.id}`, {
          method: 'DELETE',
          token: buyer,
          body: { version: cart.version },
        })
      ).status,
      200,
    );
    await setItem(second.id, 1);
    cart = await getCart();
    assert.equal(cart.total, 65000);
    assert.equal(
      (
        await api(`/cart/items/${first.id}`, {
          method: 'PUT',
          token: buyer,
          body: { quantity: 1001, version: cart.version },
        })
      ).status,
      400,
    );
    snapshot = cart;
  });
  await check('empty checkout and invalid shipping addresses are rejected', async () => {
    const empty = await getCart(other);
    assert.equal(
      (
        await api('/cart/checkout', {
          method: 'POST',
          token: other,
          key: randomUUID(),
          body: { version: empty.version, shippingAddress: address },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await api('/cart/checkout', {
          method: 'POST',
          token: buyer,
          key: randomUUID(),
          body: { version: snapshot.version, shippingAddress: { ...address, postalCode: 'abc' } },
        })
      ).status,
      400,
    );
  });
  await check('one cart snapshot produces one order across concurrent different keys', async () => {
    assert.equal(
      (
        await api(`/products/${first.id}`, {
          method: 'PUT',
          token: admin,
          body: { price: 30000, expectedRevision: first.revision },
        })
      ).status,
      200,
    );
    const options = {
      method: 'POST',
      token: buyer,
      body: { version: snapshot.version, shippingAddress: address },
    };
    const results = await Promise.all([
      api('/cart/checkout', { ...options, key: randomUUID() }),
      api('/cart/checkout', { ...options, key: checkoutAlias }),
    ]);
    assert.ok(results.every((result) => result.status === 201));
    assert.equal(results[0].data.order.id, results[1].data.order.id);
    order = results[0].data.order;
    assert.equal(order.total, 75000);
    assert.deepEqual(order.shippingAddress, address);
    assert.equal((await getCart()).quantity, 0);
    assert.equal((await api(`/products/${first.id}`)).data.product.stock, 8);
    assert.equal(
      (await api('/cart/checkout', { ...options, key: randomUUID() })).data.order.id,
      order.id,
    );
    assert.equal(
      (
        await api('/cart/checkout', {
          ...options,
          key: randomUUID(),
          body: { version: snapshot.version, shippingAddress: { ...address, city: 'Bogor' } },
        })
      ).status,
      409,
    );
  });
  await check('history, detail, pagination and customer/admin authorization', async () => {
    const history = await api('/orders?limit=1&status=CONFIRMED', { token: buyer });
    assert.equal(history.status, 200);
    assert.equal(history.data.orders[0].id, order.id);
    assert.equal(history.data.total, 1);
    assert.equal((await api(`/orders/${order.id}`, { token: other })).status, 404);
    assert.equal((await api('/orders/admin', { token: buyer })).status, 403);
    assert.equal((await api('/orders/admin/summary', { token: buyer })).status, 403);
    assert.equal((await api('/products/admin/summary', { token: buyer })).status, 403);
    assert.equal(
      (
        await api(`/orders/admin/${order.id}/fulfillment`, {
          method: 'PATCH',
          token: buyer,
          body: { status: 'PROCESSING' },
        })
      ).status,
      403,
    );
    assert.equal((await api('/orders?limit=101', { token: buyer })).status, 400);
    const search = await api(`/orders/admin?q=${encodeURIComponent(address.recipient)}`, {
      token: admin,
    });
    assert.equal(search.data.total, 1);
    assert.ok((await api('/orders/admin/summary', { token: admin })).data.confirmedValue >= 75000);
    assert.ok((await api('/products/admin/summary', { token: admin })).data.totalProducts >= 2);
  });
  await check('admin inventory edits cannot overwrite checkout changes', async () => {
    assert.equal(
      (
        await api(`/products/${first.id}`, {
          method: 'PUT',
          token: admin,
          body: { stock: 10, expectedRevision: first.revision },
        })
      ).status,
      409,
    );
    const product = (await api(`/products/${first.id}`)).data.product;
    assert.equal(
      (
        await api(`/products/${first.id}`, {
          method: 'PUT',
          token: admin,
          body: { price: 35000, expectedRevision: product.revision },
        })
      ).status,
      200,
    );
    assert.equal((await api(`/orders/${order.id}`, { token: buyer })).data.order.total, 75000);
  });
  await check('fulfillment transitions are ordered and visible to the customer', async () => {
    const path = `/orders/admin/${order.id}/fulfillment`;
    assert.equal(
      (await api(path, { method: 'PATCH', token: admin, body: { status: 'COMPLETED' } })).status,
      409,
    );
    for (const status of ['PROCESSING', 'PROCESSING', 'COMPLETED'])
      assert.equal(
        (await api(path, { method: 'PATCH', token: admin, body: { status } })).status,
        200,
      );
    assert.equal(
      (await api(path, { method: 'PATCH', token: admin, body: { status: 'PROCESSING' } })).status,
      409,
    );
    assert.equal(
      (await api(`/orders/${order.id}`, { token: buyer })).data.order.fulfillmentStatus,
      'COMPLETED',
    );
  });
  await check('cart survives signing in again and order-service restart', async () => {
    await setItem(first.id, 1);
    const before = await getCart();
    assert.equal(
      (
        await api('/cart/checkout', {
          method: 'POST',
          token: buyer,
          key: checkoutAlias,
          body: { version: before.version, shippingAddress: address },
        })
      ).status,
      409,
    );
    buyer = (await api('/auth/login', { method: 'POST', body: { email, password } })).data.token;
    if (process.argv.includes('--chaos')) {
      compose('restart', 'order-service');
      await healthy();
    }
    const after = await getCart();
    assert.equal(after.version, before.version);
    assert.equal(after.quantity, 1);
    assert.equal(
      (
        await api('/cart/checkout', {
          method: 'POST',
          token: buyer,
          key: randomUUID(),
          body: { version: after.version, shippingAddress: address },
        })
      ).status,
      201,
    );
  });
  await check('out-of-stock checkout leaves cart intact and supports correction', async () => {
    const limited = await createProduct(1, 100);
    await setItem(limited.id, 2);
    let cart = await getCart();
    assert.equal(cart.canCheckout, false);
    assert.equal(
      (
        await api('/cart/checkout', {
          method: 'POST',
          token: buyer,
          key: randomUUID(),
          body: { version: cart.version, shippingAddress: address },
        })
      ).status,
      409,
    );
    assert.equal((await getCart()).quantity, 2);
    assert.equal((await api(`/products/${limited.id}`)).data.product.stock, 1);
    await setItem(limited.id, 1);
    cart = await getCart();
    assert.equal(
      (
        await api('/cart/checkout', {
          method: 'POST',
          token: buyer,
          key: randomUUID(),
          body: { version: cart.version, shippingAddress: address },
        })
      ).status,
      201,
    );
  });
  await check('deleted catalog products remain removable from the cart', async () => {
    const removed = await createProduct(1, 100);
    await setItem(removed.id, 1);
    assert.equal(
      (await api(`/products/${removed.id}`, { method: 'DELETE', token: admin })).status,
      204,
    );
    const cart = await getCart();
    assert.equal(cart.items[0].available, false);
    assert.equal(cart.canCheckout, false);
    assert.equal(
      (
        await api(`/cart/items/${removed.id}`, {
          method: 'DELETE',
          token: buyer,
          body: { version: cart.version },
        })
      ).status,
      200,
    );
  });
  if (process.argv.includes('--chaos'))
    await check(
      'pending checkout recovers after restart and clears its original cart exactly once',
      async () => {
        const recovered = await createProduct(5, 100);
        await setItem(recovered.id, 2);
        const cart = await getCart();
        const key = randomUUID();
        const options = {
          method: 'POST',
          token: buyer,
          key,
          body: { version: cart.version, shippingAddress: address },
        };
        try {
          compose('stop', 'product-service');
          assert.equal((await api('/cart/checkout', options)).status, 503);
          compose('restart', 'order-service');
        } finally {
          compose('start', 'product-service');
        }
        await healthy();
        await sleep(6000);
        const first = await api('/cart/checkout', options);
        assert.equal(first.status, 201);
        assert.equal((await api('/cart/checkout', options)).data.order.id, first.data.order.id);
        assert.equal((await getCart()).quantity, 0);
        assert.equal((await api(`/products/${recovered.id}`)).data.product.stock, 3);
      },
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const id of createdProducts) {
    try {
      await api(`/products/${id}`, { method: 'DELETE', token: admin });
    } catch {
      /* preserve report even during outage */
    }
  }
  mkdirSync('.e2e', { recursive: true });
  writeFileSync(
    '.e2e/shopping-results.json',
    JSON.stringify({ completedAt: new Date().toISOString(), checks }, null, 2),
  );
  console.log(
    `${checks.filter((check) => check.passed).length}/${checks.length} shopping end-to-end checks passed`,
  );
}
