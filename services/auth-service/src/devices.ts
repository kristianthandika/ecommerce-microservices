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

/** A new device cookie for `userId`; the one the browser presented, if any, is retired. */
export function issueDevice(
  userId: string,
  presented?: string,
  now = Date.now(),
): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + config.device.ttlMs;
  database.transaction(() => {
    if (presented && devices.get(hash(presented))?.userId === userId)
      devices.delete(hash(presented));
    devices.insert(hash(token), { userId, failures: 0, expiresAt }, expiresAt);
  });
  return { token, expiresAt };
}

/** True when the cookie was issued to this very account and has not been used up. */
export function isTrustedDevice(
  token: string | undefined,
  userId: string,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const device = devices.get(hash(token));
  return device !== undefined && device.userId === userId && device.expiresAt > now;
}

/** Counts a wrong password against the cookie and discards it at the limit. */
export function recordDeviceFailure(token: string): void {
  database.transaction(() => {
    const key = hash(token);
    const device = devices.get(key);
    if (!device) return;
    if (device.failures + 1 >= config.device.maxFailures) devices.delete(key);
    else devices.set(key, { ...device, failures: device.failures + 1 });
  });
}

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
