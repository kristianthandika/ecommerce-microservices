import { readSecret } from '@ecommerce/storage';
/**
 * Konfigurasi order-service. Semua URL antar-service dari env (default
 * localhost) — Konvensi Konfigurasi Antar-Service.
 */
export const config = {
  internalServiceToken: readSecret('INTERNAL_SERVICE_TOKEN'),
  serviceName: 'order-service',
  port: Number(process.env.PORT || process.env.ORDER_SERVICE_PORT || 3003),
  authServiceUrl: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
  productServiceUrl: process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002',
  jwtIssuer: process.env.JWT_ISSUER || 'auth-service',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  // Berapa lama Idempotency-Key diingat setelah order-nya selesai (jam → ms).
  idempotencyRetentionMs: Number(process.env.IDEMPOTENCY_RETENTION_HOURS || 24) * 3_600_000,
  // Parameter resilience untuk panggilan ke product-service.
  resilience: {
    timeoutMs: Number(process.env.PRODUCT_TIMEOUT_MS || 1500),
    retries: Number(process.env.PRODUCT_RETRIES || 2),
    baseDelayMs: Number(process.env.PRODUCT_RETRY_BASE_MS || 100),
    failureThreshold: Number(process.env.PRODUCT_CB_THRESHOLD || 3),
    resetTimeoutMs: Number(process.env.PRODUCT_CB_RESET_MS || 5000),
  },
} as const;

for (const [name, value] of Object.entries(config.resilience)) {
  if (
    !Number.isInteger(value) ||
    value < (name === 'retries' ? 0 : 1) ||
    value > (name === 'retries' ? 5 : 60000)
  )
    throw new Error(`Invalid resilience setting: ${name}`);
}
if (
  !Number.isInteger(config.idempotencyRetentionMs) ||
  config.idempotencyRetentionMs < 3_600_000 ||
  config.idempotencyRetentionMs > 720 * 3_600_000
)
  throw new Error('IDEMPOTENCY_RETENTION_HOURS must be an integer between 1 and 720');
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.DATA_DIR || config.internalServiceToken.length < 32)
)
  throw new Error('DATA_DIR and INTERNAL_SERVICE_TOKEN (32+ characters) are required');
