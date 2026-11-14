import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildRouter } from '../src/routes.ts';

/**
 * OWASP API9 (inventory): the published OpenAPI document and this service's router
 * must describe the same public endpoints. A new route without documentation, or
 * documentation for a route that no longer exists, fails here.
 */
const spec = JSON.parse(
  readFileSync(new URL('../../gateway/openapi.json', import.meta.url), 'utf8'),
) as { paths: Record<string, Record<string, unknown>> };
type Layer = { route?: { path: string; methods: Record<string, boolean> } };

/** Public path (as the gateway exposes it) for a router path, or null if not exposed. */
// Gateway: /auth/* → auth-service /* (every route, health and JWKS included).
const expose = (path: string): string | null => `/auth${path}`;
const owned = (path: string) => path.startsWith('/auth/');

const toSpecPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');
const routerOperations = (buildRouter() as unknown as { stack: Layer[] }).stack
  .filter((layer) => layer.route)
  .flatMap(({ route }) =>
    Object.keys(route!.methods)
      .filter((method) => method !== '_all')
      .map((method) => ({ method, path: route!.path })),
  );
const methods = ['get', 'put', 'post', 'delete', 'patch'];

describe('OpenAPI coverage for auth-service', () => {
  it('documents every route the gateway exposes', () => {
    const exposed = routerOperations.flatMap(({ method, path }) => {
      const publicPath = expose(path);
      return publicPath ? [`${method.toUpperCase()} ${toSpecPath(publicPath)}`] : [];
    });
    expect(exposed.length).toBeGreaterThan(0);
    for (const operation of exposed) {
      const [method, path] = operation.split(' ');
      expect(spec.paths[path]?.[method.toLowerCase()], operation).toBeDefined();
    }
  });

  it('documents nothing that this service does not implement', () => {
    const implemented = new Set(
      routerOperations.flatMap(({ method, path }) => {
        const publicPath = expose(path);
        return publicPath ? [`${method.toUpperCase()} ${toSpecPath(publicPath)}`] : [];
      }),
    );
    for (const [path, item] of Object.entries(spec.paths)) {
      if (!owned(path)) continue;
      for (const method of methods.filter((m) => item[m]))
        expect(implemented.has(`${method.toUpperCase()} ${path}`), `${method} ${path}`).toBe(true);
    }
  });
});
