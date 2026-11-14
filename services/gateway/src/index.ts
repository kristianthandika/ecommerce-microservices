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

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down gateway');
  // Batas waktu sama seperti service lain: koneksi yang menggantung tidak boleh
  // menahan container sampai Docker mengirim SIGKILL.
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try {
    await app.close();
    await shutdownTracing();
    process.exit(0);
  } catch (err) {
    app.log.error(err, 'gagal shutdown dengan bersih');
    process.exit(1);
  }
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  // `shutdown` menangani error-nya sendiri dan selalu mengakhiri proses.
  process.once(signal, () => void shutdown(signal));
}
