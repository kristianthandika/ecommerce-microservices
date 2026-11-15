import { randomUUID } from 'node:crypto';
import { database } from './database.ts';
import { AppError } from './middleware/errors.ts';
import { readProducts } from './product-client.ts';
import type { OrderItemInput } from './orders.ts';

export interface Cart {
  version: string;
  items: OrderItemInput[];
  updatedAt: string;
}
const carts = database.store<Cart>('carts');
export function getCart(userId: string): Cart {
  const existing = carts.get(userId);
  if (existing) return existing;
  const cart = { version: randomUUID(), items: [], updatedAt: new Date().toISOString() };
  carts.insert(userId, cart);
  return carts.get(userId)!;
}
export function changeItem(
  userId: string,
  productId: string,
  quantity: number,
  mode: 'add' | 'set' | 'remove',
  expectedVersion?: string,
  // 412 when the version came from If-Match (HTTP precondition), 409 for the
  // deprecated `version` body field, so old clients see unchanged behavior.
  conflictStatus: 409 | 412 = 409,
): Cart {
  return database.transaction(() => {
    const cart = getCart(userId);
    if (expectedVersion && cart.version !== expectedVersion)
      throw new AppError(
        conflictStatus,
        'Keranjang berubah. Muat ulang dahulu.',
        undefined,
        'CART_CHANGED',
      );
    const items = new Map(cart.items.map((item) => [item.productId, item.quantity]));
    const next = mode === 'add' ? (items.get(productId) ?? 0) + quantity : quantity;
    if (mode === 'remove') items.delete(productId);
    else {
      if (!Number.isInteger(next) || next < 1 || next > 1000)
        throw new AppError(400, 'Jumlah item harus 1-1000', undefined, 'INVALID_QUANTITY');
      items.set(productId, next);
    }
    if (items.size > 50) throw new AppError(400, 'Maksimal 50 produk dalam keranjang');
    const updated = {
      version: randomUUID(),
      items: [...items].map(([id, count]) => ({ productId: id, quantity: count })),
      updatedAt: new Date().toISOString(),
    };
    carts.set(userId, updated);
    return updated;
  });
}
export function clearCart(userId: string, expectedVersion?: string): void {
  const cart = getCart(userId);
  if (expectedVersion && cart.version !== expectedVersion) return;
  carts.set(userId, { version: randomUUID(), items: [], updatedAt: new Date().toISOString() });
}
/** A definitely failed attempt may be tried again without changing item quantities. */
export function renewCartVersion(userId: string, expectedVersion: string): void {
  const cart = getCart(userId);
  if (cart.version === expectedVersion)
    carts.set(userId, { ...cart, version: randomUUID(), updatedAt: new Date().toISOString() });
}
export async function describeCart(userId: string, ctx: { correlationId?: string } = {}) {
  const cart = getCart(userId);
  const products = cart.items.length
    ? await readProducts(
        cart.items.map((item) => item.productId),
        ctx,
      )
    : [];
  const lines = cart.items.map((item) => {
    const product = products.find((p) => p.id === item.productId);
    return {
      ...item,
      name: product?.name ?? 'Produk tidak tersedia',
      unitPrice: product?.price ?? 0,
      stock: product?.stock ?? 0,
      available: !!product && product.stock >= item.quantity,
      subtotal: (product?.price ?? 0) * item.quantity,
    };
  });
  return {
    ...cart,
    items: lines,
    total: lines.reduce((sum, item) => sum + item.subtotal, 0),
    quantity: lines.reduce((sum, item) => sum + item.quantity, 0),
    canCheckout: lines.length > 0 && lines.every((item) => item.available),
  };
}
