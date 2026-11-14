import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

/**
 * API inventory (OWASP API9): one current version under /v1, unversioned paths kept
 * as announced aliases, and a machine-readable description that is structurally sound.
 */
type Spec = {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components: Record<string, Record<string, unknown>>;
};
const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as Spec;

let app: FastifyInstance;
const doubles: Server[] = [];
const echo = (name: string) =>
  createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ service: name, path: req.url }));
  });
const listen = (server: Server): Promise<string> =>
  new Promise((resolve) =>
    server.listen(0, () => {
      doubles.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }),
  );

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.AUTH_SERVICE_URL = await listen(echo('auth'));
  process.env.PRODUCT_SERVICE_URL = await listen(echo('product'));
  process.env.ORDER_SERVICE_URL = await listen(echo('order'));
  const { buildApp } = await import('../src/app.ts');
  app = await buildApp({ enableTracing: false });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  for (const server of doubles) await new Promise((resolve) => server.close(resolve));
});

describe('versioned routing', () => {
  it('routes /v1 to the same upstream paths without deprecation headers', async () => {
    for (const [url, service, path] of [
      ['/v1/products?q=mug', 'product', '/products?q=mug'],
      ['/v1/auth/login', 'auth', '/login'],
      ['/v1/orders/admin/summary', 'order', '/orders/admin/summary'],
      ['/v1/cart/items/x', 'order', '/cart/items/x'],
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.json(), url).toEqual({ service, path });
      expect(response.headers.deprecation).toBeUndefined();
    }
  });

  it('keeps unversioned paths working, marked deprecated with a successor and sunset', async () => {
    const response = await app.inject({ method: 'GET', url: '/products?q=mug' });
    expect(response.json()).toEqual({ service: 'product', path: '/products?q=mug' });
    expect(response.headers.deprecation).toBe(`@${Date.UTC(2026, 10, 14) / 1000}`);
    expect(response.headers.sunset).toBe('Fri, 14 May 2027 00:00:00 GMT');
    expect(response.headers.link).toBe('</api/v1/products?q=mug>; rel="successor-version"');
  });

  it('serves aggregated health under /v1 as well as at the root', async () => {
    for (const url of ['/health', '/v1/health']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.json().services, url).toBeDefined();
    }
  });

  it('answers unknown versions with the uniform 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/v2/products' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('serves the OpenAPI document it was built with', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual(spec);
  });
});

describe('OpenAPI document', () => {
  const methods = ['get', 'put', 'post', 'delete', 'patch'];
  const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
    methods
      .filter((method) => item[method])
      .map((method) => ({ path, method, item, op: item[method] as Record<string, unknown> })),
  );

  it('is OpenAPI 3.1 and every $ref resolves', () => {
    expect(spec.openapi).toBe('3.1.0');
    const refs: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object')
        for (const [key, inner] of Object.entries(value)) {
          if (key === '$ref') refs.push(String(inner));
          else walk(inner);
        }
    };
    walk(spec);
    expect(refs.length).toBeGreaterThan(50);
    for (const ref of new Set(refs)) {
      const [, section, name] = /^#\/components\/(\w+)\/(.+)$/.exec(ref) ?? [];
      expect(spec.components[section]?.[name], ref).toBeDefined();
    }
  });

  it('declares every path parameter and gives each operation a unique id, tags and responses', () => {
    const ids = operations.map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { path, method, item, op } of operations) {
      const declared = [
        ...((item.parameters as { name: string; in: string }[]) ?? []),
        ...((op.parameters as { name: string; in: string }[]) ?? []),
      ];
      for (const [, name] of path.matchAll(/\{(\w+)\}/g))
        expect(
          declared.some((parameter) => parameter.name === name && parameter.in === 'path'),
          `${method} ${path}`,
        ).toBe(true);
      expect((op.tags as string[]).length, `${method} ${path}`).toBeGreaterThan(0);
      expect(Object.keys(op.responses as object).length).toBeGreaterThan(0);
      for (const requirement of (op.security as Record<string, unknown>[]) ?? [])
        for (const scheme of Object.keys(requirement))
          expect(spec.components.securitySchemes[scheme], scheme).toBeDefined();
    }
  });

  it('documents only what the gateway exposes', () => {
    for (const path of Object.keys(spec.paths))
      expect(path, path).toMatch(/^\/(auth|products|orders|cart)(\/|$)|^\/(openapi\.json|health)$/);
    // Internal service-to-service routes must never appear in the public description.
    expect(JSON.stringify(spec.paths)).not.toContain('/internal');
  });
});
