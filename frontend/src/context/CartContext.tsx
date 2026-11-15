import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, type Cart } from '../api/client';
import { useAuth } from './AuthContext';

interface CartState {
  cart: Cart | null;
  busy: boolean;
  error: string;
  reload: () => Promise<Cart | null>;
  add: (id: string) => Promise<void>;
  setQuantity: (id: string, quantity: number) => Promise<void>;
  remove: (id: string) => Promise<void>;
}
const CartContext = createContext<CartState | null>(null);
export function CartProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const session = useRef(token);
  session.current = token;
  const locked = useRef(false);
  const [cart, setCart] = useState<Cart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reading = useRef<{ token: string; work: Promise<Cart | null> } | null>(null);
  const generation = useRef(0);
  const reload = useCallback(
    (force = false): Promise<Cart | null> => {
      if (!token) return Promise.resolve(null);
      if (!force && reading.current?.token === token) return reading.current.work;
      const revision = ++generation.current;
      const work = (async () => {
        try {
          const { cart: updated } = await api.cart(token);
          if (session.current === token && revision === generation.current) {
            setCart(updated);
            setError('');
          }
          return updated;
        } catch (err) {
          if (session.current === token && revision === generation.current)
            setError(err instanceof Error ? err.message : 'Gagal memuat keranjang');
          throw err;
        } finally {
          if (revision === generation.current) reading.current = null;
        }
      })();
      reading.current = { token, work };
      return work;
    },
    [token],
  );
  useEffect(() => {
    setCart(null);
    setError('');
    if (token) void reload().catch(() => {});
  }, [token, reload]);
  async function mutate(id: string, quantity?: number, increment = false) {
    if (!token || locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const current = cart ?? (await reload());
      if (!current) throw new Error('Silakan masuk kembali');
      if (quantity === undefined) await api.removeCartItem(id, current.version, token);
      else
        await api.setCartItem(
          id,
          increment
            ? (current.items.find((item) => item.productId === id)?.quantity ?? 0) + quantity
            : quantity,
          current.version,
          token,
        );
      await reload(true);
    } catch (err) {
      await reload(true).catch(() => {});
      throw err;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <CartContext.Provider
      value={{
        cart,
        busy,
        error,
        reload,
        add: (id) => mutate(id, 1, true),
        setQuantity: (id, quantity) => mutate(id, quantity),
        remove: (id) => mutate(id),
      }}
    >
      {children}
    </CartContext.Provider>
  );
}
export function useCart() {
  const state = useContext(CartContext);
  if (!state) throw new Error('CartProvider diperlukan');
  return state;
}
