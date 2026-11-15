import { AppError } from './errors.ts';

export interface SigningKeyResolverOptions {
  /** Umur key set; setelah lewat, lookup berikutnya memicu refresh. */
  maxAgeMs?: number;
  /** Jarak minimum antar-fetch JWKS, apa pun pemicunya. */
  cooldownMs?: number;
  /** Batas pemakaian key lama saat endpoint JWKS tidak terjangkau. */
  maxStaleMs?: number;
  now?: () => number;
}

/**
 * Cache SELURUH key set JWKS (bukan per-`kid`) dengan tiga jaminan:
 *
 * 1. `kid` yang sudah dikenal dilayani dari memory — tanpa network.
 * 2. `kid` TAK dikenal hanya boleh memicu fetch sekali per `cooldownMs`. Tanpa
 *    ini, siapa pun bisa mengirim token palsu ber-`kid` acak (tanpa login) dan
 *    menghabiskan kuota fetch JWKS, sehingga user sah ikut ditolak.
 * 3. Kalau refresh gagal (auth-service down), key yang sudah dikenal tetap
 *    dipakai sampai `maxStaleMs` — auth-service yang mati sebentar tidak
 *    menjatuhkan service lain (stale-if-error).
 */
export function createSigningKeyResolver(
  fetchKeys: () => Promise<Map<string, string>>,
  {
    maxAgeMs = 10 * 60_000,
    cooldownMs = 30_000,
    maxStaleMs = 60 * 60_000,
    now = Date.now,
  }: SigningKeyResolverOptions = {},
): (kid: string) => Promise<string> {
  let keys = new Map<string, string>();
  let fetchedAt: number | undefined; // refresh terakhir yang BERHASIL
  let attemptedAt: number | undefined; // percobaan refresh terakhir
  let refreshing: Promise<void> | undefined;

  function refresh(): Promise<void> {
    if (!refreshing) {
      attemptedAt = now();
      // Request konkuren menumpang SATU fetch yang sama.
      refreshing = Promise.resolve()
        .then(fetchKeys)
        .then((next) => {
          keys = next;
          fetchedAt = now();
        })
        .finally(() => {
          refreshing = undefined;
        });
    }
    return refreshing;
  }

  return async (kid) => {
    const fresh = fetchedAt !== undefined && now() - fetchedAt < maxAgeMs;
    const cached = keys.get(kid);
    if (fresh && cached !== undefined) return cached;

    // Sebelum fetch pertama berhasil, coba lagi lebih cepat supaya service
    // segera pulih begitu auth-service siap.
    const wait = fetchedAt === undefined ? Math.min(cooldownMs, 1000) : cooldownMs;
    if (refreshing || attemptedAt === undefined || now() - attemptedAt >= wait) {
      try {
        await refresh();
      } catch {
        // Jatuh ke key yang masih dipegang (kalau ada) di bawah.
      }
    }

    const usable = fetchedAt !== undefined && now() - fetchedAt < maxStaleMs;
    if (!usable)
      throw new AppError(503, 'Signing key tidak tersedia', undefined, 'AUTH_UNAVAILABLE');
    const key = keys.get(kid);
    if (key === undefined) throw new AppError(401, 'Signing key tidak dikenal');
    return key;
  };
}
