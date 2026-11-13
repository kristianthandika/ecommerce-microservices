import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckoutPage } from '../pages/CheckoutPage';
import { OrderDetailPage } from '../pages/OrderDetailPage';
import { api, ApiError, type Order } from '../api/client';
const { reload } = vi.hoisted(() => ({ reload: vi.fn(async () => null) }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    token: 'test-token',
    user: { id: 'u1', email: 'test@test.local', role: 'user' },
    logout: vi.fn(),
    ready: true,
  }),
}));
vi.mock('../context/CartContext', () => ({
  useCart: () => ({
    cart: {
      version: 'cart-version',
      items: [
        {
          productId: 'p1',
          name: 'Limited',
          unitPrice: 100,
          subtotal: 200,
          quantity: 2,
          stock: 5,
          available: true,
        },
      ],
      quantity: 2,
      total: 200,
      canCheckout: true,
    },
    reload,
  }),
}));
afterEach(() => vi.restoreAllMocks());
describe('order cancellation', () => {
  const confirmed: Order = {
    id: 'o1',
    userId: 'u1',
    items: [{ productId: 'p1', name: 'Limited', unitPrice: 100, quantity: 2, subtotal: 200 }],
    total: 200,
    status: 'CONFIRMED',
    fulfillmentStatus: 'NEW',
    createdAt: new Date().toISOString(),
  };
  const renderDetail = () =>
    render(
      <MemoryRouter initialEntries={[`/orders/${confirmed.id}`]}>
        <Routes>
          <Route path="/orders/:id" element={<OrderDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

  it('asks for confirmation, sends the reason and shows the cancelled order', async () => {
    vi.spyOn(api, 'order').mockResolvedValue({ order: confirmed });
    const cancel = vi.spyOn(api, 'cancelOrder').mockResolvedValue({
      order: { ...confirmed, status: 'CANCELLED', cancelledBy: 'customer', cancelReason: 'Ganti' },
    });
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Batalkan pesanan' }));
    fireEvent.change(screen.getByLabelText('Alasan (opsional)'), { target: { value: 'Ganti' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ya, batalkan' }));
    });
    expect(cancel).toHaveBeenCalledWith('o1', 'test-token', false, 'Ganti');
    expect(
      await screen.findByText('Pesanan dibatalkan dan stok dikembalikan.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Batalkan pesanan' })).not.toBeInTheDocument();
  });

  it('offers no cancellation to customers once processing has started', async () => {
    vi.spyOn(api, 'order').mockResolvedValue({
      order: { ...confirmed, fulfillmentStatus: 'PROCESSING' },
    });
    renderDetail();
    expect(await screen.findByText('#o1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Batalkan pesanan' })).not.toBeInTheDocument();
  });
});
describe('checkout submission', () => {
  it('blocks double submission, reuses an ambiguous attempt key and navigates to order detail', async () => {
    let reject!: (reason: Error) => void;
    const submit = vi
      .spyOn(api, 'checkout')
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, rejectPromise) => {
            reject = rejectPromise;
          }),
      )
      .mockResolvedValue({ order: { id: 'order-1' } as Order });
    render(
      <MemoryRouter initialEntries={['/checkout']}>
        <Routes>
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/orders/:id" element={<h1>Detail berhasil</h1>} />
        </Routes>
      </MemoryRouter>,
    );
    for (const [name, value] of Object.entries({
      recipient: 'Test Buyer',
      phone: '081234567890',
      street: 'Jalan Test 123',
      city: 'Bandung',
      province: 'Jawa Barat',
      postalCode: '40123',
    })) {
      fireEvent.change(document.querySelector(`[name="${name}"]`)!, { target: { value } });
    }
    const button = screen.getByRole('button', { name: 'Konfirmasi pesanan' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    await act(async () => {
      reject(new ApiError('Network failed', 0));
    });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByText('Detail berhasil')).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0][2]).toBe(submit.mock.calls[1][2]);
    expect(submit.mock.calls[1][1].postalCode).toBe('40123');
    expect(reload).toHaveBeenCalled();
  });
});
