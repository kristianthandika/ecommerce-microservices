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
  // Umur maksimum daftar sesi yang dicabut sebelum diambil ulang dari auth-service:
  // batas atas jeda antara logout dan penolakan access token di service ini.
  revocationMaxAgeMs: Number(process.env.REVOCATION_MAX_AGE_MS || 5000),
} as const;

if (
  !Number.isInteger(config.revocationMaxAgeMs) ||
  config.revocationMaxAgeMs < 500 ||
  config.revocationMaxAgeMs > 60_000
)
  throw new Error('REVOCATION_MAX_AGE_MS must be an integer between 500 and 60000');
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.DATA_DIR || config.internalServiceToken.length < 32)
)
  throw new Error('DATA_DIR and INTERNAL_SERVICE_TOKEN (32+ characters) are required');
