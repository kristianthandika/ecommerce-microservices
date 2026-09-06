import { config } from './config.ts';
import { startTracing, shutdownTracing } from './tracing.ts';
import { buildApp } from './app.ts';

// Mulai tracing SEBELUM app dibuat supaya instrumentasi aktif.
startTracing();

const app = await buildApp({ enableTracing: true });

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err, 'gagal start gateway');
  process.exit(1);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'shutting down gateway');
    await app.close();
    await shutdownTracing();
    process.exit(0);
  });
}
