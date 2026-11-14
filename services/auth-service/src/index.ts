import { createLogger } from '@ecommerce/logger';
import { config } from './config.ts';
import { createApp } from './app.ts';
import { getKeyMaterial } from './keys.ts';
import { seedAdmin } from './users.ts';
import { purgeExpiredSessions } from './sessions.ts';
import { purgeExpiredVerifications } from './verification.ts';
import { purgeExpiredMail } from './mailer.ts';

const logger = createLogger(config.serviceName);

// Pastikan keypair siap (load-or-generate) sebelum menerima request.
const { kid } = getKeyMaterial();
logger.info({ kid }, 'keypair RS256 siap');

await seedAdmin(logger);

const app = createApp({ logger });
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, `${config.serviceName} listening`);
});

if (config.emailVerification.required && config.mail.transport === 'outbox')
  logger.warn(
    'MAIL_TRANSPORT=outbox: email verifikasi terbaca administrator lewat /admin/outbox — HANYA untuk pelatihan',
  );

// Retensi: refresh token, keluarga sesi, daftar pencabutan, penghitung gagal login,
// token verifikasi email, dan outbox yang kedaluwarsa.
const retention = setInterval(() => {
  try {
    logger.debug(
      {
        sessions: purgeExpiredSessions(),
        verifications: purgeExpiredVerifications(),
        mail: purgeExpiredMail(),
      },
      'retensi sesi',
    );
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
