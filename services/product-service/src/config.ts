/**
 * Konfigurasi product-service. URL antar-service dibaca dari env dengan default
 * localhost (Konvensi Konfigurasi Antar-Service) — JANGAN hardcode hostname
 * Docker di kode.
 */
export const config = {
  serviceName: 'product-service',
  port: Number(process.env.PORT || process.env.PRODUCT_SERVICE_PORT || 3002),
  authServiceUrl: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
  jwtIssuer: process.env.JWT_ISSUER || 'auth-service',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
} as const;
