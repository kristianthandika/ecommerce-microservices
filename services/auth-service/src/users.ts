import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { Logger } from '@ecommerce/logger';
import { config } from './config.ts';
import { getKeyMaterial } from './keys.ts';
import { AppError } from './middleware/errors.ts';

interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  passwordHash: string;
}

export interface PublicUser {
  id: string;
  email: string;
  role: string;
}

interface Credentials {
  email: string;
  password: string;
}

/**
 * User store IN-MEMORY (bukan database sungguhan) — simplifikasi disengaja
 * untuk scope training, lihat README & docs/PRODUCTION-CHECKLIST.md.
 */
const usersByEmail = new Map<string, User>();

async function createUser({
  email,
  password,
  role,
}: Credentials & { role: User['role'] }): Promise<User> {
  const passwordHash = await bcrypt.hash(password, config.bcryptSaltRounds);
  const user: User = { id: randomUUID(), email, role, passwordHash };
  usersByEmail.set(email, user);
  return user;
}

export async function register({ email, password }: Credentials): Promise<PublicUser> {
  if (usersByEmail.has(email)) {
    throw new AppError(409, 'Email sudah terdaftar', undefined, 'EMAIL_TAKEN');
  }
  // Endpoint publik hanya boleh membuat role 'user' (lihat DECISIONS.md).
  const user = await createUser({ email, password, role: 'user' });
  return publicUser(user);
}

export async function login({
  email,
  password,
}: Credentials): Promise<{ token: string; user: PublicUser }> {
  const user = usersByEmail.get(email);
  // Bandingkan hash walau user tak ada (mitigasi timing attack ringan).
  // Urutan argumen: compare(plainPassword, hash).
  const ok = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !ok) {
    throw new AppError(401, 'Email atau password salah', undefined, 'INVALID_CREDENTIALS');
  }
  return { token: signToken(user), user: publicUser(user) };
}

/** Sign JWT RS256 dengan header `kid` yang cocok dengan JWK endpoint. */
function signToken(user: User): string {
  const { privateKeyPem, kid } = getKeyMaterial();
  return jwt.sign({ email: user.email, role: user.role }, privateKeyPem, {
    algorithm: 'RS256',
    keyid: kid, // → header.kid, dipakai jwks-rsa untuk memilih key
    subject: user.id,
    issuer: config.jwt.issuer,
    expiresIn: config.jwt.expiresIn as unknown as number,
  });
}

function publicUser(user: User): PublicUser {
  return { id: user.id, email: user.email, role: user.role };
}

export function getUserById(id: string): PublicUser | null {
  for (const user of usersByEmail.values()) {
    if (user.id === id) return publicUser(user);
  }
  return null;
}

/** Seed satu admin demo saat startup (kredensial demo — lihat DECISIONS.md). */
export async function seedAdmin(logger?: Logger): Promise<void> {
  const { email, password } = config.seedAdmin;
  if (usersByEmail.has(email)) return;
  await createUser({ email, password, role: 'admin' });
  logger?.warn(
    { email },
    'Admin demo di-seed dengan kredensial default — HANYA untuk training, ganti di production',
  );
}

/** Hanya untuk test — kosongkan store. */
export function _resetUsers(): void {
  usersByEmail.clear();
}
