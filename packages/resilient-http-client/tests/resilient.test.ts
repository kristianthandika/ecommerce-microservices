import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi } from 'vitest';
import {
  withTimeout,
  withRetry,
  withCircuitBreaker,
  createResilientClient,
  TimeoutError,
  CircuitOpenError,
} from '../src/index.ts';

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

  it('pembatalan oleh caller diteruskan sebagai AbortError (bukan TimeoutError)', async () => {
    const controller = new AbortController();
    const slow = (_url: string, options: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const wrapped = withTimeout(slow, 1000);
    const p = wrapped('http://x', { signal: controller.signal });
    controller.abort();
    let err: unknown;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((err as Error).name).toBe('AbortError');
  });
});

describe('withRetry', () => {
  it('mencoba ulang sejumlah retries lalu berhasil', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('gagal sementara');
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
      throw new TypeError('selalu gagal');
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
    const always = async () => {
      throw new TypeError('x');
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
    const target = async () => {
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

  it('HALF_OPEN hanya mengizinkan SATU probe walau ada request konkuren', async () => {
    let active = 0;
    let maxActive = 0;
    const target = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(30);
      active -= 1;
      throw new Error('masih gagal'); // probe gagal
    };
    const wrapped = withCircuitBreaker(target, { failureThreshold: 1, resetTimeoutMs: 20 });

    await wrapped('http://x').catch(() => {}); // 1 gagal → OPEN (threshold 1)
    await sleep(30); // > resetTimeout → probe berikutnya diizinkan (HALF_OPEN)

    const results = await Promise.allSettled([wrapped('http://x'), wrapped('http://x')]);
    expect(maxActive).toBe(1); // hanya satu probe menembus ke target
    const reasons = results.map((r) => (r.status === 'rejected' ? r.reason : null));
    expect(reasons.some((e) => e instanceof CircuitOpenError)).toBe(true); // satunya ditolak cepat
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

describe('audit regressions', () => {
  it('enforces timeout after headers while reading a slow body', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.flushHeaders();
      const timer = setTimeout(() => res.end('{}'), 250);
      res.on('close', () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await expect(withTimeout(fetch, 40)(url)).rejects.toBeInstanceOf(TimeoutError);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('does not retry cancellation or unsafe POST requests', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new TypeError('network');
    };
    await withRetry(fn)('http://x', { signal: controller.signal }).catch(() => {});
    expect(calls).toBe(0);
    await withRetry(fn)('http://x', { method: 'POST' }).catch(() => {});
    expect(calls).toBe(1);
  });
  it('ignores a stale successful request after another request opened the breaker', async () => {
    let finish!: (res: Response) => void;
    let calls = 0;
    const target = async () => {
      if (++calls === 1)
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      throw new Error('down');
    };
    const wrapped = withCircuitBreaker(target, { failureThreshold: 1, resetTimeoutMs: 10000 });
    const slow = wrapped('http://x');
    await wrapped('http://x').catch(() => {});
    finish(new Response('ok'));
    await slow;
    await expect(wrapped('http://x')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(2);
  });
  it('cancels oversized responses', async () => {
    await expect(
      withTimeout(async () => new Response('123456'), 100, 5)('http://x'),
    ).rejects.toThrow('size limit');
  });
});
