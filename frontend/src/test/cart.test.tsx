import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CartProvider, useCart } from '../context/CartContext';
import { CartPage } from '../pages/CartPage';
import { api, type Cart } from '../api/client';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    token: 'cart-token',
    user: { id: 'u1', email: 'buyer@test.local', role: 'user' },
    logout: vi.fn(),
    ready: true,
  }),
}));
const current: Cart = {
  version: 'v1',
  quantity: 2,
  total: 200,
  canCheckout: true,
  updatedAt: '',
  items: [
    {
      productId: 'p1',
      name: 'Product',
      quantity: 2,
      unitPrice: 100,
      subtotal: 200,
      stock: 5,
      available: true,
    },
  ],
};
afterEach(() => vi.restoreAllMocks());
function Harness() {
  const { cart, add } = useCart();
  return (
    <>
      <p>Quantity {cart?.quantity ?? 0}</p>
      <button onClick={() => void add('p1')}>Add</button>
    </>
  );
}
describe('persistent cart UI', () => {
  it('increments an existing saved quantity using the current version', async () => {
    vi.spyOn(api, 'cart')
      .mockResolvedValueOnce({ cart: current })
      .mockResolvedValue({ cart: { ...current, version: 'v2', quantity: 3 } });
    const set = vi.spyOn(api, 'setCartItem').mockResolvedValue({ cart: current });
    render(
      <CartProvider>
        <Harness />
      </CartProvider>,
    );
    expect(await screen.findByText('Quantity 2')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText('Add'));
    });
    expect(set).toHaveBeenCalledWith('p1', 3, 'v1', 'cart-token');
    expect(await screen.findByText('Quantity 3')).toBeInTheDocument();
  });
  it('lets a user remove an unavailable product and returns to the empty state', async () => {
    vi.spyOn(api, 'cart')
      .mockResolvedValueOnce({
        cart: {
          ...current,
          canCheckout: false,
          items: [{ ...current.items[0], available: false, stock: 0 }],
        },
      })
      .mockResolvedValue({
        cart: { ...current, version: 'v2', items: [], quantity: 0, total: 0, canCheckout: false },
      });
    const remove = vi.spyOn(api, 'removeCartItem').mockResolvedValue({ cart: current });
    render(
      <MemoryRouter>
        <CartProvider>
          <CartPage />
        </CartProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Stok tersedia 0/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Periksa stok dahulu' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Hapus Product' }));
    expect(await screen.findByText('Keranjang masih kosong')).toBeInTheDocument();
    expect(remove).toHaveBeenCalledWith('p1', 'v1', 'cart-token');
  });
});
