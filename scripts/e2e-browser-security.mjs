import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Optional local browser check. Install Playwright separately, or point
// PLAYWRIGHT_MODULE at an existing playwright/index.mjs. Browser binaries must exist.
// Run only on a training stack: this creates a test account, product, and order.
try {
  process.loadEnvFile('.env');
} catch {
  /* CI can supply environment directly. */
}
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href
    : 'playwright'
);
const origin = process.env.E2E_BROWSER_ORIGIN ?? 'http://localhost:3000';
const base = `${origin}/api/v1`;
const run = randomUUID();
const email = `browser-${run}@test.local`;
const password = `Test-${randomUUID()}`;
const productName = `Browser security ${run.slice(0, 8)}`;
const checks = [];
const secrets = [
  password,
  process.env.SEED_ADMIN_PASSWORD,
  process.env.INTERNAL_SERVICE_TOKEN,
].filter(Boolean);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sanitize = (message) =>
  secrets.reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), String(message));
let browser, userContext, adminContext, adminToken, productId, orderId;
const pageErrors = [];
const cleanupErrors = [];

async function api(path, { token, method = 'GET', body } = {}, retries = 0) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 429 && retries < 2) {
    const seconds = Math.min(61, Math.max(1, Number(response.headers.get('retry-after') ?? 60)));
    await response.body?.cancel();
    await sleep(seconds * 1000);
    return api(path, { token, method, body }, retries + 1);
  }
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}
async function check(name, work) {
  const start = Date.now();
  try {
    await work();
    checks.push({ name, passed: true, milliseconds: Date.now() - start });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, passed: false, error: sanitize(error.message) });
    throw error;
  }
}
async function login(page, address, pass) {
  await page.goto(`${origin}/login`);
  await page.getByLabel('Email', { exact: true }).fill(address);
  await page.getByLabel('Password', { exact: true }).fill(pass);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await page.waitForURL('**/dashboard');
}

try {
  const admin = await api('/auth/login', {
    method: 'POST',
    body: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD },
  });
  assert.equal(admin.status, 200, 'Training admin login');
  adminToken = admin.data.token;
  secrets.push(adminToken);
  const created = await api('/products', {
    method: 'POST',
    token: adminToken,
    body: { name: productName, price: 12000, stock: 4 },
  });
  assert.equal(created.status, 201);
  productId = created.data.product.id;
  browser = await chromium.launch({ headless: true });
  userContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await userContext.newPage();
  const adminPage = await adminContext.newPage();
  for (const activePage of [page, adminPage]) {
    activePage.setDefaultTimeout(15000);
    activePage.on('pageerror', (error) => pageErrors.push(sanitize(error.message)));
  }

  await check('browser registration signs nobody in and only points to the mailbox', async () => {
    await page.goto(`${origin}/register`);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Daftar', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Periksa kotak masuk' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/register');
    assert.equal(
      (await userContext.cookies()).some((item) => item.name === 'refresh_token'),
      false,
    );
    // The account cannot sign in before its address was confirmed.
    await page.goto(`${origin}/login`);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Masuk', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Email atau password salah' }).waitFor();
  });

  await check(
    'mailed link activates with the password, removes the URL token and sets locked-down cookies',
    async () => {
      await login(adminPage, process.env.SEED_ADMIN_EMAIL, process.env.SEED_ADMIN_PASSWORD);
      await adminPage.goto(`${origin}/admin/outbox`);
      await adminPage
        .getByRole('heading', { name: 'Kotak surat pelatihan', exact: true })
        .waitFor();
      const message = adminPage.getByRole('listitem').filter({ hasText: email });
      const link = await message
        .getByRole('link', { name: 'Buka tautan verifikasi' })
        .getAttribute('href');
      assert.ok(link);
      const target = new URL(link);
      assert.equal(target.pathname, '/verify-email');
      const verificationToken = new URLSearchParams(target.hash.slice(1)).get('token');
      assert.ok(verificationToken);
      secrets.push(verificationToken, link);
      await page.goto(link);
      await page.getByRole('button', { name: 'Aktifkan akun', exact: true }).waitFor();
      assert.equal(new URL(page.url()).hash, '');
      // The link alone activated nothing.
      const withoutPassword = await api('/auth/verify-email', {
        method: 'POST',
        body: { token: verificationToken },
      });
      assert.equal(withoutPassword.status, 400);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Aktifkan akun', exact: true }).click();
      await page.waitForURL('**/dashboard');
      await page.reload();
      await page.getByRole('textbox', { name: 'Cari produk' }).waitFor();
      for (const name of ['refresh_token', 'device_id']) {
        const cookie = (await userContext.cookies()).find((item) => item.name === name);
        assert.ok(cookie?.httpOnly && cookie.secure, name);
        assert.equal(cookie.sameSite, 'Strict');
        assert.equal(cookie.path, '/api/v1/auth');
        assert.equal(await page.evaluate((key) => document.cookie.includes(key), name), false);
      }
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      const repeated = await api('/auth/verify-email', {
        method: 'POST',
        body: { token: verificationToken, password },
      });
      assert.equal(repeated.status, 400);
    },
  );

  await check('signed-in browser fills the cart', async () => {
    await page.getByRole('textbox', { name: 'Cari produk' }).fill(productName);
    await page.getByRole('button', { name: 'Cari', exact: true }).click();
    const article = page.getByRole('article').filter({ hasText: productName });
    await article.getByRole('button', { name: 'Tambah ke keranjang' }).click();
    await page.getByRole('link', { name: 'Buka keranjang', exact: true }).click();
    await page.getByRole('link', { name: 'Lanjut ke checkout' }).click();
    await page.getByRole('heading', { name: 'Checkout', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Konfirmasi pesanan' }).isDisabled(),
      false,
    );
    assert.equal((await api(`/products/${productId}`)).data.product.stock, 4);
  });
  await check('verified browser checkout confirms one order and deducts one unit', async () => {
    await page.goto(`${origin}/checkout`);
    await page.getByLabel('Nama penerima', { exact: true }).fill('Pembeli Browser');
    await page.getByLabel('Nomor telepon', { exact: true }).fill('081234567890');
    await page.getByLabel('Alamat lengkap', { exact: true }).fill('Jalan Pengujian 123');
    await page.getByLabel('Kota / kabupaten', { exact: true }).fill('Bandung');
    await page.getByLabel('Provinsi', { exact: true }).fill('Jawa Barat');
    await page.getByLabel('Kode pos', { exact: true }).fill('40123');
    const resultPromise = page.waitForResponse(
      (response) =>
        response.url().endsWith('/cart/checkout') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Konfirmasi pesanan' }).click();
    const result = await resultPromise;
    assert.equal(result.status(), 201);
    const { order } = await result.json();
    orderId = order.id;
    assert.equal(order.status, 'CONFIRMED');
    await page.getByRole('heading', { name: 'Detail pesanan', exact: true }).waitFor();
    assert.equal((await api(`/products/${productId}`)).data.product.stock, 3);
  });

  await check('320px header menu and footer fit the browser viewport', async () => {
    await page.goto(`${origin}/dashboard`);
    await page.getByRole('heading', { name: 'Katalog Produk', exact: true }).waitFor();
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole('button', { name: 'Buka menu navigasi', exact: true }).click();
    const menu = page.getByRole('navigation', { name: 'Navigasi seluler' });
    await menu.waitFor();
    await menu.getByRole('link').first().focus();
    await page.keyboard.press('Escape');
    assert.equal(
      await page
        .getByRole('button', { name: 'Buka menu navigasi', exact: true })
        .getAttribute('aria-expanded'),
      'false',
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    assert.ok(overflow <= 1, `Horizontal overflow: ${overflow}px`);
    await page.locator('footer').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('footer').isVisible(), true);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  await check('browser logout survives reload and removes refresh cookie', async () => {
    const logoutResponse = page.waitForResponse((response) =>
      response.url().endsWith('/auth/logout'),
    );
    await page.getByRole('button', { name: 'Keluar', exact: true }).click();
    assert.equal((await logoutResponse).status(), 204);
    await page.waitForURL('**/login');
    await page.reload();
    await page.getByRole('heading', { name: 'Masuk', exact: true }).waitFor();
    assert.equal(
      (await userContext.cookies()).some((item) => item.name === 'refresh_token'),
      false,
    );
    assert.equal(pageErrors.length, 0, 'Browser page errors');
  });
} catch (error) {
  console.error(sanitize(error.message));
  process.exitCode = 1;
} finally {
  if (orderId && adminToken) {
    try {
      const cancelled = await api(`/orders/admin/${orderId}/cancel`, {
        method: 'POST',
        token: adminToken,
      });
      assert.ok(
        [200, 202].includes(cancelled.status),
        `Cleanup cancellation status ${cancelled.status}`,
      );
    } catch (error) {
      cleanupErrors.push(sanitize(error.message));
    }
  }
  if (productId && adminToken) {
    try {
      const removed = await api(`/products/${productId}`, { method: 'DELETE', token: adminToken });
      assert.equal(removed.status, 204, 'Cleanup product deletion');
    } catch (error) {
      cleanupErrors.push(sanitize(error.message));
    }
  }
  await browser?.close();
  if (cleanupErrors.length) {
    process.exitCode = 1;
    for (const message of cleanupErrors) console.error(message);
  }
  mkdirSync('.e2e', { recursive: true });
  writeFileSync(
    '.e2e/browser-security-results.json',
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        browser: 'Chromium',
        checks,
        pageErrors,
        cleanupErrors,
        passed:
          checks.length === 6 && checks.every((item) => item.passed) && cleanupErrors.length === 0,
      },
      null,
      2,
    ),
  );
  console.log(
    `${checks.filter((item) => item.passed).length}/${checks.length} browser security checks passed`,
  );
}
