import type { FastifyRequest, FastifyReply } from 'fastify';
import { withTimeout } from '@ecommerce/resilient-http-client';
import { CORRELATION_ID_HEADER } from '@ecommerce/logger';
import { config } from './config.ts';

type Status = 'up' | 'down';

/**
 * Aggregated health check (m3.3): panggil `/health` tiap service (dengan
 * timeout) lalu agregasi. Status keseluruhan `ok` kalau semua up, `degraded`
 * kalau ada yang down. HTTP 200 kalau ok, 503 kalau degraded.
 */
const fetchWithTimeout = withTimeout(fetch, config.healthTimeoutMs);

async function probe(url: string, correlationId: string): Promise<Status> {
  try {
    const res = await fetchWithTimeout(`${url}/health`, {
      headers: { [CORRELATION_ID_HEADER]: correlationId },
    });
    const body = (await res.json()) as { status?: string };
    return res.ok && body.status === 'ok' ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

let cached: { services: Record<string, Status>; allUp: boolean; expires: number } | undefined;
let pending:
  Promise<{ services: Record<string, Status>; allUp: boolean; expires: number }> | undefined;
export async function aggregatedHealth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!cached || cached.expires < Date.now()) {
    pending ??= (async () => {
      const entries = Object.entries(config.services);
      const results = await Promise.all(entries.map(([, url]) => probe(url, String(request.id))));
      return {
        services: Object.fromEntries(entries.map(([name], i) => [name, results[i]])),
        allUp: results.every((status) => status === 'up'),
        expires: Date.now() + 1000,
      };
    })();
    try {
      cached = await pending;
    } finally {
      pending = undefined;
    }
  }
  const { services, allUp } = cached;
  reply.code(allUp ? 200 : 503).send({
    status: allUp ? 'ok' : 'degraded',
    gateway: 'up',
    services,
    timestamp: new Date().toISOString(),
  });
}
