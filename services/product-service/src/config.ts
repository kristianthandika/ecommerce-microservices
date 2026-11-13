import { readSecret } from '@ecommerce/storage';
/**
 * Konfigurasi product-service. URL antar-service dibaca dari env dengan default
 * localhost (Konvensi Konfigurasi Antar-Service) — JANGAN hardcode hostname
 * Docker di kode.
 */
export const config = {
  internalServiceToken: readSecret('INTERNAL_SERVICE_TOKEN'),
  serviceName: 'product-service',
  port: Number(process.env.PORT || process.env.PRODUCT_SERVICE_PORT || 3002),
  authServiceUrl: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
  jwtIssuer: process.env.JWT_ISSUER || 'auth-service',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
} as const;

if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.DATA_DIR || config.internalServiceToken.length < 32)
)
  throw new Error('DATA_DIR and INTERNAL_SERVICE_TOKEN (32+ characters) are required');
