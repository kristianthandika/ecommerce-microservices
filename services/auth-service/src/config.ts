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
  // Dipakai service lain untuk mengambil daftar sesi yang dicabut (route internal).
  internalServiceToken: readSecret('INTERNAL_SERVICE_TOKEN'),
  port: Number(process.env.PORT || process.env.AUTH_SERVICE_PORT || 3001),
  // Folder penyimpanan keypair RSA — di-mount sebagai Docker volume di m4.4.
  keysDir: process.env.KEYS_DIR || resolve(__dirname, '..', 'keys'),
  jwt: {
    issuer: process.env.JWT_ISSUER || 'auth-service',
    // Daftar pencabutan harus segar untuk menerima token di service lain.
    // Jika auth tidak terjangkau setelah cache basi, request terproteksi dijawab 503.
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
  emailVerification: {
    // Akun baru baru bisa masuk setelah emailnya diverifikasi (OWASP API2/API6). Bila
    // dimatikan (hanya untuk pengembangan lokal), akun langsung aktif dan perlindungan
    // terhadap penebakan akun lewat pendaftaran tidak berlaku.
    required: process.env.EMAIL_VERIFICATION_REQUIRED !== 'false',
    // Juga umur akun yang belum diverifikasi: setelah itu akunnya dihapus.
    ttlMs: 24 * 3_600_000,
    // Salah password sebanyak ini membuat satu tautan tidak berlaku lagi.
    maxPasswordAttempts: 5,
  },
  passwordReset: {
    ttlMs: 60 * 60_000,
  },
  // "Device cookie" (rekomendasi OWASP): browser yang pernah berhasil masuk tidak
  // ikut terkunci oleh backoff per email, sehingga penyerang tidak bisa menahan
  // login korban hanya dengan mengirim password salah.
  device: {
    cookieName: 'device_id',
    ttlMs: 90 * 24 * 3_600_000,
    maxFailures: 5,
  },
  mail: {
    // 'outbox' = disimpan di database dan terbaca admin (pelatihan/lokal saja);
    // 'webhook' = POST JSON ke layanan email milik operator. Di production wajib dipilih.
    transport: (process.env.MAIL_TRANSPORT ||
      (process.env.NODE_ENV === 'production' ? '' : 'outbox')) as 'outbox' | 'webhook' | '',
    allowInsecureOutbox: process.env.MAIL_ALLOW_INSECURE_OUTBOX === 'true',
    webhookUrl: process.env.MAIL_WEBHOOK_URL || '',
    webhookToken: readSecret('MAIL_WEBHOOK_TOKEN'),
    // Alamat frontend yang dilihat pengguna; dasar tautan di dalam email.
    publicAppUrl: (process.env.PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    // Paling banyak satu email per jenis per alamat dalam jangka ini. Permintaan
    // berikutnya dilewati tanpa pemberitahuan, supaya endpoint publik tidak bisa
    // dipakai membanjiri kotak masuk dan jawabannya tidak membocorkan apa pun.
    cooldownMs: 60_000,
    // Dan paling banyak sekian per jenis per alamat dalam 24 jam: pendaftaran dan
    // lupa password selalu "berhasil", jadi tanpa batas ini siapa pun bisa mengirimi
    // satu alamat sebuah email setiap menit, selamanya.
    dailyLimit: 10,
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
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.DATA_DIR || config.internalServiceToken.length < 32)
)
  throw new Error('DATA_DIR and INTERNAL_SERVICE_TOKEN (32+ characters) are required');
const production = process.env.NODE_ENV === 'production';
const trainingOutbox = config.mail.transport === 'outbox' && config.mail.allowInsecureOutbox;
if (!['outbox', 'webhook'].includes(config.mail.transport))
  throw new Error('MAIL_TRANSPORT must be "outbox" (training only) or "webhook"');
if (production && config.mail.transport === 'outbox' && !trainingOutbox)
  throw new Error('Outbox is training-only; explicitly set MAIL_ALLOW_INSECURE_OUTBOX=true');

function validateMailUrl(name: string, value: string, httpsRequired: boolean): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (httpsRequired && url.protocol !== 'https:')
  )
    throw new Error(
      `${name} must use ${httpsRequired ? 'https' : 'http(s)'} without credentials, query or fragment`,
    );
}
validateMailUrl('PUBLIC_APP_URL', config.mail.publicAppUrl, production && !trainingOutbox);
if (config.mail.transport === 'webhook') {
  validateMailUrl('MAIL_WEBHOOK_URL', config.mail.webhookUrl, production);
  if (production && config.mail.webhookToken.length < 32)
    throw new Error('MAIL_WEBHOOK_TOKEN must contain at least 32 characters in production');
}
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
