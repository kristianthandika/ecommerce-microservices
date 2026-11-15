import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { database } from './database.ts';
import { deliver, reserveMail } from './mailer.ts';
import { AppError } from './middleware/errors.ts';
import { findAccountByEmail, hashPassword, replacePassword, type PublicUser } from './users.ts';

/**
 * Password reset by mailed link.
 *
 * - The request is answered the same way for every address, so it does not tell
 *   which addresses have an account; at most one mail per address per minute.
 * - Tokens are 256 random bits, stored only as SHA-256 hashes, valid for one hour
 *   and usable once. They travel in the URL fragment, like verification tokens.
 * - Using a link proves control of the mailbox: the account becomes verified. This
 *   is also how the owner of an address takes over an account that somebody else
 *   registered with it.
 * - A reset means the old password may be known to others: every session of the
 *   account ends and its trusted devices are forgotten, in the same transaction
 *   that stores the new password.
 */
interface ResetRequest {
  userId: string;
  expiresAt: number;
}
const resets = database.store<ResetRequest>('password_resets');
const hash = (token: string) => createHash('sha256').update(token).digest('base64url');
const invalid = () =>
  new AppError(
    400,
    'Tautan atur ulang password tidak berlaku, kedaluwarsa, atau sudah dipakai',
    undefined,
    'INVALID_RESET_TOKEN',
  );

/**
 * Mails a reset link when the address has an account. Returns whether a mail was
 * sent; the HTTP response must not depend on it. Delivery errors reach the caller.
 */
export async function requestPasswordReset(email: string, now = Date.now()): Promise<boolean> {
  email = email.trim().toLowerCase();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + config.passwordReset.ttlMs;
  // One commit for every address, known or not: the mail cooldown is always
  // written (see reserveMail), the token only when there is an account.
  const account = database.transaction(() => {
    const allowed = reserveMail('password-reset', email, now);
    const found = findAccountByEmail(email);
    if (!allowed || !found) return null;
    resets.insert(hash(token), { userId: found.id, expiresAt }, expiresAt);
    return found;
  });
  if (!account) return false;
  const link = `${config.mail.publicAppUrl}/reset-password#token=${token}`;
  await deliver(
    {
      to: account.email,
      subject: 'Atur ulang password Anda',
      text: [
        'Kami menerima permintaan untuk mengatur ulang password akun Anda.',
        '',
        'Buka tautan berikut untuk memilih password baru.',
        link,
        '',
        'Tautan berlaku 1 jam dan hanya bisa dipakai sekali. Abaikan email ini bila Anda tidak memintanya: password Anda tidak berubah.',
      ].join('\n'),
      link,
    },
    now,
  );
  return true;
}

/**
 * TODO m12.10 — versi starter mengganti password tetapi:
 * - tautan bisa dipakai BERULANG (record token tidak dihapus);
 * - sesi lama (mungkin milik penyerang yang tahu password lama) TETAP hidup;
 * - perangkat yang dikenal (device cookie) tetap dipercaya;
 * - pemeriksaan dan penggantian tidak atomik: dua request dengan tautan yang sama
 *   bisa sama-sama berhasil.
 * Perbaiki: di dalam SATU `database.transaction` baca record lagi, ganti password
 * (`replacePassword`), hapus SEMUA token reset akun itu, `forgetVerifications`,
 * `endAllSessions(userId, 'password-reset', now)` dan `forgetDevices(userId)`.
 * (Impor yang dibutuhkan: `endAllSessions` dari sessions.ts, `forgetDevices` dari
 * devices.ts, `forgetVerifications` dari verification.ts.)
 */
export async function confirmPasswordReset(
  token: string,
  password: string,
  now = Date.now(),
): Promise<PublicUser> {
  const record = resets.get(hash(token));
  if (!record || record.expiresAt <= now) throw invalid();
  const user = replacePassword(record.userId, await hashPassword(password));
  if (!user) throw invalid();
  return user;
}

export function purgeExpiredResets(now = Date.now(), batch = 500) {
  return database.transaction(() => resets.sweep(now, batch, () => 'delete'));
}
