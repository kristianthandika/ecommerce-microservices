/**
 * Resilient HTTP client — DITULIS MANUAL DARI NOL (m2.2).
 *
 * Tiga wrapper composable di atas native `fetch` (Node 24). Tujuan pelatihan:
 * memahami mekanisme resilience tanpa library (opossum/axios-retry). Setiap
 * wrapper menerima fungsi ber-signature `fetch` dan mengembalikan fungsi
 * dengan signature yang sama, jadi bisa ditumpuk.
 */

/** Signature fetch-like yang dipakai semua wrapper. */
export type FetchFn = (url: string, options?: RequestInit) => Promise<Response>;

/** Error saat request melewati batas waktu. */
export class TimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(ms: number) {
    super(`Request melewati timeout ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Error saat circuit breaker sedang OPEN — ditolak cepat tanpa memanggil target. */
export class CircuitOpenError extends Error {
  readonly code = 'ECIRCUITOPEN';
  constructor(name: string) {
    super(`Circuit breaker OPEN untuk "${name}" — request ditolak cepat`);
    this.name = 'CircuitOpenError';
  }
}

/** Error saat server target mengembalikan status 5xx (dianggap kegagalan). */
export class ServerError extends Error {
  readonly code = 'ESERVER';
  readonly status: number;
  constructor(status: number) {
    super(`Server merespons dengan status ${status}`);
    this.name = 'ServerError';
    this.status = status;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * withTimeout — batalkan request yang lebih lama dari `ms` lewat AbortController.
 * Kalau caller sudah memberi `options.signal`, kedua signal digabung supaya
 * pembatalan dari mana pun tetap dihormati.
 */
export function withTimeout(fetchFn: FetchFn, ms: number): FetchFn {
  return async (url, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      return await fetchFn(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && controller.signal.aborted) {
        throw new TimeoutError(ms);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  jitter?: boolean;
}

/**
 * withRetry — coba ulang saat gagal, dengan exponential backoff + jitter
 * (WAJIB, bukan retry linear). Delay attempt ke-n = baseDelayMs * 2^n, lalu
 * "full jitter" (acak 0..delay) untuk menghindari thundering herd.
 *
 * Hanya error yang di-`throw` yang di-retry (network error, TimeoutError,
 * ServerError 5xx). Response 4xx TIDAK di-retry (itu kesalahan klien).
 */
export function withRetry(
  fetchFn: FetchFn,
  { retries = 3, baseDelayMs = 100, jitter = true }: RetryOptions = {},
): FetchFn {
  return async (url, options = {}) => {
    let lastError: unknown;
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

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  name?: string;
  onStateChange?: (state: CircuitState) => void;
}

/**
 * withCircuitBreaker — state machine CLOSED → OPEN → HALF_OPEN → CLOSED.
 *
 * PENTING: state (`failures`, `state`, `nextAttempt`) disimpan di closure yang
 * dibuat SEKALI saat wrapper dipanggil, jadi persist antar-request. Kalau
 * state dibuat ulang di tiap panggilan, breaker tidak akan pernah OPEN.
 */
export function withCircuitBreaker(
  fetchFn: FetchFn,
  {
    failureThreshold = 5,
    resetTimeoutMs = 10000,
    name = 'upstream',
    onStateChange,
  }: CircuitBreakerOptions = {},
): FetchFn {
  let state: CircuitState = 'CLOSED';
  let failures = 0;
  let nextAttempt = 0;

  const transition = (next: CircuitState): void => {
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
export function throwOnServerError(fetchFn: FetchFn): FetchFn {
  return async (url, options = {}) => {
    const res = await fetchFn(url, options);
    if (res.status >= 500) throw new ServerError(res.status);
    return res;
  };
}

export interface ResilientClientOptions {
  fetchImpl?: FetchFn;
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  jitter?: boolean;
  failureThreshold?: number;
  resetTimeoutMs?: number;
  name?: string;
  treat5xxAsFailure?: boolean;
  onStateChange?: (state: CircuitState) => void;
}

/**
 * createResilientClient — susun keempat wrapper dengan urutan yang benar:
 *
 *   circuitBreaker( retry( throwOnServerError( timeout( fetch ) ) ) )
 *
 * Nesting ini penting: setiap percobaan retry punya timeout sendiri; breaker
 * menghitung SATU kegagalan per rangkaian retry yang habis; saat OPEN, breaker
 * menolak duluan sehingga retry & fetch tidak dipanggil sama sekali.
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
}: ResilientClientOptions = {}): FetchFn {
  let layer: FetchFn = withTimeout(fetchImpl, timeoutMs);
  if (treat5xxAsFailure) layer = throwOnServerError(layer);
  layer = withRetry(layer, { retries, baseDelayMs, jitter });
  layer = withCircuitBreaker(layer, { failureThreshold, resetTimeoutMs, name, onStateChange });
  return layer;
}
