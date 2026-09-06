import { createLogger } from '@ecommerce/logger';
import { config } from './config.js';
import { createApp } from './app.js';

const logger = createLogger(config.serviceName);
const app = createApp({ logger });
const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, productServiceUrl: config.productServiceUrl },
    `${config.serviceName} listening`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
  });
}
