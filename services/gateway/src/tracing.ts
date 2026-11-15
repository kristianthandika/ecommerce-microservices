import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import type { FastifyPluginCallback } from 'fastify';

/**
 * Distributed tracing PENGANTAR (m3.3) — level dasar sesuai silabus, BUKAN
 * backend tracing penuh (Jaeger/Zipkin). Span dicetak ke CONSOLE via
 * ConsoleSpanExporter.
 *
 * WAJIB pakai `@fastify/otel` untuk instrumentasi Fastify — BUKAN
 * `@opentelemetry/instrumentation-fastify` (deprecated sejak Juni 2025) dan
 * JANGAN berasumsi `auto-instrumentations-node` meng-cover Fastify (versi
 * terbaru sudah DROP dukungan Fastify → tracing gateway gagal DIAM-DIAM).
 */
const fastifyOtel = new FastifyOtelInstrumentation({
  servername: 'gateway',
  registerOnInitialization: false,
});

let sdk: NodeSDK | undefined;

export function startTracing(): NodeSDK {
  if (sdk) return sdk;
  sdk = new NodeSDK({
    serviceName: 'gateway',
    traceExporter: new ConsoleSpanExporter(),
    instrumentations: [fastifyOtel],
  });
  sdk.start();
  return sdk;
}

export function getFastifyOtelPlugin(): FastifyPluginCallback {
  return fastifyOtel.plugin() as unknown as FastifyPluginCallback;
}

export async function shutdownTracing(): Promise<void> {
  if (sdk) await sdk.shutdown();
}
