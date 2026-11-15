import { config } from './config.ts';
import { buildApp } from './app.ts';

// m3.1/m3.2 — belum ada tracing (ditambahkan di m3.3).
const app = await buildApp();

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
    process.exit(0);
  });
}
