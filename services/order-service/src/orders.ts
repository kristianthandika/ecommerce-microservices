import { randomUUID, createHash } from 'node:crypto';
import { database } from './database.ts';
import { clearCart, renewCartVersion } from './cart.ts';
import type { ShippingAddress } from './schemas.ts';
import { reserveProducts, releaseReservation } from './product-client.ts';
import { AppError } from './middleware/errors.ts';
import { config } from './config.ts';
import {
  getOrderRow,
  insertOrderRow,
  updateOrderRow,
  unfinishedOrders,
  pageOrders,
  orderSummary,
  clearOrderRows,
  type OrderPageQuery,
} from './order-table.ts';

export interface OrderItemInput {
  productId: string;
  quantity: number;
}
export interface OrderLineItem {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
}
/**
 * Allocation status (does this order hold stock?), kept separate from the
 * fulfillment status (what the warehouse is doing with it).
 *
 *   PENDING ──► CONFIRMED ──► fulfillment NEW → PROCESSING → COMPLETED
 *      │            │
 *      └────────────┴──► CANCELLATION_REQUESTED ──► CANCELLED
 *   PENDING ──► FAILED (terminal, nothing was allocated)
 */
export type OrderStatus =
  'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLATION_REQUESTED' | 'CANCELLED';
export const TERMINAL_STATUSES: readonly OrderStatus[] = ['CONFIRMED', 'FAILED', 'CANCELLED'];
export interface Order {
  id: string;
  userId: string;
  items: OrderLineItem[];
  total: number;
  status: OrderStatus;
  createdAt: string;
  shippingAddress?: ShippingAddress;
  cartVersion?: string;
  fulfillmentStatus?: 'NEW' | 'PROCESSING' | 'COMPLETED';
  updatedAt?: string;
  cancelledBy?: 'customer' | 'admin';
  cancelReason?: string;
  cancelledAt?: string;
}
export interface StoredOrder extends Order {
  input: OrderItemInput[];
  fingerprint: string;
  failureStatus?: number;
}
const keys = database.store<string>('idempotency');
const checkoutKeys = database.store<string>('checkout_keys');
const inFlight = new Map<string, Promise<Order>>();
const publicOrder = (order: StoredOrder): Order => ({
  id: order.id,
  userId: order.userId,
  items: order.items,
  total: order.total,
  status: order.status,
  createdAt: order.createdAt,
  shippingAddress: order.shippingAddress,
  cartVersion: order.cartVersion,
  fulfillmentStatus: order.fulfillmentStatus ?? 'NEW',
  updatedAt: order.updatedAt ?? order.createdAt,
  cancelledBy: order.cancelledBy,
  cancelReason: order.cancelReason,
  cancelledAt: order.cancelledAt,
});
const cancelling = (status: OrderStatus) =>
  status === 'CANCELLATION_REQUESTED' || status === 'CANCELLED';

/** Runs `task` once per key; concurrent callers share the same promise. */
async function single(key: string, task: () => Promise<Order>): Promise<Order> {
  const running = inFlight.get(key);
  if (running) return running;
  if (inFlight.size >= 32)
    throw new AppError(503, 'Layanan order sedang sibuk', undefined, 'OVERLOADED');
  const work = task();
  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Moves an order out of PENDING exactly once. The stored record is re-read inside
 * the transaction and left untouched when something else already settled it, so a
 * late writer can never roll back a confirmation, a cancellation or an admin's
 * fulfillment update.
 */
function settle(id: string, outcome: Partial<StoredOrder> & { status: 'CONFIRMED' | 'FAILED' }) {
  return database.transaction(() => {
    const latest = getOrderRow(id);
    if (!latest) throw new AppError(404, 'Order tidak ditemukan', undefined, 'NOT_FOUND');
    if (latest.status !== 'PENDING') return latest;
    const settled: StoredOrder = { ...latest, ...outcome, updatedAt: new Date().toISOString() };
    updateOrderRow(settled);
    if (latest.cartVersion) {
      if (outcome.status === 'CONFIRMED') clearCart(latest.userId, latest.cartVersion);
      else renewCartVersion(latest.userId, latest.cartVersion);
    }
    return settled;
  });
}

async function complete(
  snapshot: StoredOrder,
  ctx: { correlationId?: string; signal?: AbortSignal },
): Promise<Order> {
  // Callers such as the recovery loop hold snapshots that may be seconds old; only
  // the stored record says whether the order still needs work.
  const order = getOrderRow(snapshot.id) ?? snapshot;
  if (order.status === 'CONFIRMED' || cancelling(order.status)) return publicOrder(order);
  if (order.status === 'FAILED')
    throw new AppError(
      order.failureStatus ?? 409,
      'Order ditolak: produk tidak tersedia',
      undefined,
      'ORDER_REJECTED',
    );
  return single(`reserve:${order.id}`, async () => {
    try {
      const reservation = await reserveProducts(order.id, order.input, ctx);
      return publicOrder(
        settle(order.id, {
          items: reservation.items,
          total: reservation.total,
          status: 'CONFIRMED',
        }),
      );
    } catch (err) {
      // A cancellation that won the race is the real outcome, not this error
      // (product-service rejects reservations that were released meanwhile).
      const latest = getOrderRow(order.id);
      if (latest && cancelling(latest.status)) return publicOrder(latest);
      if (err instanceof AppError && [404, 409].includes(err.status))
        settle(order.id, { status: 'FAILED', failureStatus: err.status });
      // Ambiguous network failure stays PENDING. Retry uses the same reservation ID.
      throw err;
    }
  });
}

/** Second half of a cancellation: returns the stock, then marks the order CANCELLED. */
async function release(
  snapshot: StoredOrder,
  ctx: { correlationId?: string; signal?: AbortSignal },
): Promise<Order> {
  return single(`release:${snapshot.id}`, async () => {
    await releaseReservation(snapshot.id, ctx);
    return publicOrder(
      database.transaction(() => {
        const latest = getOrderRow(snapshot.id)!;
        if (latest.status !== 'CANCELLATION_REQUESTED') return latest;
        const now = new Date().toISOString();
        const cancelled: StoredOrder = {
          ...latest,
          status: 'CANCELLED',
          cancelledAt: now,
          updatedAt: now,
        };
        updateOrderRow(cancelled);
        // A checkout cancelled before confirmation still has its items in the cart:
        // give the cart a new version so the customer can check out again.
        if (latest.cartVersion) renewCartVersion(latest.userId, latest.cartVersion);
        return cancelled;
      }),
    );
  });
}

export type CancelActor = { role: 'customer'; userId: string } | { role: 'admin' };

/**
 * Cancels an order (saga with compensation). The intent is stored durably first,
 * then stock is released; if product-service is unreachable the order stays
 * CANCELLATION_REQUESTED and the recovery loop finishes the job.
 *
 * Customers may cancel until the warehouse starts processing; administrators may
 * cancel anything not yet completed.
 */
export async function cancelOrder(
  id: string,
  actor: CancelActor,
  reason: string | undefined,
  ctx: { correlationId?: string; signal?: AbortSignal } = {},
): Promise<{ order: Order; completed: boolean }> {
  const requested = database.transaction(() => {
    const order = getOrderRow(id);
    // Same 404 for "missing" and "someone else's" so IDs cannot be probed.
    if (!order || (actor.role === 'customer' && order.userId !== actor.userId))
      throw new AppError(404, 'Order tidak ditemukan', undefined, 'NOT_FOUND');
    if (cancelling(order.status)) return order;
    if (order.status === 'FAILED')
      throw new AppError(
        409,
        'Order sudah ditolak; tidak ada stok yang perlu dilepas',
        undefined,
        'ORDER_NOT_CANCELLABLE',
      );
    const fulfillment = order.fulfillmentStatus ?? 'NEW';
    if (fulfillment === 'COMPLETED')
      throw new AppError(409, 'Order sudah selesai', undefined, 'ORDER_NOT_CANCELLABLE');
    if (actor.role === 'customer' && fulfillment !== 'NEW')
      throw new AppError(
        409,
        'Pesanan sudah diproses. Hubungi admin untuk pembatalan.',
        undefined,
        'ORDER_NOT_CANCELLABLE',
      );
    const now = new Date().toISOString();
    const updated: StoredOrder = {
      ...order,
      status: 'CANCELLATION_REQUESTED',
      cancelledBy: actor.role,
      cancelReason: reason || undefined,
      updatedAt: now,
    };
    updateOrderRow(updated);
    return updated;
  });
  if (requested.status === 'CANCELLED') return { order: publicOrder(requested), completed: true };
  try {
    const order = await release(requested, ctx);
    return { order, completed: order.status === 'CANCELLED' };
  } catch (err) {
    // The intent is durable; recovery completes it once product-service answers.
    if (err instanceof AppError && err.status >= 500)
      return { order: publicOrder(getOrderRow(id)!), completed: false };
    throw err;
  }
}

/**
 * TODO m12.5 — OWASP API6: tolak order baru dengan 409 `HOLD_LIMIT_EXCEEDED` bila
 * pelanggan sudah memegang `config.holdLimit.maxOpenOrders` pesanan aktif, atau bila
 * `held + requested` satu produk melebihi `config.holdLimit.maxUnitsPerProduct`.
 * Data yang dipegang: `heldByCustomer(userId)` dari order-table.ts. Sertakan
 * `details` ({ limit, open } atau { productId, limit, held, requested }).
 */
function assertWithinHoldLimit(_userId: string, _input: OrderItemInput[]): void {}

export async function createOrder(
  {
    userId,
    items,
    shippingAddress,
    cartVersion,
  }: {
    userId: string;
    items: OrderItemInput[];
    shippingAddress?: ShippingAddress;
    cartVersion?: string;
  },
  ctx: { correlationId?: string; idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<Order> {
  if (!ctx.idempotencyKey)
    throw new AppError(400, 'Idempotency-Key wajib diisi', undefined, 'IDEMPOTENCY_REQUIRED');
  const quantities = new Map<string, number>();
  for (const item of items)
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  const input = [...quantities]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([productId, quantity]) => ({ productId, quantity }));
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        shippingAddress || cartVersion ? { items: input, shippingAddress, cartVersion } : input,
      ),
    )
    .digest('hex');
  const key = JSON.stringify([userId, ctx.idempotencyKey]);
  const order = database.transaction(() => {
    const checkoutVersion = checkoutKeys.get(key);
    if (checkoutVersion && checkoutVersion !== cartVersion)
      throw new AppError(
        409,
        'Idempotency-Key sudah digunakan untuk checkout lain',
        undefined,
        'IDEMPOTENCY_CONFLICT',
      );
    const existingId = keys.get(key);
    if (existingId) {
      const existing = getOrderRow(existingId)!;
      if (existing.fingerprint !== fingerprint)
        throw new AppError(
          409,
          'Idempotency-Key sudah digunakan untuk order berbeda',
          undefined,
          'IDEMPOTENCY_CONFLICT',
        );
      return existing;
    }
    // A retry with a known key is answered above, so it is never refused by the limit.
    assertWithinHoldLimit(userId, input);
    const now = new Date().toISOString();
    const pending: StoredOrder = {
      id: randomUUID(),
      userId,
      input,
      fingerprint,
      items: [],
      total: 0,
      status: 'PENDING',
      shippingAddress,
      cartVersion,
      fulfillmentStatus: 'NEW',
      createdAt: now,
      updatedAt: now,
    };
    insertOrderRow(pending, input);
    keys.insert(key, pending.id, Date.now() + config.idempotencyRetentionMs);
    return pending;
  });
  return complete(order, ctx);
}

/**
 * Reconcile durable work after a crash or temporary network failure: PENDING orders
 * still need a reservation, CANCELLATION_REQUESTED orders still need their release.
 *
 * Oldest first, so no order waits behind newer ones. A 503 means product-service is
 * unreachable (or this service is saturated): the rest of the batch would fail the
 * same way, so stop and let the next tick retry. Any other failure belongs to that
 * one order and must not block the orders queued behind it.
 */
const RECOVERY_BATCH = 100;
let recovering = false;
export async function recoverPendingOrders(): Promise<void> {
  if (recovering) return;
  recovering = true;
  try {
    for (const order of unfinishedOrders(RECOVERY_BATCH)) {
      try {
        if (order.status === 'PENDING') await complete(order, {});
        else await release(order, {});
      } catch (err) {
        if (err instanceof AppError && err.status === 503) break;
      }
    }
  } finally {
    recovering = false;
  }
}

/** True while an idempotency record must survive: its order may still be retried. */
export function orderSettledForKey(userId: string, key: string): boolean {
  const id = keys.get(JSON.stringify([userId, key]));
  const order = id ? getOrderRow(id) : undefined;
  return !order || TERMINAL_STATUSES.includes(order.status);
}

/**
 * Retention for idempotency records (default 24 h). Only the key → order mapping
 * expires; the order itself is a business record and is kept. A mapping whose order
 * is still PENDING or being cancelled is postponed, because deleting it would let a
 * retry create a duplicate order. Checkout aliases and tickets follow the order
 * their cart snapshot produced.
 */
export function purgeExpiredIdempotency(now = Date.now(), batch = 500) {
  const later = now + 60 * 60 * 1000;
  const tickets = database.store<{ key: string }>('checkout_tickets');
  const ticketSettled = (ticketId: string) => {
    const ticket = tickets.get(ticketId);
    const [userId] = JSON.parse(ticketId) as [string, string];
    return !ticket || orderSettledForKey(userId, ticket.key);
  };
  return database.transaction(() => ({
    checkoutKeys: checkoutKeys.sweep(now, batch, (key, version) => {
      const [userId] = JSON.parse(key) as [string, string];
      return ticketSettled(JSON.stringify([userId, version])) ? 'delete' : later;
    }),
    tickets: tickets.sweep(now, batch, (ticketId) => (ticketSettled(ticketId) ? 'delete' : later)),
    keys: keys.sweep(now, batch, (key) => {
      const [userId, idempotencyKey] = JSON.parse(key) as [string, string];
      return orderSettledForKey(userId, idempotencyKey) ? 'delete' : later;
    }),
  }));
}

/** Gives records written before retention existed a deletion schedule. */
export function scheduleLegacyIdempotency(now = Date.now()): number {
  const at = now + config.idempotencyRetentionMs;
  return database.transaction(
    () =>
      keys.scheduleUnscheduled(at) +
      checkoutKeys.scheduleUnscheduled(at) +
      database.store('checkout_tickets').scheduleUnscheduled(at),
  );
}

export function getOrder(id: string, userId: string): Order {
  const order = getOrderRow(id);
  if (!order || order.userId !== userId)
    throw new AppError(404, 'Order tidak ditemukan', undefined, 'NOT_FOUND');
  return publicOrder(order);
}
export function _reset(): void {
  clearOrderRows();
  keys.clear();
  checkoutKeys.clear();
}

export function findOrderByKey(userId: string, key: string): StoredOrder | undefined {
  const id = keys.get(JSON.stringify([userId, key]));
  return id ? getOrderRow(id) : undefined;
}
export function queryOrders(query: OrderPageQuery) {
  const page = pageOrders(query);
  return {
    orders: page.orders.map(publicOrder),
    total: page.total,
    offset: query.cursor ? 0 : (query.offset ?? 0),
    limit: query.limit ?? 20,
    nextCursor: page.nextCursor,
  };
}
export const adminSummary = orderSummary;
export function adminGetOrder(id: string): Order {
  const order = getOrderRow(id);
  if (!order) throw new AppError(404, 'Order tidak ditemukan', undefined, 'NOT_FOUND');
  return publicOrder(order);
}
export function updateFulfillment(id: string, status: 'PROCESSING' | 'COMPLETED'): Order {
  return database.transaction(() => {
    const order = getOrderRow(id);
    if (!order) throw new AppError(404, 'Order tidak ditemukan', undefined, 'NOT_FOUND');
    if (order.status !== 'CONFIRMED')
      throw new AppError(409, 'Hanya order terkonfirmasi yang bisa diproses');
    const current = order.fulfillmentStatus ?? 'NEW';
    if (
      current !== status &&
      !(
        (current === 'NEW' && status === 'PROCESSING') ||
        (current === 'PROCESSING' && status === 'COMPLETED')
      )
    )
      throw new AppError(409, 'Urutan status tidak valid');
    const updated = { ...order, fulfillmentStatus: status, updatedAt: new Date().toISOString() };
    updateOrderRow(updated);
    return publicOrder(updated);
  });
}
