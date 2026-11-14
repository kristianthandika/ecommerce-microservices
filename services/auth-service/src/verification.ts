import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { database } from './database.ts';
import { deliver } from './mailer.ts';
import { AppError } from './middleware/errors.ts';
import { getUserById, markEmailVerified, type PublicUser } from './users.ts';

/**
 * Email verification (OWASP API6: makes mass account creation expensive).
 *
 * A new account can sign in, browse and fill a cart, but its access token says
 * `email_verified: false` and order-service refuses to create orders for it. Each
 * account therefore needs a working mailbox before it can hold stock.
 *
 * Tokens are 256 random bits, stored only as SHA-256 hashes, valid for 24 hours and
 * usable once. The link carries the token in the URL fragment, which browsers never
 * send to a server, so it cannot end up in access logs or Referer headers.
 */
interface PendingVerification {
  userId: string;
  expiresAt: number;
}
const pending = database.store<PendingVerification>('email_verifications');
const sends = database.store<{ sentAt: number }>('email_verification_sends');
const hash = (token: string) => createHash('sha256').update(token).digest('base64url');
const invalid = () =>
  new AppError(
    400,
    'Tautan verifikasi tidak berlaku, kedaluwarsa, atau sudah dipakai',
    undefined,
    'INVALID_VERIFICATION_TOKEN',
  );

/** Creates a token and mails the link. Delivery errors reach the caller. */
export async function sendVerification(
  user: { id: string; email: string },
  now = Date.now(),
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + config.emailVerification.ttlMs;
  database.transaction(() => {
    pending.insert(hash(token), { userId: user.id, expiresAt }, expiresAt);
    sends.set(user.id, { sentAt: now }, now + config.emailVerification.resendCooldownMs);
  });
  const link = `${config.mail.publicAppUrl}/verify-email#token=${token}`;
  await deliver(
    {
      to: user.email,
      subject: 'Verifikasi email Anda',
      text: [
        'Terima kasih sudah mendaftar.',
        '',
        'Buka tautan berikut untuk memverifikasi email Anda. Verifikasi diperlukan sebelum membuat pesanan.',
        link,
        '',
        'Tautan berlaku 24 jam dan hanya bisa dipakai sekali. Abaikan email ini bila Anda tidak mendaftar.',
      ].join('\n'),
      link,
    },
    now,
  );
}

/** For the signed-in user. One mail per cooldown, so the endpoint cannot be used to flood a mailbox. */
export async function resendVerification(userId: string, now = Date.now()): Promise<void> {
  const user = getUserById(userId);
  if (!user) throw new AppError(401, 'Sesi tidak berlaku', undefined, 'INVALID_SESSION');
  if (user.emailVerified)
    throw new AppError(409, 'Email sudah terverifikasi', undefined, 'EMAIL_ALREADY_VERIFIED');
  const last = sends.get(userId);
  const wait = last ? last.sentAt + config.emailVerification.resendCooldownMs - now : 0;
  if (wait > 0)
    throw new AppError(
      429,
      'Email verifikasi baru saja dikirim. Coba lagi sebentar.',
      { retryAfterSeconds: Math.ceil(wait / 1000) },
      'VERIFICATION_THROTTLED',
    );
  await sendVerification(user, now);
}

/** Consumes the token and marks its account verified, atomically. */
export function verifyEmail(token: string, now = Date.now()): PublicUser {
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
  return database.transaction(() => ({
    pending: pending.sweep(now, batch, () => 'delete'),
    sends: sends.sweep(now, batch, () => 'delete'),
  }));
}
