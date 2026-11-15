import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { database } from './database.ts';

/**
 * Device cookies (OWASP "Slow Down Online Guessing Attacks with Device Cookies").
 *
 * The per-email login backoff stops password guessing, but on its own it also lets
 * anyone keep a victim locked out by sending wrong passwords. A browser that signed
 * in to an account before therefore receives a long-lived cookie, and requests that
 * present it are judged by that cookie's own failure counter instead of the shared
 * per-email one. An attacker has no such cookie, so the lock they cause only applies
 * to clients the account has never used.
 *
 * The cookie is an opaque random value, stored here only as a SHA-256 hash. It is
 * not a credential: it never signs anyone in, it only decides which counter applies.
 * After `maxFailures` wrong passwords it is discarded, so a stolen cookie buys an
 * attacker a handful of guesses and nothing more.
 */
interface Device {
  userId: string;
  failures: number;
  expiresAt: number;
}
const devices = database.store<Device>('devices');
const hash = (token: string) => createHash('sha256').update(token).digest('base64url');

/**
 * TODO m12.11 — terbitkan cookie baru untuk `userId` dan SIMPAN hash-nya (bukan
 * nilainya) bersama `{ userId, failures: 0, expiresAt }`, dalam transaksi. Cookie lama
 * yang dikirim browser (`presented`) dan milik akun yang sama dihapus (rotasi).
 * Versi starter hanya membuat token acak yang tidak pernah diingat.
 */
export function issueDevice(
  _userId: string,
  _presented?: string,
  now = Date.now(),
): { token: string; expiresAt: number } {
  return { token: randomBytes(32).toString('base64url'), expiresAt: now + config.device.ttlMs };
}

/**
 * TODO m12.11 — true hanya bila hash cookie dikenal, MILIK akun ini (cookie akun lain
 * tidak membuka kunci), dan belum kedaluwarsa. Versi starter tidak pernah percaya.
 */
export function isTrustedDevice(
  _token: string | undefined,
  _userId: string,
  _now = Date.now(),
): boolean {
  return false;
}

/**
 * TODO m12.11 — hitung satu password salah pada cookie ini; pada
 * `config.device.maxFailures` cookie dihapus, supaya cookie curian hanya memberi
 * beberapa tebakan.
 */
export function recordDeviceFailure(_token: string): void {}

// Dipakai implementasi di atas; dibiarkan agar starter tetap lolos typecheck.
void hash;

/** Forgets every device of an account, e.g. after its password was reset. */
export function forgetDevices(userId: string): void {
  database
    .statement(
      "DELETE FROM records WHERE namespace='devices' AND json_extract(value, '$.userId')=?",
    )
    .run(userId);
}

export function purgeExpiredDevices(now = Date.now(), batch = 500) {
  return database.transaction(() => devices.sweep(now, batch, () => 'delete'));
}
