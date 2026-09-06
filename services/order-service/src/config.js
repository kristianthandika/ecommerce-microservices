/**
 * Konfigurasi order-service. Semua URL antar-service dari env (default
 * localhost) — Konvensi Konfigurasi Antar-Service.
 */
export const config = {
  serviceName: 'order-service',
  port: Number(process.env.PORT || process.env.ORDER_SERVICE_PORT || 3003),
  authServiceUrl: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
  productServiceUrl: process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002',
  jwtIssuer: process.env.JWT_ISSUER || 'auth-service',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  // Parameter resilience untuk panggilan ke product-service.
  resilience: {
    timeoutMs: Number(process.env.PRODUCT_TIMEOUT_MS || 1500),
    retries: Number(process.env.PRODUCT_RETRIES || 2),
    baseDelayMs: Number(process.env.PRODUCT_RETRY_BASE_MS || 100),
    failureThreshold: Number(process.env.PRODUCT_CB_THRESHOLD || 3),
    resetTimeoutMs: Number(process.env.PRODUCT_CB_RESET_MS || 5000),
  },
};
