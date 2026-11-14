import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { Logger } from '@ecommerce/logger';
import { config } from './config.ts';
import { getKeyMaterial } from './keys.ts';
import { AppError } from './middleware/errors.ts';
import { database } from './database.ts';
import { assertLoginAllowed, recordLoginFailure, clearLoginFailures } from './sessions.ts';

interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  passwordHash: string;
  /** Absent on legacy accounts: regular users must verify before ordering. */
  emailVerified?: boolean;
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

async function createUser({
  email,
  password,
  role,
  emailVerified,
}: Credentials & { role: User['role']; emailVerified: boolean }): Promise<User> {
  email = email.trim().toLowerCase();
  if (Buffer.byteLength(password, 'utf8') > 72)
    throw new AppError(400, 'Password maksimal 72 byte UTF-8');
  const passwordHash = await bcrypt.hash(password, config.bcryptSaltRounds);
  const user: User = { id: randomUUID(), email, role, passwordHash, emailVerified };
  database.transaction(() => {
    if (!usersByEmail.insert(email, user))
      throw new AppError(409, 'Email sudah terdaftar', undefined, 'EMAIL_TAKEN');
    usersById.insert(user.id, user);
  });
  return user;
}

export async function register({ email, password }: Credentials): Promise<PublicUser> {
  email = email.trim().toLowerCase();
  if (usersByEmail.has(email)) {
    throw new AppError(409, 'Email sudah terdaftar', undefined, 'EMAIL_TAKEN');
  }
  // Endpoint publik hanya boleh membuat role 'user' (lihat DECISIONS.md).
  const user = await createUser({
    email,
    password,
    role: 'user',
    emailVerified: !config.emailVerification.required,
  });
  return publicUser(user);
}

/** Checks the credentials. The caller starts the session and issues the tokens. */
export async function login({ email, password }: Credentials): Promise<PublicUser> {
  email = email.trim().toLowerCase();
  // Per-account backoff, checked BEFORE the password: during a lockout even the
  // right password is refused, so guessing cannot continue. Applied to unknown
  // emails too, so the response never reveals whether an account exists.
  assertLoginAllowed(email);
  const user = usersByEmail.get(email);
  // SELALU jalankan bcrypt.compare — walau email tak dikenal, bandingkan dengan
  // hash umpan supaya waktu respons konsisten (tanpa ini, email tak dikenal
  // balik ~instan → bocor lewat timing). Urutan argumen: compare(plain, hash).
  const ok = await bcrypt.compare(password, user ? user.passwordHash : getDummyHash());
  if (!user || !ok) {
    recordLoginFailure(email);
    throw new AppError(401, 'Email atau password salah', undefined, 'INVALID_CREDENTIALS');
  }
  clearLoginFailures(email);
  return publicUser(user);
}

/**
 * Access token for session `sid` (the refresh-token family). Reads the user again,
 * so a deleted account loses access, and a changed role or a freshly verified email
 * takes effect at the next refresh.
 */
export function accessTokenFor(
  userId: string,
  sid: string,
  sessionExpiresAt?: number,
): { token: string; user: PublicUser; expiresIn: number } {
  const user = usersById.get(userId);
  if (!user) throw new AppError(401, 'Sesi tidak berlaku', undefined, 'INVALID_SESSION');
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
    email_verified: user.emailVerified === true || user.role === 'admin',
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
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    emailVerified: user.emailVerified === true || user.role === 'admin',
  };
}

/** Both lookups hold a copy of the user; they change together or not at all. */
export function markEmailVerified(id: string): PublicUser | null {
  return database.transaction(() => {
    const user = usersById.get(id);
    if (!user) return null;
    const verified: User = { ...user, emailVerified: true };
    usersById.set(id, verified);
    usersByEmail.set(user.email, verified);
    return publicUser(verified);
  });
}

export function getUserById(id: string): PublicUser | null {
  const user = usersById.get(id);
  return user ? publicUser(user) : null;
}

/** Seed satu admin demo saat startup (kredensial demo — lihat DECISIONS.md). */
export async function seedAdmin(logger?: Logger): Promise<void> {
  if (!config.seedAdmin.enabled) return;
  const { email, password } = config.seedAdmin;
  if (
    !email ||
    !password ||
    password === 'admin123' ||
    Buffer.byteLength(password) < 16 ||
    Buffer.byteLength(password) > 72
  )
    throw new Error('Seed admin requires email and a unique password of 16-72 UTF-8 bytes');
  const existing = usersByEmail.get(email.trim().toLowerCase());
  if (existing) {
    if (existing.role !== 'admin')
      throw new Error('Seed admin email already belongs to a non-admin account');
    return;
  }
  await createUser({ email, password, role: 'admin', emailVerified: true });
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
