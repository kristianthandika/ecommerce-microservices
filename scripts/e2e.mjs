import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { responses } from './openapi.mjs';

try {
  process.loadEnvFile('.env');
} catch {
  /* CI may provide environment directly. */
}
// E2E_BASE_URL is the public API root; business calls use the current version under it.
const apiRoot = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000/api';
const base = `${apiRoot}/v1`;
const frontend = apiRoot.replace(/\/api$/, '');
const checks = [];
const startedAt = new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function check(name, fn) {
  const start = Date.now();
  try {
    await fn();
    checks.push({ name, passed: true, milliseconds: Date.now() - start });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, passed: false, error: error.message });
    throw error;
  }
}
async function api(
  path,
  { token, method = 'GET', body, key, raw, headers: extra = {} } = {},
  attempt = 0,
) {
  const headers = { ...extra };
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['idempotency-key'] = key;
  // Aggregated health is operational and unversioned.
  const response = await fetch(`${path === '/health' ? apiRoot : base}${path}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Non-JSON API response for ${path}: ${response.status}`);
  }
  // Per-IP limiters are shared by every check in this run; honor Retry-After instead of
  // failing. Per-account login backoff (LOGIN_THROTTLED) is under test and returned as is.
  if (response.status === 429 && data?.error?.code === 'RATE_LIMITED' && attempt < 2) {
    const seconds = Math.min(61, Math.max(1, Number(response.headers.get('retry-after') ?? 60)));
    console.log(`Respecting rate limit; waiting ${seconds}s`);
    await sleep(seconds * 1000);
    return api(path, { token, method, body, key, raw, headers: extra }, attempt + 1);
  }
  return { status: response.status, data, headers: response.headers };
}
/** The refresh cookie set by a response, with its attributes. */
function refreshCookie(response) {
  const header = response.headers.getSetCookie().find((c) => c.startsWith('refresh_token='));
  return header ? { value: header.split(';')[0].slice('refresh_token='.length), header } : null;
}
const sessionHeaders = (cookie) => ({
  cookie: `refresh_token=${cookie}`,
  'x-requested-with': 'e2e',
});
function compose(...args) {
  return execFileSync('docker', ['compose', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  });
}
async function healthy() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await api('/health')).data?.status === 'ok') return;
    } catch {
      /* wait for readiness */
    }
    await sleep(1000);
  }
  throw new Error('Stack did not become healthy');
}
let adminToken, userToken, otherToken, product, durableOrder;
/** Newest mailed link of one kind from the training mailbox (MAIL_TRANSPORT=outbox). */
async function mailedToken(address, kind = 'verify-email') {
  // Mail leaves after the HTTP response, so give it a moment to arrive.
  for (let attempt = 0; attempt < 20; attempt++) {
    const mailbox = await api(`/auth/admin/outbox?to=${encodeURIComponent(address)}&limit=100`, {
      token: adminToken,
    });
    assert.equal(mailbox.status, 200);
    const mail = responses.Outbox.parse(mailbox.data).messages.find((message) =>
      message.link?.includes(`/${kind}#token=`),
    );
    if (mail) return mail.link.split('#token=')[1];
    await sleep(250);
  }
  throw new Error(`No ${kind} mail arrived for ${address}`);
}
/** Activates an account: the mailed link AND the password chosen at registration. */
async function verifyEmail(address, pass = password) {
  const token = await mailedToken(address);
  const verified = await api('/auth/verify-email', {
    method: 'POST',
    body: { token, password: pass },
  });
  assert.equal(verified.status, 200);
  assert.equal(responses.UserEnvelope.parse(verified.data).user.emailVerified, true);
  return token;
}
/** Registration answers every address the same way; the body carries no account data. */
async function register(body) {
  const registered = await api('/auth/register', { method: 'POST', body });
  assert.equal(registered.status, 202);
  assert.deepEqual(responses.RegistrationAccepted.parse(registered.data), {
    status: 'accepted',
    verificationRequired: true,
  });
  return registered;
}
const racerTokens = [];
const prefix = randomUUID();
const password = `Test-${randomUUID()}`;
const email = `e2e-${prefix}@test.local`;
try {
  await check('frontend, SPA route, CSP and aggregated health', async () => {
    await healthy();
    for (const path of ['/', '/dashboard']) {
      const response = await fetch(`${frontend}${path}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<div id="root">/);
      assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    }
  });
  await check('register, login, profile and admin bootstrap', async () => {
    const admin = await api('/auth/login', {
      method: 'POST',
      body: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD },
    });
    assert.equal(admin.status, 200);
    assert.equal(admin.data.user.role, 'admin');
    adminToken = admin.data.token;
    // A role sent by the client is ignored (mass assignment): the account is a user.
    await register({ email, password, role: 'admin' });
    // Until the address is confirmed the account answers like a wrong password.
    const early = await api('/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(early.status, 401);
    assert.equal(early.data.error.code, 'INVALID_CREDENTIALS');
    await verifyEmail(email);
    const login = await api('/auth/login', {
      method: 'POST',
      body: { email: email.toUpperCase(), password },
    });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.role, 'user');
    assert.equal(login.data.user.emailVerified, true);
    userToken = login.data.token;
    assert.equal((await api('/auth/me', { token: userToken })).data.user.email, email);
    const secondEmail = `other-${prefix}@test.local`;
    await register({ email: secondEmail, password });
    await verifyEmail(secondEmail);
    otherToken = (
      await api('/auth/login', { method: 'POST', body: { email: secondEmail, password } })
    ).data.token;
    // Separate customers for the stock race: one account may hold only a few open orders.
    for (let i = 0; i < 3; i++) {
      const racer = { email: `racer${i}-${prefix}@test.local`, password };
      await register(racer);
      await verifyEmail(racer.email);
      racerTokens.push((await api('/auth/login', { method: 'POST', body: racer })).data.token);
    }
  });
  await check(
    'registration reveals nothing; activation needs the link and the password',
    async () => {
      // Only administrators can read the training mailbox; the account itself cannot.
      assert.equal((await api('/auth/admin/outbox', { token: userToken })).status, 403);
      // Registering a taken address is answered exactly like a new one, and changes nothing.
      await register({ email, password: `Other-${randomUUID()}` });
      assert.equal(
        (await api('/auth/login', { method: 'POST', body: { email, password } })).status,
        200,
      );
      // A registration that was never confirmed cannot be activated by the link alone,
      // nor with a guessed password, and cannot sign in.
      const pending = `pending-${prefix}@test.local`;
      await register({ email: pending, password });
      const token = await mailedToken(pending);
      const guessed = await api('/auth/verify-email', {
        method: 'POST',
        body: { token, password: 'not-the-password' },
      });
      assert.equal(guessed.status, 401);
      assert.equal(
        (await api('/auth/verify-email', { method: 'POST', body: { token } })).status,
        400,
      );
      assert.equal(
        (await api('/auth/login', { method: 'POST', body: { email: pending, password } })).status,
        401,
      );
      // With the right password the same link works, exactly once.
      const used = await verifyEmail(pending);
      assert.equal(
        (await api('/auth/verify-email', { method: 'POST', body: { token: used, password } }))
          .status,
        400,
      );
    },
  );
  await check(
    'concurrent duplicate registrations are both accepted and leave one account',
    async () => {
      const body = { email: `race-${prefix}@test.local`, password };
      const results = await Promise.all([register(body), register(body)]);
      assert.deepEqual(
        results.map((r) => r.status),
        [202, 202],
      );
      await verifyEmail(body.email);
      assert.equal((await api('/auth/login', { method: 'POST', body })).status, 200);
    },
  );
  await check('malformed JSON, password byte limit and missing token are rejected', async () => {
    assert.equal((await api('/auth/login', { method: 'POST', raw: '{' })).status, 400);
    assert.equal(
      (
        await api('/auth/register', {
          method: 'POST',
          body: { email: `long-${prefix}@test.local`, password: '\u00e9'.repeat(37) },
        })
      ).status,
      400,
    );
    assert.equal((await api('/orders')).status, 401);
  });
  await check('unknown routes use the uniform error shape and hide internal routes', async () => {
    for (const [method, path] of [
      ['GET', '/tidak-ada'],
      ['POST', `/internal/reservations/${randomUUID()}`],
    ]) {
      const response = await api(path, { method, body: method === 'POST' ? {} : undefined });
      assert.equal(response.status, 404);
      assert.equal(response.data.error.code, 'NOT_FOUND');
      assert.ok(response.headers.get('x-correlation-id'));
    }
    assert.equal((await fetch(frontend)).headers.get('server'), 'nginx');
  });
  await check('forged key IDs cannot lock legitimate users out of authentication', async () => {
    const forged = () =>
      [
        Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: randomUUID() })),
        Buffer.from(JSON.stringify({ sub: 'attacker', exp: 9999999999 })),
        Buffer.from('forged-signature'),
      ]
        .map((part) => part.toString('base64url'))
        .join('.');
    const flood = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        api(i % 2 ? '/orders' : '/products/admin/summary', { token: forged() }),
      ),
    );
    // Every forged token is rejected as invalid (401), never as "auth unavailable" (503).
    assert.deepEqual([...new Set(flood.map((r) => r.status))], [401]);
    assert.equal((await api('/orders', { token: userToken })).status, 200);
    assert.equal((await api('/products/admin/summary', { token: adminToken })).status, 200);
  });
  await check('RBAC and integer currency validation protect product writes', async () => {
    const body = { name: `Audit ${prefix}`, price: 12345, stock: 10 };
    assert.equal((await api('/products', { method: 'POST', token: userToken, body })).status, 403);
    assert.equal(
      (
        await api('/products', {
          method: 'POST',
          token: adminToken,
          body: { ...body, name: '   ' },
        })
      ).status,
      400,
    );
    assert.equal(
      (await api('/products', { method: 'POST', token: adminToken, body: { ...body, price: 1.5 } }))
        .status,
      400,
    );
    const created = await api('/products', { method: 'POST', token: adminToken, body });
    assert.equal(created.status, 201);
    product = created.data.product;
    const updated = await api(`/products/${product.id}`, {
      method: 'PUT',
      token: adminToken,
      body: { name: `${body.name} updated` },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.product.stock, 10);
    assert.equal((await api('/products?limit=1000')).status, 400);
  });
  await check('UUID validation, required key and per-customer hold limit', async () => {
    assert.equal(
      (
        await api('/orders', {
          method: 'POST',
          token: userToken,
          key: randomUUID(),
          body: { items: [{ productId: '../health', quantity: 1 }] },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await api('/orders', {
          method: 'POST',
          token: userToken,
          body: { items: [{ productId: product.id, quantity: 1 }] },
        })
      ).status,
      400,
    );
    // Duplicate lines are summed before any check: 6 + 6 exceeds what one customer may hold.
    const greedy = await api('/orders', {
      method: 'POST',
      token: userToken,
      key: randomUUID(),
      body: {
        items: [
          { productId: product.id, quantity: 6 },
          { productId: product.id, quantity: 6 },
        ],
      },
    });
    assert.equal(greedy.status, 409);
    assert.equal(greedy.data.error.code, 'HOLD_LIMIT_EXCEEDED');
    assert.equal(greedy.data.error.details.requested, 12);
    assert.equal((await api(`/products/${product.id}`)).data.product.stock, 10);
  });
  await check(
    'concurrent same-key requests produce one order and one stock deduction',
    async () => {
      const key = randomUUID();
      const body = { items: [{ productId: product.id, quantity: 1 }] };
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          api('/orders', { method: 'POST', token: userToken, key, body }),
        ),
      );
      assert.ok(results.every((result) => result.status === 201));
      assert.equal(new Set(results.map((result) => result.data.order.id)).size, 1);
      durableOrder = results[0].data.order;
      assert.equal(durableOrder.total, product.price);
      assert.equal((await api(`/products/${product.id}`)).data.product.stock, 9);
      assert.equal(
        (
          await api('/orders', {
            method: 'POST',
            token: userToken,
            key,
            body: { items: [{ productId: product.id, quantity: 2 }] },
          })
        ).status,
        409,
      );
      assert.equal((await api(`/orders/${durableOrder.id}`, { token: otherToken })).status, 404);
      assert.equal((await api('/orders', { token: otherToken })).data.orders.length, 0);
    },
  );
  await check('concurrent distinct orders never oversell remaining stock', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        api('/orders', {
          method: 'POST',
          token: racerTokens[i % racerTokens.length],
          key: randomUUID(),
          body: { items: [{ productId: product.id, quantity: 1 }] },
        }),
      ),
    );
    assert.equal(results.filter((result) => result.status === 201).length, 9);
    assert.equal(results.filter((result) => result.status === 409).length, 3);
    assert.equal((await api(`/products/${product.id}`)).data.product.stock, 0);
  });
  await check('305 health polls do not exhaust business or health quotas', async () => {
    for (let batch = 0; batch < 31; batch++) {
      const results = await Promise.all(
        Array.from({ length: batch === 30 ? 5 : 10 }, () => api('/health')),
      );
      assert.ok(results.every((result) => result.status === 200 && result.data.status === 'ok'));
    }
    assert.equal((await api('/products')).status, 200);
  });
  await check('cart updates require a current If-Match precondition', async () => {
    const created = await api('/products', {
      method: 'POST',
      token: adminToken,
      body: { name: `Cart ${prefix}`, price: 700, stock: 5 },
    });
    const id = created.data.product.id;
    const read = await api('/cart', { token: otherToken });
    const etag = read.headers.get('etag');
    assert.equal(etag, `"${read.data.cart.version}"`);
    assert.equal(read.headers.get('cache-control'), 'no-store');
    const body = { quantity: 1 };
    const missing = await api(`/cart/items/${id}`, { method: 'PUT', token: otherToken, body });
    assert.equal(missing.status, 428);
    const ok = await api(`/cart/items/${id}`, {
      method: 'PUT',
      token: otherToken,
      body,
      headers: { 'if-match': etag },
    });
    assert.equal(ok.status, 200);
    responses.CartMutationEnvelope.parse(ok.data);
    const stale = await api(`/cart/items/${id}`, {
      method: 'PUT',
      token: otherToken,
      body: { quantity: 3 },
      headers: { 'if-match': etag },
    });
    assert.equal(stale.status, 412);
    assert.equal(stale.data.error.code, 'CART_CHANGED');
    const removed = await api(`/cart/items/${id}`, {
      method: 'DELETE',
      token: otherToken,
      headers: { 'if-match': ok.headers.get('etag') },
    });
    assert.equal(removed.status, 200);
    responses.CartMutationEnvelope.parse(removed.data);
    assert.deepEqual(removed.data.cart.items, []);
    assert.equal(
      (await api(`/products/${id}`, { method: 'DELETE', token: adminToken })).status,
      204,
    );
  });
  await check('cancelling an order returns its stock exactly once', async () => {
    const created = await api('/products', {
      method: 'POST',
      token: adminToken,
      body: { name: `Cancel ${prefix}`, price: 900, stock: 4 },
    });
    const id = created.data.product.id;
    const placed = await api('/orders', {
      method: 'POST',
      token: userToken,
      key: randomUUID(),
      body: { items: [{ productId: id, quantity: 3 }] },
    });
    assert.equal(placed.data.order.status, 'CONFIRMED');
    assert.equal((await api(`/products/${id}`)).data.product.stock, 1);
    const orderId = placed.data.order.id;
    assert.equal(
      (await api(`/orders/${orderId}/cancel`, { method: 'POST', token: otherToken })).status,
      404,
    );
    const cancelled = await api(`/orders/${orderId}/cancel`, {
      method: 'POST',
      token: userToken,
      body: { reason: 'E2E' },
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.order.status, 'CANCELLED');
    assert.equal(
      (await api(`/orders/${orderId}/cancel`, { method: 'POST', token: userToken })).status,
      200,
    );
    assert.equal((await api(`/products/${id}`)).data.product.stock, 4);
    // Processing orders are an administrator decision.
    const second = await api('/orders', {
      method: 'POST',
      token: userToken,
      key: randomUUID(),
      body: { items: [{ productId: id, quantity: 2 }] },
    });
    const secondId = second.data.order.id;
    await api(`/orders/admin/${secondId}/fulfillment`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'PROCESSING' },
    });
    assert.equal(
      (await api(`/orders/${secondId}/cancel`, { method: 'POST', token: userToken })).status,
      409,
    );
    assert.equal(
      (await api(`/orders/admin/${secondId}/cancel`, { method: 'POST', token: adminToken })).status,
      200,
    );
    assert.equal((await api(`/products/${id}`)).data.product.stock, 4);
    assert.equal(
      (await api(`/products/${id}`, { method: 'DELETE', token: adminToken })).status,
      204,
    );
  });
  await check('refresh tokens are HttpOnly cookies that rotate and can be revoked', async () => {
    const login = await api('/auth/login', { method: 'POST', body: { email, password } });
    const claims = JSON.parse(Buffer.from(login.data.token.split('.')[1], 'base64url'));
    assert.equal(claims.exp - claims.iat, 900);
    const first = refreshCookie(login);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/v1/auth'])
      assert.ok(first.header.includes(attribute), attribute);
    const foreign = await api('/auth/refresh', {
      method: 'POST',
      headers: { ...sessionHeaders(first.value), origin: 'https://evil.example' },
    });
    assert.equal(foreign.status, 403);
    const rotated = await api('/auth/refresh', {
      method: 'POST',
      headers: sessionHeaders(first.value),
    });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.data.user.email, email);
    const second = refreshCookie(rotated);
    assert.notEqual(second.value, first.value);
    // Replaying the old token after the multi-tab grace window revokes the session.
    await sleep(11_000);
    const replay = await api('/auth/refresh', {
      method: 'POST',
      headers: sessionHeaders(first.value),
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.data.error.code, 'REFRESH_REUSED');
    const afterReplay = await api('/auth/refresh', {
      method: 'POST',
      headers: sessionHeaders(second.value),
    });
    assert.equal(afterReplay.status, 401);
    // Logout revokes a fresh session.
    const fresh = refreshCookie(
      await api('/auth/login', { method: 'POST', body: { email, password } }),
    );
    const logout = await api('/auth/logout', {
      method: 'POST',
      headers: sessionHeaders(fresh.value),
    });
    assert.equal(logout.status, 204);
    const revoked = await api('/auth/refresh', {
      method: 'POST',
      headers: sessionHeaders(fresh.value),
    });
    assert.equal(revoked.status, 401);
  });
  await check('logout stops the access token at every service within seconds', async () => {
    /** Seconds until `path` answers 401 SESSION_REVOKED for `token`. */
    const refusedAfter = async (path, token) => {
      const start = Date.now();
      for (;;) {
        const response = await api(path, { token });
        if (response.status === 401) {
          assert.equal(response.data.error.code, 'SESSION_REVOKED');
          return (Date.now() - start) / 1000;
        }
        assert.ok(Date.now() - start < 10_000, `${path} still accepts a logged-out token`);
        await sleep(500);
      }
    };
    const session = await api('/auth/login', { method: 'POST', body: { email, password } });
    const adminSession = await api('/auth/login', {
      method: 'POST',
      body: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD },
    });
    assert.equal((await api('/cart', { token: session.data.token })).status, 200);
    for (const login of [session, adminSession])
      assert.equal(
        (
          await api('/auth/logout', {
            method: 'POST',
            headers: sessionHeaders(refreshCookie(login).value),
          })
        ).status,
        204,
      );
    // auth-service knows at once; order- and product-service learn it from the
    // revocation list they refresh every few seconds. The token itself has 15 minutes left.
    assert.equal((await api('/auth/me', { token: session.data.token })).status, 401);
    const seconds = [
      await refusedAfter('/cart', session.data.token),
      await refusedAfter('/products/admin/summary', adminSession.data.token),
    ];
    console.log(`     revoked after ${seconds.map((s) => s.toFixed(1)).join(' s / ')} s`);
    // Other sessions of the same people are untouched.
    assert.equal((await api('/cart', { token: userToken })).status, 200);
    assert.equal((await api('/products/admin/summary', { token: adminToken })).status, 200);
    // The internal list is not reachable from outside, with or without a guessed token.
    for (const path of ['/auth/internal/revocations', '/auth/INTERNAL/revocations'])
      assert.equal((await api(path, { headers: { 'x-service-token': 'guess' } })).status, 404);
  });
  await check('repeated wrong passwords slow down that account only', async () => {
    const target = `throttle-${prefix}@test.local`;
    await register({ email: target, password });
    await verifyEmail(target);
    for (let i = 0; i < 5; i++) {
      const miss = await api('/auth/login', {
        method: 'POST',
        body: { email: target, password: 'wrong-pass' },
      });
      assert.equal(miss.status, 401);
    }
    const locked = await api('/auth/login', { method: 'POST', body: { email: target, password } });
    assert.equal(locked.status, 429);
    assert.equal(locked.data.error.code, 'LOGIN_THROTTLED');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    const unaffected = await api('/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(unaffected.status, 200);
  });
  await check('password reset answers every address alike and ends all sessions', async () => {
    const account = { email: `reset-${prefix}@test.local`, password };
    await register(account);
    await verifyEmail(account.email);
    const before = (await api('/auth/login', { method: 'POST', body: account })).data.token;
    const request = (address) =>
      api('/auth/password-reset', { method: 'POST', body: { email: address } });
    const known = await request(account.email);
    const unknown = await request(`nobody-${prefix}@test.local`);
    assert.equal(known.status, 202);
    assert.deepEqual(unknown.data, known.data);
    responses.Accepted.parse(known.data);
    const token = await mailedToken(account.email, 'reset-password');
    const fresh = `New-${randomUUID()}`;
    const confirmed = await api('/auth/password-reset/confirm', {
      method: 'POST',
      body: { token, password: fresh },
    });
    assert.equal(confirmed.status, 200);
    responses.UserEnvelope.parse(confirmed.data);
    // The session from before the reset is refused at once; the old password is gone.
    const refused = await api('/auth/me', { token: before });
    assert.equal(refused.status, 401);
    assert.equal(refused.data.error.code, 'SESSION_REVOKED');
    assert.equal((await api('/auth/login', { method: 'POST', body: account })).status, 401);
    assert.equal(
      (
        await api('/auth/login', {
          method: 'POST',
          body: { email: account.email, password: fresh },
        })
      ).status,
      200,
    );
    // The link works once.
    assert.equal(
      (
        await api('/auth/password-reset/confirm', {
          method: 'POST',
          body: { token, password: `Again-${randomUUID()}` },
        })
      ).status,
      400,
    );
  });
  await check('responses match the published OpenAPI contract', async () => {
    const document = await fetch(`${base}/openapi.json`);
    assert.equal(document.status, 200);
    const spec = await document.json();
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.paths['/orders'].post.parameters.length > 0);
    const created = await api('/products', {
      method: 'POST',
      token: adminToken,
      body: { name: `Contract ${prefix}`, price: 700, stock: 5 },
    });
    responses.ProductEnvelope.parse(created.data);
    const id = created.data.product.id;
    responses.ProductPage.parse((await api(`/products?q=Contract&limit=5`)).data);
    responses.ProductPage.parse((await api(`/products?ids=${id}`)).data);
    responses.UserEnvelope.parse((await api('/auth/me', { token: userToken })).data);
    responses.Session.parse(
      (await api('/auth/login', { method: 'POST', body: { email, password } })).data,
    );
    responses.CartEnvelope.parse((await api('/cart', { token: userToken })).data);
    const placed = await api('/orders', {
      method: 'POST',
      token: userToken,
      key: randomUUID(),
      body: { items: [{ productId: id, quantity: 1 }] },
    });
    responses.OrderEnvelope.parse(placed.data);
    const page = responses.OrderPage.parse(
      (await api('/orders?limit=1', { token: userToken })).data,
    );
    assert.ok(page.nextCursor, 'more than one order, so a next cursor');
    responses.OrderPage.parse(
      (await api(`/orders?limit=1&cursor=${page.nextCursor}`, { token: userToken })).data,
    );
    responses.OrderPage.parse((await api('/orders/admin?limit=2', { token: adminToken })).data);
    responses.OrderSummary.parse((await api('/orders/admin/summary', { token: adminToken })).data);
    responses.StockSummary.parse(
      (await api('/products/admin/summary', { token: adminToken })).data,
    );
    responses.Health.parse((await api('/health')).data);
    // The UI's health widget uses the same base URL as every other call.
    responses.Health.parse(await (await fetch(`${base}/health`)).json());
    responses.Error.parse((await api(`/orders/${randomUUID()}`, { token: userToken })).data);
    responses.OrderEnvelope.parse(
      (await api(`/orders/${placed.data.order.id}/cancel`, { method: 'POST', token: userToken }))
        .data,
    );
    await api(`/products/${id}`, { method: 'DELETE', token: adminToken });
  });
  await check('unversioned paths still work but announce their successor and sunset', async () => {
    const legacy = await fetch(`${apiRoot}/products?limit=1`);
    assert.equal(legacy.status, 200);
    assert.match(legacy.headers.get('deprecation') ?? '', /^@\d+$/);
    assert.ok(Date.parse(legacy.headers.get('sunset') ?? '') > Date.now());
    assert.equal(legacy.headers.get('link'), '</api/v1/products?limit=1>; rel="successor-version"');
    const current = await fetch(`${base}/products?limit=1`);
    assert.equal(current.headers.get('deprecation'), null);
    assert.equal((await fetch(`${apiRoot}/v2/products`)).status, 404);
  });
  if (process.argv.includes('--chaos')) {
    await check(
      'protected routes fail closed when the revocation cache expires during auth outage',
      async () => {
        assert.equal((await api('/cart', { token: userToken })).status, 200);
        assert.equal((await api('/products/admin/summary', { token: adminToken })).status, 200);
        try {
          compose('stop', 'auth-service');
          await sleep(6000);
          for (const [path, token] of [
            ['/cart', userToken],
            ['/products/admin/summary', adminToken],
          ]) {
            const response = await api(path, { token });
            assert.equal(response.status, 503, path);
            assert.equal(response.data.error.code, 'SESSION_CHECK_UNAVAILABLE', path);
          }
          assert.equal((await api('/products?limit=1')).status, 200);
        } finally {
          compose('start', 'auth-service');
        }
        await healthy();
        await sleep(5500);
        assert.equal((await api('/cart', { token: userToken })).status, 200);
        assert.equal((await api('/products/admin/summary', { token: adminToken })).status, 200);
      },
    );
    await check('cart catalog reads for all users are not throttled as one client', async () => {
      const cart = (await api('/cart', { token: userToken })).data.cart;
      assert.equal(
        (
          await api(`/cart/items/${product.id}`, {
            method: 'PUT',
            token: userToken,
            body: { quantity: 1, version: cart.version },
          })
        ).status,
        200,
      );
      // order-service reads the catalog for every user from ONE address. Replay more
      // reads than the per-IP quota allows, exactly as order-service sends them.
      const probe = (withToken) =>
        compose(
          'exec',
          '-T',
          'order-service',
          'node',
          '-e',
          `const headers = ${withToken} ? { 'x-service-token': process.env.INTERNAL_SERVICE_TOKEN } : {};
           (async () => {
             const seen = new Set();
             for (let i = 0; i < 305; i++) {
               const r = await fetch('http://product-service:3002/products?ids=${product.id}', { headers });
               await r.arrayBuffer();
               seen.add(r.status);
             }
             console.log([...seen].sort().join(','));
           })();`,
        ).trim();
      assert.equal(probe(true), '200');
      assert.equal((await api('/cart', { token: userToken })).status, 200);
      // The limiter itself still protects product-service from unauthenticated floods.
      assert.equal(probe(false), '200,429');
      assert.equal((await api('/cart', { token: userToken })).status, 200);
    });
    await check('frontend keeps proxying after the gateway container is recreated', async () => {
      compose('up', '-d', '--no-deps', '--force-recreate', '--wait', 'gateway');
      await healthy();
      assert.equal((await api('/products?limit=1')).status, 200);
      assert.equal((await api('/auth/me', { token: userToken })).status, 200);
    });
    await check('a cancellation during a product outage completes after recovery', async () => {
      const created = await api('/products', {
        method: 'POST',
        token: adminToken,
        body: { name: `Outage cancel ${prefix}`, price: 400, stock: 3 },
      });
      const id = created.data.product.id;
      const placed = await api('/orders', {
        method: 'POST',
        token: userToken,
        key: randomUUID(),
        body: { items: [{ productId: id, quantity: 2 }] },
      });
      const orderId = placed.data.order.id;
      try {
        compose('stop', 'product-service');
        const accepted = await api(`/orders/${orderId}/cancel`, {
          method: 'POST',
          token: userToken,
        });
        assert.equal(accepted.status, 202);
        assert.equal(accepted.data.order.status, 'CANCELLATION_REQUESTED');
      } finally {
        compose('start', 'product-service');
      }
      await healthy();
      let status;
      for (let i = 0; i < 30 && status !== 'CANCELLED'; i++) {
        await sleep(1000);
        status = (await api(`/orders/${orderId}`, { token: userToken })).data.order.status;
      }
      assert.equal(status, 'CANCELLED');
      assert.equal((await api(`/products/${id}`)).data.product.stock, 3);
      assert.equal(
        (await api(`/products/${id}`, { method: 'DELETE', token: adminToken })).status,
        204,
      );
    });
    await check('containers run with a read-only root filesystem', async () => {
      const services = ['auth-service', 'product-service', 'order-service', 'gateway', 'frontend'];
      for (const service of services) {
        const probe = compose(
          'exec',
          '-T',
          service,
          'sh',
          '-c',
          'touch /usr/local/probe 2>/dev/null && echo writable || echo readonly; touch /tmp/probe && echo tmp-ok',
        );
        assert.match(probe, /readonly/, service);
        assert.match(probe, /tmp-ok/, service);
      }
    });
    await check('online SQLite backups preserve a consistent database', async () => {
      const result = compose(
        'exec',
        '-T',
        'auth-service',
        'node',
        '/app/scripts/backup.ts',
        'auth',
        '/app/data/backups',
      );
      assert.match(result, /Backup completed:/);
    });
    await check('service restarts preserve users, signing keys, orders and stock', async () => {
      compose('restart', 'auth-service', 'product-service', 'order-service');
      // The gateway caches aggregated health for 1s: wait it out so `healthy()` cannot
      // be satisfied by an "ok" that was measured before the restart.
      await sleep(1200);
      await healthy();
      assert.equal((await api('/auth/me', { token: userToken })).data.user.email, email);
      assert.equal(
        (await api(`/orders/${durableOrder.id}`, { token: userToken })).data.order.id,
        durableOrder.id,
      );
      assert.equal((await api(`/products/${product.id}`)).data.product.stock, 0);
    });
    await check(
      'product outage degrades gracefully and pending order recovers exactly once',
      async () => {
        const created = await api('/products', {
          method: 'POST',
          token: adminToken,
          body: { name: `Recovery ${prefix}`, price: 500, stock: 5 },
        });
        assert.equal(created.status, 201);
        const id = created.data.product.id;
        const key = randomUUID();
        const options = {
          method: 'POST',
          token: userToken,
          key,
          body: { items: [{ productId: id, quantity: 1 }] },
        };
        try {
          compose('stop', 'product-service');
          await sleep(1200);
          assert.equal((await api('/health')).status, 503);
          assert.equal((await api('/orders', options)).status, 503);
          // The gateway reports its unreachable upstream as 503, never as its own 500.
          const catalog = await api('/products');
          assert.equal(catalog.status, 503);
          assert.equal(catalog.data.error.code, 'UPSTREAM_UNAVAILABLE');
          assert.ok(catalog.headers.get('x-correlation-id'));
          // Services that do not depend on the failed one keep working.
          assert.equal((await api('/auth/me', { token: userToken })).status, 200);
        } finally {
          compose('start', 'product-service');
        }
        await healthy();
        await sleep(5500);
        const first = await api('/orders', options);
        assert.equal(first.status, 201);
        const second = await api('/orders', options);
        assert.equal(second.data.order.id, first.data.order.id);
        assert.equal((await api(`/products/${id}`)).data.product.stock, 4);
        assert.equal(
          (await api(`/products/${id}`, { method: 'DELETE', token: adminToken })).status,
          204,
        );
      },
    );
  }
  await check('admin product deletion and final readiness', async () => {
    assert.equal(
      (await api(`/products/${product.id}`, { method: 'DELETE', token: adminToken })).status,
      204,
    );
    assert.equal((await api(`/products/${product.id}`)).status, 404);
    await healthy();
  });
  if (process.argv.includes('--chaos')) {
    await check('container logs do not contain service or administrator secrets', async () => {
      const logs = compose('logs', '--no-color', '--since', startedAt);
      for (const secret of [process.env.INTERNAL_SERVICE_TOKEN, process.env.SEED_ADMIN_PASSWORD]) {
        if (secret) assert.equal(logs.includes(secret), false);
      }
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  mkdirSync('.e2e', { recursive: true });
  writeFileSync(
    '.e2e/results.json',
    JSON.stringify({ completedAt: new Date().toISOString(), checks }, null, 2),
  );
  console.log(
    `${checks.filter((check) => check.passed).length}/${checks.length} end-to-end checks passed`,
  );
}
