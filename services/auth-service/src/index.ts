import { createLogger } from '@ecommerce/logger';
import { config } from './config.ts';
import { createApp } from './app.ts';
import { getKeyMaterial } from './keys.ts';
import { seedAdmin } from './users.ts';
import { purgeExpiredSessions } from './sessions.ts';

const logger = createLogger(config.serviceName);

// Pastikan keypair siap (load-or-generate) sebelum menerima request.
const { kid } = getKeyMaterial();
logger.info({ kid }, 'keypair RS256 siap');

await seedAdmin(logger);

const app = createApp({ logger });
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, `${config.serviceName} listening`);
});

// Retensi: refresh token, keluarga sesi, dan penghitung gagal login yang kedaluwarsa.
const retention = setInterval(() => {
  try {
    logger.debug({ result: purgeExpiredSessions() }, 'retensi sesi');
  } catch (err) {
    logger.error({ err }, 'retensi sesi gagal');
  }
}, 10 * 60_000);
retention.unref();

// Graceful shutdown supaya container berhenti rapi.
server.requestTimeout = 15000;
server.headersTimeout = 10000;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(retention);
    logger.info({ signal }, 'shutting down');
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    server.close(() => process.exit(0));
  });
}
