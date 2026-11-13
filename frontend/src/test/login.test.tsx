import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

/**
 * Component test alur login (m4.1): user mengisi form → login lewat gateway →
 * halaman terproteksi (dashboard) tampil. `fetch` di-mock per-URL.
 */
function mockFetch(url: string) {
  if (url.endsWith('/auth/login')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          token: `fake.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.token`,
          user: { id: 'u1', email: 'admin@inixindo.local', role: 'admin' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }
  if (new URL(url, 'http://localhost').pathname.endsWith('/products')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          products: [{ id: 'p1', name: 'Kaos Inixindo', price: 120000, stock: 50 }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }
  if (url.endsWith('/cart'))
    return Promise.resolve(
      new Response(
        JSON.stringify({
          cart: { version: 'v1', items: [], quantity: 0, total: 0, canCheckout: false },
        }),
        { status: 200 },
      ),
    );
  if (url.endsWith('/health')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          status: 'ok',
          gateway: 'up',
          services: { auth: 'up', product: 'up', order: 'up' },
          timestamp: '',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }
  return Promise.resolve(new Response('{}', { status: 404 }));
}

describe('alur login frontend', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => mockFetch(String(input))),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('login berhasil → dashboard (halaman terproteksi) tampil', async () => {
    render(<App />);

    // Tanpa token, root diarahkan ke /login.
    expect(await screen.findByRole('heading', { name: 'Masuk' })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.clear(screen.getByRole('textbox', { name: /email/i }));
    await user.type(screen.getByRole('textbox', { name: /email/i }), 'admin@inixindo.local');
    // password field (bukan textbox role)
    const pwd = document.querySelector('input[name="password"]') as HTMLInputElement;
    await user.clear(pwd);
    await user.type(pwd, 'admin123');

    await user.click(screen.getByRole('button', { name: 'Masuk' }));

    // Setelah login → dashboard terproteksi tampil.
    await waitFor(() => expect(screen.getByText('Katalog Produk')).toBeInTheDocument());
    // Produk dimuat async lewat gateway → product-service.
    expect(await screen.findByText('Kaos Inixindo')).toBeInTheDocument();
  });
});
