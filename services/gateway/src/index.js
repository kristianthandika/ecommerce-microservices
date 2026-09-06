import { config } from './config.js';
import { startTracing, shutdownTracing } from './tracing.js';
import { buildApp } from './app.js';

// Mulai tracing SEBELUM app dibuat supaya instrumentasi aktif.
startTracing();

const app = await buildApp({ enableTracing: true });

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err, 'gagal start gateway');
  process.exit(1);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'shutting down gateway');
    await app.close();
    await shutdownTracing();
    process.exit(0);
  });
}
