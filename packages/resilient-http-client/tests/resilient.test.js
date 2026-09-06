import { describe, it, expect, vi } from 'vitest';
import {
  withTimeout,
  withRetry,
  withCircuitBreaker,
  createResilientClient,
  TimeoutError,
  CircuitOpenError,
} from '../src/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const okResponse = () => new Response('ok', { status: 200 });

describe('withTimeout', () => {
  it('membatalkan request yang lebih lambat dari batas waktu', async () => {
    const slow = (url, options) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(okResponse()), 200);
        options.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const wrapped = withTimeout(slow, 30);
    await expect(wrapped('http://x')).rejects.toBeInstanceOf(TimeoutError);
  });

  it('meneruskan response kalau selesai sebelum timeout', async () => {
    const fast = async () => okResponse();
    const wrapped = withTimeout(fast, 100);
    const res = await wrapped('http://x');
    expect(res.status).toBe(200);
  });
});

describe('withRetry', () => {
  it('mencoba ulang sejumlah retries lalu berhasil', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw new Error('gagal sementara');
      return okResponse();
    };
    const wrapped = withRetry(flaky, { retries: 3, baseDelayMs: 1 });
    const res = await wrapped('http://x');
    expect(res.status).toBe(200);
    expect(calls).toBe(3); // 2 gagal + 1 sukses
  });

  it('menyerah setelah retries habis dan melempar error terakhir', async () => {
    let calls = 0;
    const always = async () => {
      calls += 1;
      throw new Error('selalu gagal');
    };
    const wrapped = withRetry(always, { retries: 2, baseDelayMs: 1 });
    await expect(wrapped('http://x')).rejects.toThrow('selalu gagal');
    expect(calls).toBe(3); // percobaan awal + 2 retry
  });

  it('menggunakan delay yang membesar antar percobaan (exponential backoff)', async () => {
    const delays = [];
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      delays.push(ms);
      fn();
      return 0;
    });
    let calls = 0;
    const always = async () => {
      calls += 1;
      throw new Error('x');
    };
    await withRetry(always, { retries: 3, baseDelayMs: 100, jitter: false })('http://x').catch(
      () => {},
    );
    spy.mockRestore();
    expect(delays).toEqual([100, 200, 400]); // 2^0,2^1,2^2 * base
  });
});

describe('withCircuitBreaker', () => {
  it('OPEN setelah failureThreshold, menolak cepat tanpa memanggil target', async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error('down');
    };
    const wrapped = withCircuitBreaker(failing, { failureThreshold: 3, resetTimeoutMs: 10000 });

    for (let i = 0; i < 3; i += 1) {
      await expect(wrapped('http://x')).rejects.toThrow('down');
    }
    expect(calls).toBe(3);

    // Sekarang OPEN → panggilan berikutnya ditolak cepat, target TIDAK dipanggil lagi.
    await expect(wrapped('http://x')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(3); // tidak bertambah
  });

  it('pindah ke HALF_OPEN setelah resetTimeoutMs lalu CLOSED saat sukses', async () => {
    let shouldFail = true;
    let calls = 0;
    const target = async () => {
      calls += 1;
      if (shouldFail) throw new Error('down');
      return okResponse();
    };
    const states = [];
    const wrapped = withCircuitBreaker(target, {
      failureThreshold: 2,
      resetTimeoutMs: 40,
      onStateChange: (s) => states.push(s),
    });

    await expect(wrapped('http://x')).rejects.toThrow('down');
    await expect(wrapped('http://x')).rejects.toThrow('down'); // → OPEN
    await expect(wrapped('http://x')).rejects.toBeInstanceOf(CircuitOpenError);

    shouldFail = false;
    await sleep(50); // tunggu resetTimeout
    const res = await wrapped('http://x'); // HALF_OPEN → sukses → CLOSED
    expect(res.status).toBe(200);
    expect(states).toContain('OPEN');
    expect(states).toContain('HALF_OPEN');
    expect(states[states.length - 1]).toBe('CLOSED');
  });
});

describe('createResilientClient (komposisi)', () => {
  it('saat OPEN, tidak memanggil fetch asli sama sekali (fail-fast)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error('ECONNREFUSED');
    };
    const client = createResilientClient({
      fetchImpl,
      timeoutMs: 50,
      retries: 0,
      failureThreshold: 2,
      resetTimeoutMs: 10000,
      name: 'product-service',
    });

    await client('http://x').catch(() => {}); // gagal 1
    await client('http://x').catch(() => {}); // gagal 2 → OPEN
    const callsAfterOpen = calls;
    await client('http://x').catch(() => {}); // ditolak cepat
    expect(calls).toBe(callsAfterOpen); // tidak bertambah setelah OPEN
  });
});
