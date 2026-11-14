import { readSecret } from '@ecommerce/storage';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Konfigurasi service dari environment variable, dengan default aman untuk
 * pengembangan lokal. Port listen dibaca dari `PORT` (di-set Docker Compose)
 * atau `AUTH_SERVICE_PORT`, default 3001.
 */
export const config = {
  serviceName: 'auth-service',
  port: Number(process.env.PORT || process.env.AUTH_SERVICE_PORT || 3001),
  // Folder penyimpanan keypair RSA — di-mount sebagai Docker volume di m4.4.
  keysDir: process.env.KEYS_DIR || resolve(__dirname, '..', 'keys'),
  jwt: {
    issuer: process.env.JWT_ISSUER || 'auth-service',
    // Pendek: token yang sudah terbit tidak bisa dicabut, jadi masa berlakunya
    // adalah jendela terlama akses setelah logout/pencabutan sesi.
    expiresInSeconds: Number(process.env.JWT_EXPIRES_IN_SECONDS || 900),
  },
  refresh: {
    // Sliding: setiap rotasi memberi masa berlaku baru, dibatasi umur keluarga.
    ttlMs: Number(process.env.REFRESH_TTL_HOURS || 168) * 3_600_000,
    familyMaxMs: Number(process.env.REFRESH_FAMILY_MAX_HOURS || 720) * 3_600_000,
    // Dua tab yang me-refresh bersamaan bukan pencurian: token yang baru dirotasi
    // masih dikenali sebentar tanpa mencabut sesi.
    reuseGraceMs: 10_000,
    cookieName: 'refresh_token',
    // Path yang DILIHAT BROWSER (nginx/Vite menambahkan prefix /api).
    cookiePath: process.env.REFRESH_COOKIE_PATH || '/api/v1/auth',
    cookieSecure: process.env.REFRESH_COOKIE_SECURE !== 'false',
    allowedOrigins: (
      process.env.REFRESH_ALLOWED_ORIGINS ||
      'http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173'
    )
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  },
  loginThrottle: {
    freeFailures: 5,
    baseDelayMs: 30_000,
    maxDelayMs: 15 * 60_000,
    windowMs: 15 * 60_000,
  },
  bcryptSaltRounds: Number(process.env.BCRYPT_SALT_ROUNDS || 10),
  // Kredensial admin demo (HANYA untuk training — lihat DECISIONS.md).
  seedAdmin: {
    enabled: process.env.SEED_ADMIN_ENABLED === 'true',
    email: process.env.SEED_ADMIN_EMAIL || '',
    password: readSecret('SEED_ADMIN_PASSWORD'),
  },
  // Origin frontend yang diizinkan CORS saat service diakses langsung.
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
} as const;

if (
  !Number.isInteger(config.bcryptSaltRounds) ||
  config.bcryptSaltRounds < 10 ||
  config.bcryptSaltRounds > 14
)
  throw new Error('BCRYPT_SALT_ROUNDS must be 10-14');
if (process.env.NODE_ENV === 'production' && !process.env.DATA_DIR)
  throw new Error('DATA_DIR is required in production');
for (const [name, value, min, max] of [
  ['JWT_EXPIRES_IN_SECONDS', config.jwt.expiresInSeconds, 60, 3600],
  ['REFRESH_TTL_HOURS', config.refresh.ttlMs / 3_600_000, 1, 2160],
  ['REFRESH_FAMILY_MAX_HOURS', config.refresh.familyMaxMs / 3_600_000, 1, 8760],
] as const) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
}
if (config.refresh.ttlMs > config.refresh.familyMaxMs)
  throw new Error('REFRESH_TTL_HOURS must not exceed REFRESH_FAMILY_MAX_HOURS');
