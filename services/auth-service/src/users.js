import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { getKeyMaterial } from './keys.js';
import { AppError } from './middleware/errors.js';

/**
 * User store IN-MEMORY (bukan database sungguhan) — simplifikasi disengaja
 * untuk scope training, lihat README & docs/PRODUCTION-CHECKLIST.md.
 */
const usersByEmail = new Map();

async function createUser({ email, password, role }) {
  const passwordHash = await bcrypt.hash(password, config.bcryptSaltRounds);
  const user = { id: randomUUID(), email, role, passwordHash };
  usersByEmail.set(email, user);
  return user;
}

export async function register({ email, password }) {
  if (usersByEmail.has(email)) {
    throw new AppError(409, 'Email sudah terdaftar', undefined);
  }
  // Endpoint publik hanya boleh membuat role 'user' — admin tidak bisa
  // didaftarkan lewat register publik (lihat DECISIONS.md).
  const user = await createUser({ email, password, role: 'user' });
  return publicUser(user);
}

export async function login({ email, password }) {
  const user = usersByEmail.get(email);
  // Bandingkan hash walau user tak ada (mitigasi timing attack ringan) lalu
  // tetap tolak. Urutan argumen: compare(plainPassword, hash).
  const ok = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !ok) {
    throw new AppError(401, 'Email atau password salah', undefined);
  }
  const token = signToken(user);
  return { token, user: publicUser(user) };
}

/** Sign JWT RS256 dengan header `kid` yang cocok dengan JWK endpoint. */
function signToken(user) {
  const { privateKeyPem, kid } = getKeyMaterial();
  return jwt.sign({ email: user.email, role: user.role }, privateKeyPem, {
    algorithm: 'RS256',
    keyid: kid, // → header.kid, dipakai jwks-rsa untuk memilih key
    subject: user.id,
    issuer: config.jwt.issuer,
    expiresIn: config.jwt.expiresIn,
  });
}

function publicUser(user) {
  return { id: user.id, email: user.email, role: user.role };
}

export function getUserById(id) {
  for (const user of usersByEmail.values()) {
    if (user.id === id) return publicUser(user);
  }
  return null;
}

/** Seed satu admin demo saat startup (kredensial demo — lihat DECISIONS.md). */
export async function seedAdmin(logger) {
  const { email, password } = config.seedAdmin;
  if (usersByEmail.has(email)) return;
  await createUser({ email, password, role: 'admin' });
  logger?.warn(
    { email },
    'Admin demo di-seed dengan kredensial default — HANYA untuk training, ganti di production',
  );
}

/** Hanya untuk test — kosongkan store. */
export function _resetUsers() {
  usersByEmail.clear();
}
