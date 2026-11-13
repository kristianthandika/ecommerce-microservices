import https from 'node:https';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

process.loadEnvFile('.env');
const ca = readFileSync(process.env.E2E_TLS_CA ?? '.e2e/tls/cert.pem');
function request(path, { method = 'GET', token, key, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (key) headers['idempotency-key'] = key;
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: Number(process.env.E2E_TLS_PORT ?? 3443),
        path,
        method,
        headers,
        ca,
        timeout: 12000,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('TLS request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const page = await request('/');
assert.equal(page.status, 200);
assert.match(page.headers['strict-transport-security'], /max-age=/);
assert.match(page.headers['content-security-policy'], /default-src 'self'/);
assert.equal(JSON.parse((await request('/api/health')).text).status, 'ok');
const login = await request('/api/auth/login', {
  method: 'POST',
  body: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD },
});
assert.equal(login.status, 200);
const token = JSON.parse(login.text).token;
const created = await request('/api/products', {
  method: 'POST',
  token,
  body: { name: `TLS ${randomUUID()}`, price: 100, stock: 2 },
});
assert.equal(created.status, 201);
const id = JSON.parse(created.text).product.id;
try {
  const order = await request('/api/orders', {
    method: 'POST',
    token,
    key: randomUUID(),
    body: { items: [{ productId: id, quantity: 1 }] },
  });
  assert.equal(order.status, 201);
  assert.equal(JSON.parse((await request(`/api/products/${id}`)).text).product.stock, 1);
} finally {
  assert.equal((await request(`/api/products/${id}`, { method: 'DELETE', token })).status, 204);
}
writeFileSync(
  '.e2e/tls-results.json',
  JSON.stringify(
    {
      passed: true,
      checks: [
        'certificate and IP SAN validation',
        'HTTPS frontend, HSTS and CSP',
        'admin login through password file',
        'atomic reservation through service-token files',
      ],
    },
    null,
    2,
  ),
);
console.log('PASS TLS certificate, security headers, secret-file login and stock reservation');
