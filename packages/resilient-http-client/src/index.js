/**
 * Resilient HTTP client — DITULIS MANUAL DARI NOL (m2.2).
 *
 * Tiga wrapper composable di atas native `fetch` (Node 24). Tujuan pelatihan:
 * memahami mekanisme resilience tanpa library (opossum/axios-retry). Setiap
 * wrapper menerima fungsi ber-signature `fetch` (url, options) => Promise<Response>
 * dan mengembalikan fungsi dengan signature yang sama, jadi bisa ditumpuk.
 */

/** Error saat request melewati batas waktu. */
export class TimeoutError extends Error {
  constructor(ms) {
    super(`Request melewati timeout ${ms}ms`);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

/** Error saat circuit breaker sedang OPEN — ditolak cepat tanpa memanggil target. */
export class CircuitOpenError extends Error {
  constructor(name) {
    super(`Circuit breaker OPEN untuk "${name}" — request ditolak cepat`);
    this.name = 'CircuitOpenError';
    this.code = 'ECIRCUITOPEN';
  }
}

/** Error saat server target mengembalikan status 5xx (dianggap kegagalan). */
export class ServerError extends Error {
  constructor(status) {
    super(`Server merespons dengan status ${status}`);
    this.name = 'ServerError';
    this.code = 'ESERVER';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * withTimeout — batalkan request yang lebih lama dari `ms` lewat AbortController.
 * Kalau caller sudah memberi `options.signal`, kedua signal digabung supaya
 * pembatalan dari mana pun tetap dihormati.
 */
export function withTimeout(fetchFn, ms) {
  return async (url, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    // Gabungkan signal caller (kalau ada) dengan signal timeout kita.
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      return await fetchFn(url, { ...options, signal: controller.signal });
    } catch (err) {
      // Bedakan abort karena timeout dari error lain, supaya pesannya jelas.
      if (err?.name === 'AbortError' && controller.signal.aborted) {
        throw new TimeoutError(ms);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * withRetry — coba ulang saat gagal, dengan exponential backoff + jitter
 * (WAJIB, bukan retry linear). Delay attempt ke-n = baseDelayMs * 2^n, lalu
 * "full jitter" (acak 0..delay) untuk menghindari thundering herd.
 *
 * Hanya error yang di-`throw` yang di-retry (network error, TimeoutError,
 * ServerError 5xx). Response 4xx TIDAK di-retry (itu kesalahan klien).
 */
export function withRetry(fetchFn, { retries = 3, baseDelayMs = 100, jitter = true } = {}) {
  return async (url, options = {}) => {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fetchFn(url, options);
      } catch (err) {
        lastError = err;
        if (attempt === retries) break; // percobaan terakhir gagal → menyerah
        const exp = baseDelayMs * 2 ** attempt;
        const delay = jitter ? Math.random() * exp : exp;
        await sleep(delay); // WAJIB di-await — kalau tidak, retry jadi spam tanpa jeda
      }
    }
    throw lastError;
  };
}

/**
 * withCircuitBreaker — state machine CLOSED → OPEN → HALF_OPEN → CLOSED.
 *
 * PENTING: state (`failures`, `state`, `nextAttempt`) disimpan di closure yang
 * dibuat SEKALI saat wrapper dipanggil, jadi persist antar-request. Kalau
 * state dibuat ulang di tiap panggilan, breaker tidak akan pernah OPEN.
 *
 * - CLOSED: teruskan; hitung kegagalan beruntun. `failureThreshold` kegagalan → OPEN.
 * - OPEN: tolak cepat (CircuitOpenError) tanpa memanggil target, sampai
 *   `resetTimeoutMs` lewat → HALF_OPEN.
 * - HALF_OPEN: izinkan SATU percobaan; sukses → CLOSED (reset), gagal → OPEN lagi.
 */
export function withCircuitBreaker(
  fetchFn,
  { failureThreshold = 5, resetTimeoutMs = 10000, name = 'upstream', onStateChange } = {},
) {
  let state = 'CLOSED';
  let failures = 0;
  let nextAttempt = 0;

  const transition = (next) => {
    if (state !== next) {
      state = next;
      onStateChange?.(next);
    }
  };

  return async (url, options = {}) => {
    if (state === 'OPEN') {
      if (Date.now() < nextAttempt) throw new CircuitOpenError(name);
      transition('HALF_OPEN'); // waktu reset lewat → coba sekali
    }

    try {
      const res = await fetchFn(url, options);
      // Sukses → tutup lagi & reset counter.
      failures = 0;
      transition('CLOSED');
      return res;
    } catch (err) {
      failures += 1;
      if (state === 'HALF_OPEN' || failures >= failureThreshold) {
        transition('OPEN');
        nextAttempt = Date.now() + resetTimeoutMs;
      }
      throw err;
    }
  };
}

/**
 * Wrapper opsional: anggap response 5xx sebagai kegagalan (di-throw ServerError)
 * supaya retry & circuit breaker bereaksi terhadapnya. 4xx dibiarkan lewat.
 */
export function throwOnServerError(fetchFn) {
  return async (url, options = {}) => {
    const res = await fetchFn(url, options);
    if (res.status >= 500) throw new ServerError(res.status);
    return res;
  };
}

/**
 * createResilientClient — susun keempat wrapper dengan urutan yang benar:
 *
 *   circuitBreaker( retry( throwOnServerError( timeout( fetch ) ) ) )
 *
 * Nesting ini penting: setiap percobaan retry punya timeout sendiri; breaker
 * menghitung SATU kegagalan per rangkaian retry yang habis; saat OPEN, breaker
 * menolak duluan sehingga retry & fetch tidak dipanggil sama sekali.
 *
 * Mengembalikan fungsi `fetch`-like (url, options) => Promise<Response>.
 */
export function createResilientClient({
  fetchImpl = fetch,
  timeoutMs = 2000,
  retries = 2,
  baseDelayMs = 100,
  jitter = true,
  failureThreshold = 3,
  resetTimeoutMs = 5000,
  name = 'upstream',
  treat5xxAsFailure = true,
  onStateChange,
} = {}) {
  let layer = withTimeout(fetchImpl, timeoutMs);
  if (treat5xxAsFailure) layer = throwOnServerError(layer);
  layer = withRetry(layer, { retries, baseDelayMs, jitter });
  layer = withCircuitBreaker(layer, { failureThreshold, resetTimeoutMs, name, onStateChange });
  return layer;
}
