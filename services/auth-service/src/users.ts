import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { Logger } from '@ecommerce/logger';
import { config } from './config.ts';
import { getKeyMaterial } from './keys.ts';
import { AppError } from './middleware/errors.ts';
import { database } from './database.ts';
import { assertLoginAllowed, recordLoginFailure, clearLoginFailures } from './sessions.ts';
import { isTrustedDevice, recordDeviceFailure } from './devices.ts';
import { reserveMail } from './mailer.ts';

interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  passwordHash: string;
  /** Absent on legacy accounts: they must verify (or reset their password) to sign in. */
  emailVerified?: boolean;
  /**
   * Set while a self-registered account waits for its email verification. Until then
   * nobody can sign in with it, a new registration for the same address replaces its
   * password, and the account is deleted once this time has passed.
   */
  pendingUntil?: number;
}

export interface PublicUser {
  id: string;
  email: string;
  role: string;
  emailVerified: boolean;
}

interface Credentials {
  email: string;
  password: string;
}

/** Unique normalized emails and ID lookup commit in the same durable transaction. */
const usersByEmail = database.store<User>('users_email');
const usersById = database.store<User>('users_id');

const normalize = (email: string) => email.trim().toLowerCase();
const isVerified = (user: User) => user.emailVerified === true || user.role === 'admin';

/**
 * Both lookups hold a copy of the user; they change together or not at all (call
 * inside a transaction). Only the email record carries the deletion schedule of a
 * pending account; `null` clears it for every other account.
 */
function save(user: User): void {
  usersByEmail.set(user.email, user, isVerified(user) ? null : (user.pendingUntil ?? null));
  usersById.set(user.id, user, null);
}

export async function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password, 'utf8') > 72)
    throw new AppError(400, 'Password maksimal 72 byte UTF-8');
  return bcrypt.hash(password, config.bcryptSaltRounds);
}

// Hash "umpan" untuk dibandingkan saat email tidak dikenal → login memakan
// waktu yang sama seperti email dikenal (mitigasi timing attack / user
// enumeration). Dihitung sekali (lazy) dengan salt rounds yang sama.
let dummyHash: string | null = null;
function getDummyHash(): string {
  if (dummyHash === null) {
    dummyHash = bcrypt.hashSync('dummy-password-for-timing-safety', config.bcryptSaltRounds);
  }
  return dummyHash;
}

/** Which mail a registration leads to. The HTTP response never depends on it. */
export type RegistrationMail = 'verification' | 'account-exists' | 'none';
export interface Registration {
  user: { id: string; email: string };
  mail: RegistrationMail;
}

/**
 * Self-registration (role `user` only). The caller answers every outcome with the
 * same response, so the endpoint cannot be used to find out which addresses have an
 * account (OWASP API2); what happened is told only to the mailbox:
 *
 * - new address: a pending account and a verification link;
 * - pending account: its password is replaced by this one and a new link is sent, so
 *   somebody who registered a foreign address cannot keep the owner out;
 * - legacy account without verification: untouched, the owner gets a link;
 * - verified account: untouched, the owner is told that somebody tried to register.
 *
 * The password is hashed first and every outcome commits one write (the mail
 * cooldown, see `reserveMail`), so all outcomes take the same time. `mail` is
 * `none` when this address already got that mail a moment ago.
 */
export async function register(
  { email, password }: Credentials,
  now = Date.now(),
): Promise<Registration> {
  email = normalize(email);
  const passwordHash = await hashPassword(password);
  const { required, ttlMs } = config.emailVerification;
  return database.transaction((): Registration => {
    const existing = usersByEmail.get(email);
    if (!existing) {
      const user: User = {
        id: randomUUID(),
        email,
        role: 'user',
        passwordHash,
        emailVerified: !required,
        ...(required ? { pendingUntil: now + ttlMs } : {}),
      };
      save(user);
      const mail = required && reserveMail('verification', email, now) ? 'verification' : 'none';
      return { user: { id: user.id, email }, mail };
    }
    // TODO m12.8 — jawaban 409 di bawah memberi tahu SIAPA PUN bahwa alamat ini
    // sudah punya akun (enumerasi akun). Ganti dengan:
    // - akun sudah terverifikasi → jangan ubah apa pun; kembalikan
    //   `{ user, mail: 'account-exists' }` (pemiliknya diberi tahu lewat email);
    // - akun masih menunggu verifikasi (`pendingUntil` ada) → simpan password baru
    //   dan perpanjang `pendingUntil`, supaya orang yang mendaftarkan alamat milik
    //   orang lain tidak bisa menghalangi pemiliknya; kembalikan `mail: 'verification'`;
    // - akun lama tanpa verifikasi → jangan ubah password; `mail: 'verification'`.
    // Selalu lewat `reserveMail(...)` (kuota email) dan jangan pernah melempar error:
    // route menjawab 202 yang sama untuk semua kasus.
    void ttlMs;
    throw new AppError(409, 'Email sudah terdaftar', undefined, 'EMAIL_TAKEN');
  });
}

/**
 * Checks the credentials. The caller starts the session and issues the tokens.
 *
 * `deviceToken` is the device cookie of the browser, if it sent one (see devices.ts).
 */
export async function login(
  { email, password }: Credentials,
  deviceToken?: string,
): Promise<PublicUser> {
  email = normalize(email);
  const user = usersByEmail.get(email);
  // A browser this account signed in from before is not held back by failures that
  // other clients caused; its own cookie counts them instead.
  const trusted = user !== undefined && isTrustedDevice(deviceToken, user.id);
  // Per-account backoff, checked BEFORE the password: during a lockout even the
  // right password is refused, so guessing cannot continue. Applied to unknown
  // emails too, so the response never reveals whether an account exists.
  if (!trusted) assertLoginAllowed(email);
  // SELALU jalankan bcrypt.compare — walau email tak dikenal, bandingkan dengan
  // hash umpan supaya waktu respons konsisten (tanpa ini, email tak dikenal
  // balik ~instan → bocor lewat timing). Urutan argumen: compare(plain, hash).
  const ok = await bcrypt.compare(password, user ? user.passwordHash : getDummyHash());
  // TODO m12.8 — akun yang BELUM diverifikasi harus dijawab persis seperti password
  // salah (dan dihitung sebagai kegagalan). Sekarang ia lolos ke sini lalu ditolak
  // `accessTokenFor` dengan kode lain (INVALID_SESSION), sehingga "daftar lalu coba
  // masuk" membocorkan apakah alamat itu sudah punya akun. Tambahkan `!isVerified(user)`.
  if (!user || !ok) {
    if (trusted && deviceToken) recordDeviceFailure(deviceToken);
    else recordLoginFailure(email);
    throw new AppError(401, 'Email atau password salah', undefined, 'INVALID_CREDENTIALS');
  }
  if (!trusted) clearLoginFailures(email);
  return publicUser(user);
}

/**
 * Access token for session `sid` (the refresh-token family). Reads the user again,
 * so a deleted or unverified account loses access, and a changed role takes effect
 * at the next refresh.
 */
export function accessTokenFor(
  userId: string,
  sid: string,
  sessionExpiresAt?: number,
): { token: string; user: PublicUser; expiresIn: number } {
  const user = usersById.get(userId);
  if (!user || !isVerified(user))
    throw new AppError(401, 'Sesi tidak berlaku', undefined, 'INVALID_SESSION');
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresIn =
    sessionExpiresAt === undefined
      ? config.jwt.expiresInSeconds
      : Math.max(
          0,
          Math.min(config.jwt.expiresInSeconds, Math.floor(sessionExpiresAt / 1000) - issuedAt),
        );
  if (expiresIn <= 0) throw new AppError(401, 'Sesi tidak berlaku', undefined, 'INVALID_SESSION');
  return { token: signToken(user, sid, issuedAt, expiresIn), user: publicUser(user), expiresIn };
}

/**
 * Sign JWT RS256 dengan header `kid` yang cocok dengan JWK endpoint. `sid` mengikat
 * token ke sesinya (untuk pencabutan); `email_verified` memakai nama klaim OIDC.
 */
function signToken(user: User, sid: string, issuedAt: number, expiresIn: number): string {
  const { privateKeyPem, kid } = getKeyMaterial();
  const claims = {
    email: user.email,
    role: user.role,
    sid,
    iat: issuedAt,
    email_verified: isVerified(user),
  };
  return jwt.sign(claims, privateKeyPem, {
    algorithm: 'RS256',
    keyid: kid, // → header.kid, dipakai jwks-rsa untuk memilih key
    subject: user.id,
    issuer: config.jwt.issuer,
    audience: 'ecommerce-api',
    expiresIn,
  });
}

function publicUser(user: User): PublicUser {
  return { id: user.id, email: user.email, role: user.role, emailVerified: isVerified(user) };
}

/**
 * The stored hash when `password` is right for this account, otherwise null. Always
 * runs one bcrypt comparison, also for an account that no longer exists.
 */
export async function matchingPasswordHash(
  userId: string,
  password: string,
): Promise<string | null> {
  const user = usersById.get(userId);
  const ok = await bcrypt.compare(password, user ? user.passwordHash : getDummyHash());
  return user && ok ? user.passwordHash : null;
}

/**
 * Marks the account verified. With `expectedPasswordHash` the change only happens
 * while the account still has that password: a registration that replaced it in the
 * meantime must not be confirmed by the previous registrant.
 */
export function markEmailVerified(id: string, expectedPasswordHash?: string): PublicUser | null {
  return database.transaction(() => {
    const user = usersById.get(id);
    if (!user) return null;
    if (expectedPasswordHash !== undefined && user.passwordHash !== expectedPasswordHash)
      return null;
    const { pendingUntil: _pendingUntil, ...account } = user;
    const verified: User = { ...account, emailVerified: true };
    save(verified);
    return publicUser(verified);
  });
}

/**
 * Sets a new password after a reset link was used. The link proves control of the
 * mailbox, so the account is verified at the same time.
 */
export function replacePassword(id: string, passwordHash: string): PublicUser | null {
  return database.transaction(() => {
    const user = usersById.get(id);
    if (!user) return null;
    const { pendingUntil: _pendingUntil, ...account } = user;
    const updated: User = { ...account, passwordHash, emailVerified: true };
    save(updated);
    return publicUser(updated);
  });
}

export function getUserById(id: string): PublicUser | null {
  const user = usersById.get(id);
  return user ? publicUser(user) : null;
}

/** Any account for this address, verified or not (for mail that only the owner reads). */
export function findAccountByEmail(email: string): { id: string; email: string } | null {
  const user = usersByEmail.get(normalize(email));
  return user ? { id: user.id, email: user.email } : null;
}

/**
 * Retention: self-registered accounts that were never verified are deleted when
 * their time is up, so an address cannot be occupied by somebody who cannot read
 * its mail.
 */
export function purgeExpiredPending(now = Date.now(), batch = 500) {
  return database.transaction(() =>
    usersByEmail.sweep(now, batch, (_email, user) => {
      // The schedule is only a hint; the record decides.
      if (isVerified(user) || user.pendingUntil === undefined) return now + 365 * 24 * 3_600_000;
      if (user.pendingUntil > now) return user.pendingUntil;
      usersById.delete(user.id);
      return 'delete';
    }),
  );
}

/** Seed satu admin demo saat startup (kredensial demo — lihat DECISIONS.md). */
export async function seedAdmin(logger?: Logger): Promise<void> {
  if (!config.seedAdmin.enabled) return;
  const { password } = config.seedAdmin;
  const email = normalize(config.seedAdmin.email);
  if (
    !email ||
    !password ||
    password === 'admin123' ||
    Buffer.byteLength(password) < 16 ||
    Buffer.byteLength(password) > 72
  )
    throw new Error('Seed admin requires email and a unique password of 16-72 UTF-8 bytes');
  const existing = usersByEmail.get(email);
  if (existing) {
    if (existing.role !== 'admin')
      throw new Error('Seed admin email already belongs to a non-admin account');
    return;
  }
  const passwordHash = await hashPassword(password);
  database.transaction(() => {
    if (usersByEmail.has(email)) return;
    save({ id: randomUUID(), email, role: 'admin', passwordHash, emailVerified: true });
  });
  logger?.warn(
    { email },
    'Admin bootstrap dibuat melalui konfigurasi eksplisit — HANYA untuk training, ganti di production',
  );
}

/** Hanya untuk test — kosongkan store. */
export function _resetUsers(): void {
  usersByEmail.clear();
  usersById.clear();
}
