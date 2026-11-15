import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { database } from './database.ts';
import { AppError } from './middleware/errors.ts';

/**
 * Refresh-token sessions (rotation + reuse detection) and per-account login backoff.
 *
 * Refresh tokens are opaque, stored only as SHA-256 hashes, and rotated on every use.
 * All tokens issued from one login form a "family": presenting an already-rotated
 * token outside a short grace window means it was copied, so the whole family is
 * revoked.
 *
 * Access tokens (JWT, 15 min) are verified by every service without calling back
 * here. Each carries its family ID as `sid`. Revoking a family also lists that ID in
 * `revoked_sessions` until its last access token has expired; the other services
 * fetch this short list every few seconds (GET /internal/revocations) and refuse
 * tokens whose `sid` is on it. Logout therefore takes effect within seconds instead
 * of at token expiry, without a call to auth-service on every request.
 *
 * Every family remembers until when its newest access token is valid (`accessUntil`),
 * so the list only holds sessions that could still be used: a session that has been
 * idle for longer than one access-token lifetime is revoked without an entry. That
 * keeps the list short even when one account ends many sessions at once.
 */
interface RefreshRecord {
  userId: string;
  familyId: string;
  expiresAt: number;
  rotatedAt?: number;
}
interface RefreshFamily {
  userId: string;
  createdAt: number;
  expiresAt: number; // absolute limit, never extended by rotation
  /** Expiry of the newest access token issued for this session (absent on old records). */
  accessUntil?: number;
  revokedAt?: number;
  revokedReason?: 'logout' | 'reuse' | 'user-missing' | 'password-reset';
}
interface LoginFailures {
  count: number;
  lastFailureAt: number;
  lockedUntil?: number;
}

const tokens = database.store<RefreshRecord>('refresh_tokens');
const families = database.store<RefreshFamily>('refresh_families');
const failures = database.store<LoginFailures>('login_failures');
export interface RevokedSession {
  sid: string;
  /** Epoch ms after which no access token of this session can still be valid. */
  until: number;
}
const revoked = database.store<RevokedSession>('revoked_sessions');
/** Verifiers tolerate small clock differences; keep entries a little longer. */
const CLOCK_SKEW_MS = 60_000;
// Longest configurable access-token lifetime: the bound for sessions whose newest
// access token is unknown (records written before `accessUntil` existed).
const MAX_ACCESS_TOKEN_MS = 3_600_000;

const hash = (token: string) => createHash('sha256').update(token).digest('base64url');
const invalid = () =>
  new AppError(401, 'Sesi berakhir. Silakan masuk kembali.', undefined, 'INVALID_REFRESH');

function mint(userId: string, familyId: string, now: number) {
  const family = families.get(familyId)!;
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Math.min(now + config.refresh.ttlMs, family.expiresAt);
  tokens.insert(hash(token), { userId, familyId, expiresAt }, expiresAt);
  // The caller issues an access token together with this refresh token.
  families.set(familyId, {
    ...family,
    accessUntil: Math.min(now + config.jwt.expiresInSeconds * 1000, expiresAt),
  });
  return { token, expiresAt };
}

/** Starts a new session family at login. */
export function startSession(userId: string, now = Date.now()) {
  return database.transaction(() => {
    const familyId = randomUUID();
    const expiresAt = now + config.refresh.familyMaxMs;
    families.insert(familyId, { userId, createdAt: now, expiresAt }, expiresAt);
    return { familyId, ...mint(userId, familyId, now) };
  });
}

/**
 * `accessExpiresAt` is the expiry of a signed access token the caller verified; it
 * stands in when the family record is gone (swept) or predates `accessUntil`.
 */
function revokeFamily(
  familyId: string,
  reason: RefreshFamily['revokedReason'],
  now: number,
  accessExpiresAt?: number,
) {
  const family = families.get(familyId);
  if ((!family && accessExpiresAt === undefined) || family?.revokedAt) return;
  if (family) families.set(familyId, { ...family, revokedAt: now, revokedReason: reason });
  const lastAccess = family?.accessUntil ?? accessExpiresAt ?? now + MAX_ACCESS_TOKEN_MS;
  const until = Math.min(lastAccess, now + MAX_ACCESS_TOKEN_MS) + CLOCK_SKEW_MS;
  // No access token of this session can still be valid: nothing to publish.
  if (until > now) revoked.set(familyId, { sid: familyId, until }, until);
}

/** True while access tokens of this session must be refused. */
export function isSessionRevoked(sid: string, now = Date.now()): boolean {
  const entry = revoked.get(sid);
  return entry !== undefined && entry.until > now;
}

/** The revocation list other services poll. Short by construction: an entry lives one access-token lifetime plus a minute. */
export function listRevokedSessions(now = Date.now()): RevokedSession[] {
  return revoked.values().filter((entry) => entry.until > now);
}

export type RotationResult =
  | { kind: 'rotated'; userId: string; familyId: string; token: string; expiresAt: number }
  | { kind: 'reused'; userId: string };

/**
 * Exchanges a refresh token for a new one. Atomic, so two concurrent requests with
 * the same token can never both succeed.
 */
export function rotateSession(token: string, now = Date.now()): RotationResult {
  return database.transaction(() => {
    const key = hash(token);
    const record = tokens.get(key);
    if (!record) throw invalid();
    const family = families.get(record.familyId);
    if (!family || family.revokedAt || now >= family.expiresAt) throw invalid();
    if (record.rotatedAt !== undefined) {
      if (now - record.rotatedAt <= config.refresh.reuseGraceMs)
        throw new AppError(
          409,
          'Sesi sedang diperbarui di tab lain. Coba lagi.',
          undefined,
          'REFRESH_RACE',
        );
      revokeFamily(record.familyId, 'reuse', now);
      return { kind: 'reused', userId: record.userId };
    }
    if (now >= record.expiresAt) throw invalid();
    tokens.set(key, { ...record, rotatedAt: now });
    return {
      kind: 'rotated',
      userId: record.userId,
      familyId: record.familyId,
      ...mint(record.userId, record.familyId, now),
    };
  });
}

/** Ends the session the token belongs to (logout). Unknown tokens are ignored. */
export function endSession(token: string, now = Date.now()): void {
  database.transaction(() => {
    const record = tokens.get(hash(token));
    if (record) revokeFamily(record.familyId, 'logout', now);
  });
}

/**
 * Only call after verifying a signed, unexpired JWT (`exp` in seconds is its expiry);
 * the cookie may have disappeared.
 */
export function endAccessSession(sid: string, exp: number, now = Date.now()): void {
  database.transaction(() => revokeFamily(sid, 'logout', now, exp * 1000));
}

/**
 * Ends every session of an account, e.g. after its password was reset. Runs inside
 * the caller's transaction, so it commits together with the change that caused it.
 */
export function endAllSessions(
  userId: string,
  reason: RefreshFamily['revokedReason'],
  now = Date.now(),
): number {
  const rows = database
    .statement(
      "SELECT key FROM records WHERE namespace='refresh_families' AND json_extract(value, '$.userId')=?",
    )
    .all(userId);
  database.transaction(() => {
    for (const row of rows) revokeFamily(String(row.key), reason, now);
  });
  return rows.length;
}

/** Called when a refresh points at a user that no longer exists. */
export function endSessionForMissingUser(token: string, now = Date.now()): void {
  database.transaction(() => {
    const record = tokens.get(hash(token));
    if (record) revokeFamily(record.familyId, 'user-missing', now);
  });
}

/**
 * Exponential backoff per normalized email, on top of the per-IP limit: after
 * `freeFailures` misses the account waits 30 s, 60 s, … up to 15 min. A soft delay
 * instead of a permanent lock, so an attacker cannot lock a victim out for long —
 * and sessions already signed in are unaffected because they renew via refresh.
 */
export function assertLoginAllowed(email: string, now = Date.now()): void {
  const record = failures.get(email);
  if (record?.lockedUntil && record.lockedUntil > now)
    throw new AppError(
      429,
      'Terlalu banyak percobaan masuk untuk akun ini. Coba lagi nanti.',
      { retryAfterSeconds: Math.ceil((record.lockedUntil - now) / 1000) },
      'LOGIN_THROTTLED',
    );
}

export function recordLoginFailure(email: string, now = Date.now()): void {
  const { freeFailures, baseDelayMs, maxDelayMs, windowMs } = config.loginThrottle;
  database.transaction(() => {
    const previous = failures.get(email);
    const count = previous && now - previous.lastFailureAt < windowMs ? previous.count + 1 : 1;
    const lockedUntil =
      count >= freeFailures
        ? now + Math.min(baseDelayMs * 2 ** (count - freeFailures), maxDelayMs)
        : undefined;
    failures.set(
      email,
      { count, lastFailureAt: now, lockedUntil },
      Math.max(lockedUntil ?? 0, now + windowMs),
    );
  });
}

export function clearLoginFailures(email: string): void {
  failures.delete(email);
}

/** Retention: expired refresh tokens, families and stale failure counters. */
export function purgeExpiredSessions(now = Date.now(), batch = 500) {
  return database.transaction(() => ({
    tokens: tokens.sweep(now, batch, () => 'delete'),
    families: families.sweep(now, batch, () => 'delete'),
    failures: failures.sweep(now, batch, () => 'delete'),
    revoked: revoked.sweep(now, batch, () => 'delete'),
  }));
}
