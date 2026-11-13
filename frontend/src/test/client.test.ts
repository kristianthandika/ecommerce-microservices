import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('API client', () => {
  it('sends the cart version as If-Match and DELETE without a body', async () => {
    const fetch = vi.fn(async () => json({ cart: {} }));
    vi.stubGlobal('fetch', fetch);
    await api.removeCartItem('p1', 'cart-v1', 'token');
    await api.setCartItem('p1', 3, 'cart-v2', 'token');
    const [, remove] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const [, update] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    const removeHeaders = remove.headers as Record<string, string>;
    expect(removeHeaders['if-match']).toBe('"cart-v1"');
    expect(removeHeaders['content-type']).toBeUndefined();
    expect(remove.body).toBeUndefined();
    expect((update.headers as Record<string, string>)['if-match']).toBe('"cart-v2"');
    expect(JSON.parse(String(update.body))).toEqual({ quantity: 3 });
  });

  it('shares one refresh request between concurrent callers and retries a tab race once', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: 'REFRESH_RACE', message: 'race' } }, 409))
      .mockResolvedValueOnce(json({ token: 't', user: { id: '1', email: 'a@b.c', role: 'user' } }));
    vi.stubGlobal('fetch', fetch);
    const [a, b] = await Promise.all([api.refresh(), api.refresh()]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(2); // one request + one retry, not four
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe('fetch');
    expect(init.credentials).toBe('same-origin');
  });
});
