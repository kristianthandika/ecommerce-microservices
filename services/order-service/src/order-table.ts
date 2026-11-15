import { database } from './database.ts';
import { AppError } from './middleware/errors.ts';
import type { OrderItemInput, OrderStatus, StoredOrder } from './orders.ts';

/**
 * TODO m12.4 — versi starter: semua order disimpan sebagai blob JSON di key/value
 * store, lalu dibaca SEMUA dan difilter di JavaScript. Hasilnya benar, tetapi
 * biayanya tumbuh linear dengan jumlah order. Ganti isi setiap fungsi dengan query
 * SQL ke tabel dari migrations.ts (`database.statement(sql)`); tanda tangan fungsi
 * sudah final, jadi orders.ts tidak perlu diubah.
 */
const orders = database.store<StoredOrder>('orders');
const newestFirst = (a: StoredOrder, b: StoredOrder) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

export function getOrderRow(id: string): StoredOrder | undefined {
  return orders.get(id);
}

export function insertOrderRow(order: StoredOrder, _lines: OrderItemInput[]): void {
  orders.insert(order.id, order);
}

export function updateOrderRow(order: StoredOrder): void {
  if (!orders.has(order.id)) throw new Error(`Order ${order.id} does not exist`);
  orders.set(order.id, order);
}

export function unfinishedOrders(limit: number): StoredOrder[] {
  return orders
    .values()
    .filter((o) => o.status === 'PENDING' || o.status === 'CANCELLATION_REQUESTED')
    .sort((a, b) => newestFirst(b, a))
    .slice(0, limit);
}

/** Opaque keyset cursor: the sort key of the last row on the previous page. */
export function encodeCursor(order: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify([order.createdAt, order.id])).toString('base64url');
}

export interface OrderPageQuery {
  userId?: string;
  status?: OrderStatus;
  q?: string;
  offset?: number;
  limit?: number;
  cursor?: string;
}

/** TODO m12.4 — dukung `cursor` (keyset `(created_at, id) < (?, ?)`); 400 INVALID_CURSOR bila rusak. */
export function pageOrders({
  userId,
  status,
  q = '',
  offset = 0,
  limit = 20,
  cursor,
}: OrderPageQuery) {
  if (cursor) throw new AppError(400, 'Cursor belum didukung', undefined, 'INVALID_CURSOR');
  const term = q.trim().toLowerCase();
  const filtered = orders
    .values()
    .filter(
      (order) =>
        (!userId || order.userId === userId) &&
        (!status || order.status === status) &&
        (!term ||
          `${order.id} ${order.shippingAddress?.recipient ?? ''}`.toLowerCase().includes(term)),
    )
    .sort(newestFirst);
  return {
    orders: filtered.slice(offset, offset + limit),
    total: filtered.length,
    nextCursor: null,
  };
}

export function orderSummary() {
  const all = orders.values();
  const count = (match: (order: StoredOrder) => boolean) => all.filter(match).length;
  return {
    totalOrders: all.length,
    confirmedOrders: count((o) => o.status === 'CONFIRMED'),
    pendingOrders: count((o) => o.status === 'PENDING'),
    failedOrders: count((o) => o.status === 'FAILED'),
    cancelledOrders: count(
      (o) => o.status === 'CANCELLED' || o.status === 'CANCELLATION_REQUESTED',
    ),
    confirmedValue: all
      .filter((o) => o.status === 'CONFIRMED')
      .reduce((sum, o) => sum + o.total, 0),
    processingOrders: count(
      (o) => o.status === 'CONFIRMED' && o.fulfillmentStatus === 'PROCESSING',
    ),
  };
}

export function heldByCustomer(userId: string): { openOrders: number; units: Map<string, number> } {
  const open = orders.values().filter(
    (o) =>
      o.userId === userId &&
      // Pembatalan yang belum selesai masih menahan stok, jadi tetap dihitung.
      ['PENDING', 'CONFIRMED', 'CANCELLATION_REQUESTED'].includes(o.status) &&
      o.fulfillmentStatus !== 'COMPLETED',
  );
  const units = new Map<string, number>();
  for (const order of open)
    for (const line of order.input)
      units.set(line.productId, (units.get(line.productId) ?? 0) + line.quantity);
  return { openOrders: open.length, units };
}

export function clearOrderRows(): void {
  orders.clear();
}
