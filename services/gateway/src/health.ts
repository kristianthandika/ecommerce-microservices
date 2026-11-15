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
    return res.ok ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

export async function aggregatedHealth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const entries = Object.entries(config.services);
  const results = await Promise.all(entries.map(([, url]) => probe(url, String(request.id))));

  const services: Record<string, Status> = {};
  entries.forEach(([name], i) => {
    services[name] = results[i];
  });

  const allUp = results.every((s) => s === 'up');
  reply.code(allUp ? 200 : 503).send({
    status: allUp ? 'ok' : 'degraded',
    gateway: 'up',
    services,
    timestamp: new Date().toISOString(),
  });
}
