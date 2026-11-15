import { describe, it, expect } from 'vitest';
import { createSigningKeyResolver } from '../src/middleware/signing-keys.ts';

function setup(initial: Record<string, string> = { known: 'PUBLIC-KEY' }) {
  const state = {
    time: 1_000_000,
    fetches: 0,
    fail: false,
    keys: new Map(Object.entries(initial)),
  };
  const resolve = createSigningKeyResolver(
    async () => {
      state.fetches += 1;
      if (state.fail) throw new Error('auth-service unreachable');
      return new Map(state.keys);
    },
    { maxAgeMs: 600_000, cooldownMs: 30_000, maxStaleMs: 3_600_000, now: () => state.time },
  );
  return { state, resolve };
}

describe('JWKS signing key resolver', () => {
  it('serves known keys from memory after a single fetch', async () => {
    const { state, resolve } = setup();
    await expect(
      Promise.all([resolve('known'), resolve('known'), resolve('known')]),
    ).resolves.toEqual(['PUBLIC-KEY', 'PUBLIC-KEY', 'PUBLIC-KEY']);
    await resolve('known');
    expect(state.fetches).toBe(1);
  });

  it('never lets forged key IDs trigger more than one fetch per cooldown', async () => {
    const { state, resolve } = setup();
    await resolve('known');
    state.time += 30_000;
    for (let i = 0; i < 50; i++)
      await expect(resolve(`forged-${i}`)).rejects.toMatchObject({ status: 401 });
    expect(state.fetches).toBe(2);
    // Legitimate tokens keep working throughout the flood.
    await expect(resolve('known')).resolves.toBe('PUBLIC-KEY');
    expect(state.fetches).toBe(2);
  });

  it('picks up a rotated key once the cooldown has elapsed', async () => {
    const { state, resolve } = setup();
    await resolve('known');
    state.keys.set('rotated', 'NEW-KEY');
    await expect(resolve('rotated')).rejects.toMatchObject({ status: 401 });
    state.time += 30_000;
    await expect(resolve('rotated')).resolves.toBe('NEW-KEY');
  });

  it('keeps verifying with the last known key while the JWKS endpoint is down', async () => {
    const { state, resolve } = setup();
    await resolve('known');
    state.fail = true;
    state.time += 600_000; // key set is now stale and the refresh fails
    await expect(resolve('known')).resolves.toBe('PUBLIC-KEY');
    state.time += 3_600_000; // beyond the stale allowance
    await expect(resolve('known')).rejects.toMatchObject({ status: 503, code: 'AUTH_UNAVAILABLE' });
    state.fail = false;
    state.time += 30_000;
    await expect(resolve('known')).resolves.toBe('PUBLIC-KEY');
  });

  it('reports 503 on a cold start and recovers as soon as the endpoint answers', async () => {
    const { state, resolve } = setup();
    state.fail = true;
    await expect(resolve('known')).rejects.toMatchObject({ status: 503 });
    await expect(resolve('known')).rejects.toMatchObject({ status: 503 });
    expect(state.fetches).toBe(1); // throttled even before the first success
    state.fail = false;
    state.time += 1000;
    await expect(resolve('known')).resolves.toBe('PUBLIC-KEY');
  });
});
