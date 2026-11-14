import type { SQLInputValue } from 'node:sqlite';
import { database } from './database.ts';
import { AppError } from './middleware/errors.ts';
import type { OrderItemInput, OrderStatus, StoredOrder } from './orders.ts';

/**
 * Data access for the `orders` and `order_lines` tables (see migrations.ts). Every
 * value reaches SQLite as a bound parameter; the only SQL assembled at run time is
 * a choice between fixed fragments.
 */
type Row = Record<string, unknown>;
type Fulfillment = NonNullable<StoredOrder['fulfillmentStatus']>;
const COLUMN_FIELDS = [
  'id',
  'userId',
  'status',
  'fulfillmentStatus',
  'total',
  'createdAt',
  'updatedAt',
] as const;

function fromRow(row: Row): StoredOrder {
  return {
    ...(JSON.parse(String(row.details)) as StoredOrder),
    id: String(row.id),
    userId: String(row.user_id),
    status: row.status as OrderStatus,
    fulfillmentStatus: row.fulfillment_status as Fulfillment,
    total: Number(row.total),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
/** Everything that is not a column. Columns are the single source of truth. */
function details(order: StoredOrder): string {
  const rest: Partial<StoredOrder> = { ...order };
  for (const field of COLUMN_FIELDS) delete rest[field];
  return JSON.stringify(rest);
}

export function getOrderRow(id: string): StoredOrder | undefined {
  const row = database.statement('SELECT * FROM orders WHERE id = ?').get(id);
  return row ? fromRow(row) : undefined;
}

export function insertOrderRow(order: StoredOrder, lines: OrderItemInput[]): void {
  database.transaction(() => {
    database
      .statement(
        `INSERT INTO orders (id, user_id, status, fulfillment_status, total, recipient,
                             created_at, updated_at, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        order.id,
        order.userId,
        order.status,
        order.fulfillmentStatus ?? 'NEW',
        order.total,
        order.shippingAddress?.recipient ?? null,
        order.createdAt,
        order.updatedAt ?? order.createdAt,
        details(order),
      );
    const line = database.statement(
      'INSERT INTO order_lines (order_id, product_id, quantity) VALUES (?, ?, ?)',
    );
    for (const { productId, quantity } of lines) line.run(order.id, productId, quantity);
  });
}

export function updateOrderRow(order: StoredOrder): void {
  const result = database
    .statement(
      `UPDATE orders SET status = ?, fulfillment_status = ?, total = ?, recipient = ?,
                         updated_at = ?, details = ?
       WHERE id = ?`,
    )
    .run(
      order.status,
      order.fulfillmentStatus ?? 'NEW',
      order.total,
      order.shippingAddress?.recipient ?? null,
      order.updatedAt ?? order.createdAt,
      details(order),
      order.id,
    );
  if (result.changes !== 1) throw new Error(`Order ${order.id} does not exist`);
}

/** Oldest unfinished orders first; served by the (status, created_at, id) index. */
export function unfinishedOrders(limit: number): StoredOrder[] {
  return database
    .statement(
      `SELECT * FROM orders WHERE status IN ('PENDING', 'CANCELLATION_REQUESTED')
       ORDER BY created_at, id LIMIT ?`,
    )
    .all(limit)
    .map(fromRow);
}

/** Opaque keyset cursor: the sort key of the last row on the previous page. */
export function encodeCursor(order: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify([order.createdAt, order.id])).toString('base64url');
}
function decodeCursor(cursor: string): [string, string] {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((part) => typeof part === 'string' && part.length <= 64)
    )
      return value as [string, string];
  } catch {
    /* reported below */
  }
  throw new AppError(400, 'Cursor tidak valid', undefined, 'INVALID_CURSOR');
}

export interface OrderPageQuery {
  userId?: string;
  status?: OrderStatus;
  q?: string;
  offset?: number;
  limit?: number;
  cursor?: string;
}

/**
 * Newest first. `cursor` (keyset) is stable while new orders arrive; `offset` is
 * kept for numbered pages in the UI and is capped by the request schema.
 */
export function pageOrders({
  userId,
  status,
  q = '',
  offset = 0,
  limit = 20,
  cursor,
}: OrderPageQuery) {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (userId) {
    where.push('user_id = ?');
    params.push(userId);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const term = q.trim().toLowerCase();
  if (term) {
    where.push("instr(lower(id || ' ' || coalesce(recipient, '')), ?) > 0");
    params.push(term);
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    database.statement(`SELECT count(*) AS count FROM orders ${filter}`).get(...params)?.count,
  );
  const pageWhere = [...where];
  const pageParams = [...params];
  if (cursor) {
    pageWhere.push('(created_at, id) < (?, ?)');
    pageParams.push(...decodeCursor(cursor));
  }
  const rows = database
    .statement(
      `SELECT * FROM orders ${pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...pageParams, limit + 1, cursor ? 0 : offset)
    .map(fromRow);
  const orders = rows.slice(0, limit);
  const last = orders.at(-1);
  return {
    orders,
    total,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

export function orderSummary() {
  const groups = database
    .statement(
      `SELECT status, fulfillment_status AS fulfillment, count(*) AS count, sum(total) AS value
       FROM orders GROUP BY status, fulfillment_status`,
    )
    .all()
    .map((row) => ({
      status: row.status as OrderStatus,
      fulfillment: row.fulfillment as Fulfillment,
      count: Number(row.count),
      value: Number(row.value),
    }));
  const sum = (match: (group: (typeof groups)[number]) => boolean, field: 'count' | 'value') =>
    groups.filter(match).reduce((total, group) => total + group[field], 0);
  return {
    totalOrders: sum(() => true, 'count'),
    confirmedOrders: sum((g) => g.status === 'CONFIRMED', 'count'),
    pendingOrders: sum((g) => g.status === 'PENDING', 'count'),
    failedOrders: sum((g) => g.status === 'FAILED', 'count'),
    cancelledOrders: sum(
      (g) => g.status === 'CANCELLED' || g.status === 'CANCELLATION_REQUESTED',
      'count',
    ),
    confirmedValue: sum((g) => g.status === 'CONFIRMED', 'value'),
    processingOrders: sum(
      (g) => g.status === 'CONFIRMED' && g.fulfillment === 'PROCESSING',
      'count',
    ),
  };
}

/**
 * What a customer currently holds: orders that took (or are about to take) stock and
 * have not been completed. Orders being cancelled are excluded, since their stock is
 * on its way back.
 */
export function heldByCustomer(userId: string): { openOrders: number; units: Map<string, number> } {
  const open = `o.user_id = ? AND o.status IN ('PENDING', 'CONFIRMED')
                AND o.fulfillment_status <> 'COMPLETED'`;
  const openOrders = Number(
    database.statement(`SELECT count(*) AS count FROM orders o WHERE ${open}`).get(userId)?.count,
  );
  const units = new Map(
    database
      .statement(
        `SELECT l.product_id AS product, sum(l.quantity) AS units
         FROM orders o JOIN order_lines l ON l.order_id = o.id
         WHERE ${open} GROUP BY l.product_id`,
      )
      .all(userId)
      .map((row) => [String(row.product), Number(row.units)] as const),
  );
  return { openOrders, units };
}

export function clearOrderRows(): void {
  database.statement('DELETE FROM orders').run();
}
