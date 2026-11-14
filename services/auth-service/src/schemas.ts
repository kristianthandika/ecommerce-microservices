import { z } from 'zod';

/** Request schemas. Kept free of side effects so the OpenAPI generator can import them. */
export const credentialsSchema = z.object({
  // Normalisasi dulu (trim + lowercase), baru validasi format — email dengan
  // spasi di tepi atau huruf kapital tetap diterima sebagai alamat yang sama.
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, 'Email terlalu panjang')
    .pipe(z.email('Email tidak valid')),
  // Batas atas mencegah DoS lewat hashing string sangat besar.
  password: z
    .string()
    .min(8, 'Password minimal 8 karakter')
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password maksimal 72 byte UTF-8'),
});
export const verifyEmailSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, 'Token verifikasi tidak valid'),
});
export const outboxQuerySchema = z.object({
  to: z.string().trim().toLowerCase().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
