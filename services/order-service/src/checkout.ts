import { database } from './database.ts';
import { getCart, clearCart } from './cart.ts';
import { createOrder, findOrderByKey, type OrderItemInput } from './orders.ts';
import { AppError } from './middleware/errors.ts';
import type { ShippingAddress } from './schemas.ts';
import { config } from './config.ts';

interface Ticket {
  key: string;
  address: string;
  items: OrderItemInput[];
}
const tickets = database.store<Ticket>('checkout_tickets');
const checkoutKeys = database.store<string>('checkout_keys');
/** A cart version creates at most one order, even if two clients choose different keys. */
export async function checkoutCart(
  userId: string,
  version: string,
  shippingAddress: ShippingAddress,
  ctx: { idempotencyKey: string; correlationId?: string; signal?: AbortSignal },
) {
  const ticketId = JSON.stringify([userId, version]);
  const address = JSON.stringify(shippingAddress);
  const ticket = database.transaction(() => {
    const key = JSON.stringify([userId, ctx.idempotencyKey]);
    const assignedVersion = checkoutKeys.get(key);
    if (assignedVersion && assignedVersion !== version)
      throw new AppError(409, 'Idempotency-Key sudah digunakan', undefined, 'IDEMPOTENCY_CONFLICT');
    const existing = tickets.get(ticketId);
    if (existing) {
      if (existing.address !== address)
        throw new AppError(
          409,
          'Checkout ini sudah memakai alamat berbeda',
          undefined,
          'CHECKOUT_CONFLICT',
        );
      // A supplied key belonging to another order must never silently replay this cart.
      const reused = findOrderByKey(userId, ctx.idempotencyKey);
      if (reused && reused.cartVersion !== version)
        throw new AppError(
          409,
          'Idempotency-Key sudah digunakan',
          undefined,
          'IDEMPOTENCY_CONFLICT',
        );
      checkoutKeys.insert(key, version, Date.now() + config.idempotencyRetentionMs);
      return existing;
    }
    if (findOrderByKey(userId, ctx.idempotencyKey))
      throw new AppError(409, 'Idempotency-Key sudah digunakan', undefined, 'IDEMPOTENCY_CONFLICT');
    const cart = getCart(userId);
    if (cart.version !== version)
      throw new AppError(
        409,
        'Keranjang berubah. Periksa kembali sebelum checkout.',
        undefined,
        'CART_CHANGED',
      );
    if (!cart.items.length)
      throw new AppError(400, 'Keranjang masih kosong', undefined, 'EMPTY_CART');
    const created = { key: ctx.idempotencyKey, address, items: cart.items };
    const expiresAt = Date.now() + config.idempotencyRetentionMs;
    tickets.insert(ticketId, created, expiresAt);
    checkoutKeys.insert(key, version, expiresAt);
    return created;
  });
  const order = await createOrder(
    { userId, items: ticket.items, shippingAddress, cartVersion: version },
    { ...ctx, idempotencyKey: ticket.key },
  );
  // Only a confirmed order consumed the cart. A checkout cancelled while it was in
  // flight keeps its items so the customer can try again. Concurrent additions
  // create a new cart version and are intentionally preserved.
  if (order.status === 'CONFIRMED') database.transaction(() => clearCart(userId, version));
  return order;
}
