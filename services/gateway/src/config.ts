/**
 * Konfigurasi gateway. Target proxy dibaca dari env yang SAMA seperti dipakai
 * service lain (Konvensi Konfigurasi Antar-Service) — JANGAN hardcode.
 */
export const config = {
  serviceName: 'gateway',
  port: Number(process.env.PORT || process.env.GATEWAY_PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  services: {
    auth: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
    product: process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002',
    order: process.env.ORDER_SERVICE_URL || 'http://localhost:3003',
  },
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  rateLimit: {
    max: Number(process.env.GATEWAY_RATE_LIMIT_MAX || 100),
    timeWindow: process.env.GATEWAY_RATE_LIMIT_WINDOW || '1 minute',
  },
  healthTimeoutMs: Number(process.env.HEALTH_TIMEOUT_MS || 1000),
} as const;

// Gagal cepat saat start: nilai env yang salah ketik (mis. "10O") menjadi NaN dan
// tanpa pengecekan ini limiter/timeout diam-diam tidak berfungsi.
for (const [name, value, max] of [
  ['GATEWAY_RATE_LIMIT_MAX', config.rateLimit.max, 1_000_000],
  ['HEALTH_TIMEOUT_MS', config.healthTimeoutMs, 60_000],
  ['PORT', config.port, 65_535],
] as const) {
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`Invalid gateway setting: ${name}`);
}
