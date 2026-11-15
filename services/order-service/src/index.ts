import {
  recoverPendingOrders,
  purgeExpiredIdempotency,
  scheduleLegacyIdempotency,
} from './orders.ts';
import { createLogger } from '@ecommerce/logger';
import { config } from './config.ts';
import { createApp } from './app.ts';

const logger = createLogger(config.serviceName);
const app = createApp({ logger });
const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, productServiceUrl: config.productServiceUrl },
    `${config.serviceName} listening`,
  );
});

const recovery = setInterval(() => {
  void recoverPendingOrders();
}, 10000);
recovery.unref();
void recoverPendingOrders();

// Retensi Idempotency-Key: record lama diberi jadwal sekali, lalu disapu berkala.
const legacy = scheduleLegacyIdempotency();
if (legacy) logger.info({ records: legacy }, 'jadwal retensi diberikan ke record idempotency lama');
const retention = setInterval(() => {
  try {
    const result = purgeExpiredIdempotency();
    logger.debug({ result }, 'retensi idempotency');
  } catch (err) {
    logger.error({ err }, 'retensi idempotency gagal');
  }
}, 10 * 60_000);
retention.unref();

server.requestTimeout = 15000;
server.headersTimeout = 10000;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(recovery);
    clearInterval(retention);
    logger.info({ signal }, 'shutting down');
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    server.close(() => process.exit(0));
  });
}
