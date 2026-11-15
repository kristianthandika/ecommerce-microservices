import { z } from 'zod';

/** Request schemas. Kept free of side effects so the OpenAPI generator can import them. */
// Normalisasi dulu (trim + lowercase), baru validasi format — email dengan
// spasi di tepi atau huruf kapital tetap diterima sebagai alamat yang sama.
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email terlalu panjang')
  .pipe(z.email('Email tidak valid'));
// Batas atas mencegah DoS lewat hashing string sangat besar.
const passwordSchema = z
  .string()
  .min(8, 'Password minimal 8 karakter')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password maksimal 72 byte UTF-8');
/** Opaque token from a mailed link (256 random bits, base64url). */
const mailedToken = (message: string) => z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, message);

export const credentialsSchema = z.object({ email: emailSchema, password: passwordSchema });
export const verifyEmailSchema = z.object({
  token: mailedToken('Token verifikasi tidak valid'),
  // Password akun itu sendiri: tautan saja tidak cukup untuk mengaktifkan akun.
  password: passwordSchema,
});
export const passwordResetRequestSchema = z.object({ email: emailSchema });
export const passwordResetConfirmSchema = z.object({
  token: mailedToken('Token atur ulang password tidak valid'),
  password: passwordSchema,
});
export const outboxQuerySchema = z.object({
  to: z.string().trim().toLowerCase().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
