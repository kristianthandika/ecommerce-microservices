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

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * withTimeout — batalkan request yang lebih lama dari `ms` lewat AbortController.
 * Kalau caller sudah memberi `options.signal`, kedua signal digabung supaya
 * pembatalan dari mana pun tetap dihormati.
 */
export function withTimeout(fetchFn: FetchFn, ms: number, maxBodyBytes = 1_048_576): FetchFn {
  return async (url, options = {}) => {
    const controller = new AbortController();
    let timedOut = false;
    options.signal?.throwIfAborted();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    try {
      const response = await fetchFn(url, { ...options, signal: controller.signal });
      if (!response.body) return response;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBodyBytes) throw new Error('Upstream response exceeds size limit');
          chunks.push(value);
        }
      } catch (err) {
        await reader.cancel().catch(() => {});
        throw err;
      } finally {
        reader.releaseLock();
      }
      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      if (timedOut) throw new TimeoutError(ms);
      throw err;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
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
    const method = (options.method ?? 'GET').toUpperCase();
    const safe =
      ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(method) ||
      new Headers(options.headers).has('idempotency-key');
    const attempts = safe ? retries : 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      options.signal?.throwIfAborted();
      try {
        return await fetchFn(url, options);
      } catch (err) {
        if (options.signal?.aborted || (err instanceof Error && err.name === 'AbortError'))
          throw err;
        const retryable =
          err instanceof TypeError ||
          err instanceof TimeoutError ||
          err instanceof ServerError ||
          (err instanceof Error && /ECONN|network|fetch failed/i.test(err.message));
        if (!retryable) throw err;
        lastError = err;
        if (attempt === attempts) break; // percobaan terakhir gagal → menyerah
        const exp = Math.min(baseDelayMs * 2 ** attempt, 10000);
        const delay = jitter ? Math.random() * exp : exp;
        await sleep(delay, options.signal); // WAJIB di-await — kalau tidak, retry jadi spam tanpa jeda
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
  let generation = 0;
  let probing = false; // true saat SATU probe HALF_OPEN sedang berjalan

  const transition = (next: CircuitState): void => {
    if (state !== next) {
      state = next;
      generation++;
      onStateChange?.(next);
    }
  };

  return async (url, options = {}) => {
    options.signal?.throwIfAborted();
    if (state === 'OPEN') {
      if (Date.now() < nextAttempt) throw new CircuitOpenError(name);
      transition('HALF_OPEN'); // waktu reset lewat → izinkan satu probe
    }

    if (state === 'HALF_OPEN') {
      // Hanya SATU probe yang boleh menembus saat HALF_OPEN; request lain yang
      // datang bersamaan ditolak cepat supaya upstream yang belum pulih tidak
      // dibanjiri (gate probe tunggal, walau ada request konkuren).
      if (probing) throw new CircuitOpenError(name);
      probing = true;
    }

    const requestGeneration = generation;
    try {
      const res = await fetchFn(url, options);
      if (requestGeneration !== generation) return res;
      failures = 0;
      probing = false;
      transition('CLOSED');
      return res;
    } catch (err) {
      if (requestGeneration !== generation) throw err;
      if (options.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        probing = false;
        if (state === 'HALF_OPEN') {
          transition('OPEN');
          nextAttempt = Date.now() + resetTimeoutMs;
        }
        throw err;
      }
      failures += 1;
      probing = false;
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
    if (res.status >= 500) {
      await res.body?.cancel();
      throw new ServerError(res.status);
    }
    return res;
  };
}

export interface ResilientClientOptions {
  fetchImpl?: FetchFn;
  timeoutMs?: number;
  totalTimeoutMs?: number;
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
  totalTimeoutMs = 8000,
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
  return withTimeout(layer, totalTimeoutMs);
}
