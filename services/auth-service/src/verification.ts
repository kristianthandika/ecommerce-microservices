import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { database } from './database.ts';
import { deliver } from './mailer.ts';
import { AppError } from './middleware/errors.ts';
import { markEmailVerified, type PublicUser } from './users.ts';

/**
 * Email verification: an account can sign in only after its address was confirmed.
 *
 * Confirming takes BOTH the mailed link and the account's password:
 *
 * - the link alone is not enough, so the owner of a mailbox cannot be tricked into
 *   activating an account that somebody else registered with a password of their
 *   own choosing (account pre-hijacking);
 * - the password alone is not enough, so nobody can activate an account for an
 *   address whose mail they cannot read. That makes mass account creation expensive
 *   (OWASP API6) and keeps unverified registrations from occupying an address.
 *
 * Tokens are 256 random bits, stored only as SHA-256 hashes, valid for 24 hours and
 * usable once. The link carries the token in the URL fragment, which browsers never
 * send to a server, so it cannot end up in access logs or Referer headers.
 */
interface PendingVerification {
  userId: string;
  expiresAt: number;
  /** Wrong passwords presented with this token. */
  attempts?: number;
}
const pending = database.store<PendingVerification>('email_verifications');
const hash = (token: string) => createHash('sha256').update(token).digest('base64url');
const invalid = () =>
  new AppError(
    400,
    'Tautan verifikasi tidak berlaku, kedaluwarsa, atau sudah dipakai',
    undefined,
    'INVALID_VERIFICATION_TOKEN',
  );

/**
 * Creates a token and mails the link. Delivery errors reach the caller. The caller
 * has claimed this mail with `reserveMail` (one per address per minute).
 */
export async function sendVerification(
  user: { id: string; email: string },
  now = Date.now(),
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + config.emailVerification.ttlMs;
  pending.insert(hash(token), { userId: user.id, expiresAt }, expiresAt);
  const link = `${config.mail.publicAppUrl}/verify-email#token=${token}`;
  await deliver(
    {
      to: user.email,
      subject: 'Verifikasi email Anda',
      text: [
        'Terima kasih sudah mendaftar.',
        '',
        'Buka tautan berikut, lalu masukkan password yang Anda pilih saat mendaftar untuk mengaktifkan akun.',
        link,
        '',
        'Tautan berlaku 24 jam dan hanya bisa dipakai sekali. Abaikan email ini bila bukan Anda yang mendaftar: tanpa verifikasi, akun tersebut tidak pernah aktif dan akan dihapus.',
      ].join('\n'),
      link,
    },
    now,
  );
}

/**
 * Told to the owner of a verified account when somebody tries to register its
 * address again. The registration endpoint itself answers as if nothing was special.
 */
export async function sendAccountExistsNotice(
  user: { email: string },
  now = Date.now(),
): Promise<void> {
  await deliver(
    {
      to: user.email,
      subject: 'Percobaan pendaftaran dengan email Anda',
      text: [
        'Seseorang mencoba mendaftar memakai alamat email ini, padahal alamat ini sudah punya akun.',
        '',
        `Bila itu Anda, silakan masuk: ${config.mail.publicAppUrl}/login`,
        `Lupa password? Atur ulang di: ${config.mail.publicAppUrl}/forgot-password`,
        '',
        'Bila bukan Anda, abaikan email ini. Akun dan password Anda tidak berubah.',
      ].join('\n'),
    },
    now,
  );
}

/** Tokens of an account that no longer needs them (verified, or password reset). */
export function forgetVerifications(userId: string): void {
  database
    .statement(
      "DELETE FROM records WHERE namespace='email_verifications' AND json_extract(value, '$.userId')=?",
    )
    .run(userId);
}

/**
 * TODO m12.9 — versi starter mengaktifkan akun hanya dengan TAUTAN. Akibatnya
 * penyerang bisa mendaftarkan email korban dengan password pilihannya; begitu korban
 * membuka tautan di emailnya, akun milik penyerang yang aktif (account pre-hijacking).
 * Ubah supaya tautan DAN password akun keduanya wajib:
 * 1. cari record token (`pending.get(hash(token))`); tidak ada/kedaluwarsa → `invalid()`;
 * 2. `matchingPasswordHash(record.userId, password)` dari users.ts (selalu satu bcrypt);
 * 3. dalam SATU transaksi: baca record lagi; password salah → tambah `attempts`, hapus
 *    record bila sudah `config.emailVerification.maxPasswordAttempts`, dan kembalikan
 *    'wrong-password' (penghitung harus ter-commit, jadi JANGAN melempar di dalam transaksi);
 *    password benar → `markEmailVerified(userId, passwordHash)` lalu `forgetVerifications`;
 * 4. di luar transaksi: password salah → AppError 401 `INVALID_CREDENTIALS`.
 */
export async function verifyEmail(
  token: string,
  _password: string,
  now = Date.now(),
): Promise<PublicUser> {
  return database.transaction(() => {
    const key = hash(token);
    const record = pending.get(key);
    if (!record || record.expiresAt <= now) throw invalid();
    pending.delete(key);
    const user = markEmailVerified(record.userId);
    if (!user) throw invalid();
    return user;
  });
}

export function purgeExpiredVerifications(now = Date.now(), batch = 500) {
  return database.transaction(() => pending.sweep(now, batch, () => 'delete'));
}
