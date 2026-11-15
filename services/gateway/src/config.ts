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
  // Batas menerima satu request utuh dari klien, dan batas menunggu jawaban upstream.
  requestTimeoutMs: Number(process.env.GATEWAY_REQUEST_TIMEOUT_MS || 15_000),
  upstreamTimeoutMs: Number(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS || 15_000),
  api: {
    // Prefix publik di depan gateway (nginx/Vite memotongnya sebelum meneruskan).
    // Dipakai untuk header Link yang menunjuk ke versi pengganti.
    publicPrefix: process.env.PUBLIC_API_PREFIX ?? '/api',
    legacy: {
      // Jalur tanpa versi (/api/products, ...) tetap dilayani sampai tanggal sunset.
      enabled: process.env.LEGACY_API_ENABLED !== 'false',
      deprecatedAt: '2026-11-14T00:00:00Z',
      sunset: process.env.LEGACY_API_SUNSET || '2027-05-14T00:00:00Z',
    },
  },
} as const;

// Gagal cepat saat start: nilai env yang salah ketik (mis. "10O") menjadi NaN dan
// tanpa pengecekan ini limiter/timeout diam-diam tidak berfungsi.
for (const [name, value, max] of [
  ['GATEWAY_RATE_LIMIT_MAX', config.rateLimit.max, 1_000_000],
  ['HEALTH_TIMEOUT_MS', config.healthTimeoutMs, 60_000],
  ['GATEWAY_REQUEST_TIMEOUT_MS', config.requestTimeoutMs, 300_000],
  ['GATEWAY_UPSTREAM_TIMEOUT_MS', config.upstreamTimeoutMs, 300_000],
  ['PORT', config.port, 65_535],
] as const) {
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`Invalid gateway setting: ${name}`);
}
if (Number.isNaN(Date.parse(config.api.legacy.sunset)))
  throw new Error('Invalid gateway setting: LEGACY_API_SUNSET must be an ISO date');
if (config.api.publicPrefix && !/^\/[A-Za-z0-9/_-]*[^/]$/.test(config.api.publicPrefix))
  throw new Error('Invalid gateway setting: PUBLIC_API_PREFIX must look like /api');
