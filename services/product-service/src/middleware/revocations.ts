// TODO m12.7 — butuh `import { AppError } from './errors.ts';` untuk jawaban 503.

/**
 * Upper bound of one snapshot. It must cover the largest list the caller accepts
 * (100,000 sessions at roughly 70 bytes each): a smaller limit turns a busy hour of
 * logouts, or a login/logout flood from a handful of addresses, into 503 for every
 * signed-in user, because an unreadable list fails closed.
 */
export const MAX_SNAPSHOT_BYTES = 8 * 1_048_576;

/** Fixed operator URL, no redirects, bounded body and deadline including its stream. */
export async function fetchRevocationSnapshot(url: string, serviceToken: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { 'x-service-token': serviceToken },
    signal: AbortSignal.timeout(1000),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Revocation list answered ${response.status}`);
  }
  if (!response.body) throw new Error('Empty revocation snapshot');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Revocation snapshot exceeds size limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}

export interface RevocationCheckerOptions {
  /** How old the list may be before the next check waits for a refresh. */
  maxAgeMs?: number;
  /** Minimum distance between refresh attempts after a failure. */
  cooldownMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

/**
 * Tells whether a session (`sid` claim) was revoked, from a short list that
 * auth-service publishes for other services.
 *
 * A JWT is verified locally, so nothing would otherwise stop a token after logout
 * until it expires. Asking auth-service on every request would undo distributed
 * verification, so the whole list is cached instead:
 *
 * 1. A list younger than `maxAgeMs` answers from memory, with no network call.
 * 2. An older list is refreshed first, and the request waits for it, so a revoked
 *    session is refused at most `maxAgeMs` after the logout (also after idle time).
 * 3. A failed refresh cannot authorize a session against stale data. Known revoked
 *    sessions remain rejected; all others receive 503 until a fresh list is read.
 *    Attempts are coalesced and back off, including on the very first failure.
 */
export function createRevocationChecker(
  _fetchRevoked: () => Promise<Iterable<string>>,
  _options: RevocationCheckerOptions = {},
): (sid: string) => Promise<boolean> {
  // TODO m12.7 — versi starter menerima SEMUA sesi, jadi access token yang sudah
  // logout tetap berlaku sampai kedaluwarsa (15 menit). Implementasikan:
  // 1. simpan daftar sid yang dicabut + waktu refresh terakhir yang BERHASIL;
  // 2. daftar lebih muda dari `maxAgeMs` → jawab dari memory tanpa network;
  // 3. daftar lebih tua → refresh dulu (request menunggu); request bersamaan
  //    berbagi SATU fetch; setelah gagal, tunggu `cooldownMs` sebelum mencoba lagi;
  // 4. sid yang pernah terlihat dicabut tetap ditolak walau refresh gagal;
  // 5. tidak ada daftar segar → lempar AppError 503 SESSION_CHECK_UNAVAILABLE
  //    (fail closed: jangan menerima sesi berdasarkan data basi).
  return async () => false;
}
