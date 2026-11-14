import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPage } from '../pages/AdminPage';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { api } from '../api/client';

const { session } = vi.hoisted(() => ({ session: { role: 'admin' } }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    token: 'admin-token',
    user: { id: 'u1', email: 'admin@test.local', role: session.role },
    logout: vi.fn(),
    ready: true,
  }),
}));
vi.mock('../context/CartContext', () => ({ useCart: () => ({ cart: null }) }));
beforeEach(() => {
  session.role = 'admin';
  vi.spyOn(api, 'outbox').mockResolvedValue({ messages: [] });
});
afterEach(() => vi.restoreAllMocks());
describe('admin UI', () => {
  it('saves product edits with the original revision to protect stock', async () => {
    const product = { id: 'p1', name: 'Limited', price: 100, stock: 5, revision: 7 };
    vi.spyOn(api, 'products').mockResolvedValue({ products: [product], total: 1 });
    vi.spyOn(api, 'orderSummary').mockResolvedValue({
      totalOrders: 0,
      confirmedOrders: 0,
      pendingOrders: 0,
      failedOrders: 0,
      cancelledOrders: 0,
      confirmedValue: 0,
      processingOrders: 0,
    });
    vi.spyOn(api, 'productSummary').mockResolvedValue({
      totalProducts: 1,
      lowStock: 1,
      outOfStock: 0,
    });
    const update = vi
      .spyOn(api, 'updateProduct')
      .mockResolvedValue({ product: { ...product, price: 200, revision: 8 } });
    render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Limited' }));
    fireEvent.change(screen.getByLabelText('Harga (Rp)'), { target: { value: '200' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Simpan produk' }));
    });
    expect(update).toHaveBeenCalledWith(
      'p1',
      { name: 'Limited', price: 200, stock: 5, expectedRevision: 7 },
      'admin-token',
    );
    expect(await screen.findByText('Produk berhasil diperbarui')).toBeInTheDocument();
  });
  it('redirects customers away from administrator routes', async () => {
    session.role = 'user';
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route
            path="/admin"
            element={
              <ProtectedRoute admin>
                <p>Private admin</p>
              </ProtectedRoute>
            }
          />
          <Route path="/dashboard" element={<h1>Katalog pelanggan</h1>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Katalog pelanggan')).toBeInTheDocument();
    expect(screen.queryByText('Private admin')).not.toBeInTheDocument();
  });
});
