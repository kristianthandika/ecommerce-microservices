import { AppError } from './errors.ts';

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
  fetchRevoked: () => Promise<Iterable<string>>,
  { maxAgeMs = 5000, cooldownMs = 5000, now = Date.now, onError }: RevocationCheckerOptions = {},
): (sid: string) => Promise<boolean> {
  let revoked = new Set<string>();
  let fetchedAt: number | undefined; // last SUCCESSFUL refresh
  let failedAt: number | undefined;
  let refreshing: Promise<void> | undefined;

  function refresh(): Promise<void> {
    if (!refreshing) {
      const startedAt = now();
      // Concurrent requests share one fetch.
      refreshing = Promise.resolve()
        .then(fetchRevoked)
        .then((next) => {
          revoked = new Set(next);
          fetchedAt = startedAt;
          failedAt = undefined;
        })
        .catch((err: unknown) => {
          failedAt = now();
          onError?.(err);
        })
        .finally(() => {
          refreshing = undefined;
        });
    }
    return refreshing;
  }

  return async (sid) => {
    // A revoked session cannot become valid again; no network is needed to deny it.
    if (revoked.has(sid)) return true;
    const fresh = fetchedAt !== undefined && now() - fetchedAt < maxAgeMs;
    if (!fresh) {
      const failedRecently = failedAt !== undefined && now() - failedAt < cooldownMs;
      if (refreshing || !failedRecently) await refresh();
    }
    if (revoked.has(sid)) return true;
    if (fetchedAt === undefined || now() - fetchedAt >= maxAgeMs)
      throw new AppError(
        503,
        'Status sesi belum dapat diverifikasi. Coba lagi sebentar.',
        undefined,
        'SESSION_CHECK_UNAVAILABLE',
      );
    return revoked.has(sid);
  };
}
