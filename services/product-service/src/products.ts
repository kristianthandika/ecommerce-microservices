import { randomUUID } from 'node:crypto';
import { AppError } from './middleware/errors.ts';
import { ServiceDatabase } from '@ecommerce/storage';
import { migrations } from './migrations.ts';

export interface Product {
  id: string;
  name: string;
  price: number;
  stock: number;
  revision: number;
}

export type ProductInput = Omit<Product, 'id' | 'revision'>;

/** Durable inventory and reservation receipts share one transactional database. */
const database = new ServiceDatabase('product', { migrations });
const SELECT_PRODUCT = 'SELECT id, name, price, stock, revision FROM products';
const fromRow = (row: Record<string, unknown>): Product => ({
  id: String(row.id),
  name: String(row.name),
  price: Number(row.price),
  stock: Number(row.stock),
  revision: Number(row.revision),
});
/** Stock moves by a relative amount; the CHECK (stock >= 0) constraint is the last guard. */
function adjustStock(id: string, delta: number): boolean {
  return (
    database
      .statement('UPDATE products SET stock = stock + ?, revision = revision + 1 WHERE id = ?')
      .run(delta, id).changes === 1
  );
}
function insertProduct(product: Product): void {
  database
    .statement('INSERT INTO products (id, name, price, stock, revision) VALUES (?, ?, ?, ?, ?)')
    .run(product.id, product.name, product.price, product.stock, product.revision);
}
interface Reservation {
  id: string;
  fingerprint: string;
  items: {
    productId: string;
    name: string;
    unitPrice: number;
    quantity: number;
    subtotal: number;
  }[];
  total: number;
  /** Absent on receipts written before cancellation existed: they count as RESERVED. */
  status?: 'RESERVED' | 'RELEASED';
  releasedAt?: string;
}
const reservations = database.store<Reservation>('reservations');
const metadata = database.store<boolean>('metadata');

function seed(): void {
  if (metadata.has('seeded')) return;
  const initial: ProductInput[] = [
    { name: 'Kaos Inixindo', price: 120000, stock: 50 },
    { name: 'Mug Microservice', price: 65000, stock: 100 },
    { name: 'Sticker Pack DevOps', price: 25000, stock: 200 },
  ];
  for (const p of initial) insertProduct({ id: randomUUID(), ...p, revision: 0 });
  metadata.set('seeded', true);
}
database.transaction(seed);

/** Transaction contains the stock check, deduction and idempotent receipt. */
export function reserveStock(
  id: string,
  items: { productId: string; quantity: number }[],
): Reservation {
  const quantities = new Map<string, number>();
  for (const item of items)
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  const normalized = [...quantities].sort(([a], [b]) => a.localeCompare(b));
  const fingerprint = JSON.stringify(normalized);
  return database.transaction(() => {
    const existing = reservations.get(id);
    if (existing) {
      // Released (or tombstoned) IDs never allocate again: a reserve request that
      // arrives after its order was cancelled must not take stock.
      if (existing.status === 'RELEASED')
        throw new AppError(409, 'Reservasi sudah dibatalkan', undefined, 'RESERVATION_RELEASED');
      if (existing.fingerprint !== fingerprint)
        throw new AppError(
          409,
          'Reservasi digunakan dengan item berbeda',
          undefined,
          'IDEMPOTENCY_CONFLICT',
        );
      return existing;
    }
    const lines = normalized.map(([productId, quantity]) => {
      const product = getProduct(productId);
      if (product.stock < quantity)
        throw new AppError(
          409,
          `Stok produk ${product.name} tidak cukup`,
          undefined,
          'OUT_OF_STOCK',
        );
      return {
        productId,
        name: product.name,
        unitPrice: product.price,
        quantity,
        subtotal: product.price * quantity,
      };
    });
    const total = lines.reduce((sum, line) => sum + line.subtotal, 0);
    if (!Number.isSafeInteger(total)) throw new AppError(400, 'Total order di luar batas aman');
    for (const line of lines) adjustStock(line.productId, -line.quantity);
    const reservation: Reservation = { id, fingerprint, items: lines, total, status: 'RESERVED' };
    reservations.insert(id, reservation);
    return reservation;
  });
}

/**
 * Compensation for `reserveStock`: returns the allocated units in one transaction.
 *
 * Idempotent — releasing twice restocks once. An unknown ID is recorded as a
 * tombstone, because the matching reserve request may still be in flight (its
 * response lost, or not yet delivered); without the tombstone it would allocate
 * stock after the order had already been cancelled.
 */
export function releaseReservation(id: string): Reservation {
  return database.transaction(() => {
    const releasedAt = new Date().toISOString();
    const existing = reservations.get(id);
    if (!existing) {
      const tombstone: Reservation = {
        id,
        fingerprint: '',
        items: [],
        total: 0,
        status: 'RELEASED',
        releasedAt,
      };
      reservations.insert(id, tombstone);
      return tombstone;
    }
    if (existing.status === 'RELEASED') return existing;
    // A product deleted since the order has nowhere to return its stock to: no row changes.
    for (const line of existing.items) adjustStock(line.productId, line.quantity);
    const released: Reservation = { ...existing, status: 'RELEASED', releasedAt };
    reservations.set(id, released);
    return released;
  });
}

export function listProducts(): Product[] {
  return database
    .statement(`${SELECT_PRODUCT} ORDER BY name COLLATE NOCASE, id`)
    .all()
    .map(fromRow);
}

/** Catalogue page in name order; `q` matches anywhere in the name, ignoring case. */
export function searchProducts({ q = '', offset = 0, limit = 100 }) {
  const term = q.trim().toLowerCase();
  const filter = term ? 'WHERE instr(lower(name), ?) > 0' : '';
  const params = term ? [term] : [];
  return {
    products: database
      .statement(`${SELECT_PRODUCT} ${filter} ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map(fromRow),
    total: Number(
      database.statement(`SELECT count(*) AS count FROM products ${filter}`).get(...params)?.count,
    ),
  };
}

/** Products that exist among `ids`, in the order requested (unknown IDs are skipped). */
export function getProducts(ids: string[]): Product[] {
  const found = new Map(
    database
      .statement(`${SELECT_PRODUCT} WHERE id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids))
      .map((row) => [String(row.id), fromRow(row)] as const),
  );
  return ids.flatMap((id) => found.get(id) ?? []);
}

export function stockSummary() {
  const row = database
    .statement(
      `SELECT count(*) AS total,
              coalesce(sum(stock BETWEEN 1 AND 5), 0) AS low,
              coalesce(sum(stock = 0), 0) AS out
       FROM products`,
    )
    .get();
  return {
    totalProducts: Number(row?.total),
    lowStock: Number(row?.low),
    outOfStock: Number(row?.out),
  };
}

export function getProduct(id: string): Product {
  const row = database.statement(`${SELECT_PRODUCT} WHERE id = ?`).get(id);
  if (!row) throw new AppError(404, 'Produk tidak ditemukan', undefined, 'NOT_FOUND');
  return fromRow(row);
}

export function createProduct(data: ProductInput): Product {
  const product: Product = { id: randomUUID(), ...data, revision: 1 };
  insertProduct(product);
  return product;
}

export function updateProduct(
  id: string,
  data: Partial<ProductInput>,
  expectedRevision?: number,
): Product {
  return database.transaction(() => {
    const product = getProduct(id);
    if (expectedRevision !== undefined && expectedRevision !== product.revision)
      throw new AppError(
        409,
        'Produk atau stok berubah. Muat ulang sebelum menyimpan.',
        undefined,
        'PRODUCT_CHANGED',
      );
    const updated: Product = { ...product, ...data, revision: product.revision + 1 };
    database
      .statement('UPDATE products SET name = ?, price = ?, stock = ?, revision = ? WHERE id = ?')
      .run(updated.name, updated.price, updated.stock, updated.revision, id);
    return updated;
  });
}

export function deleteProduct(id: string): void {
  if (database.statement('DELETE FROM products WHERE id = ?').run(id).changes === 0)
    throw new AppError(404, 'Produk tidak ditemukan', undefined, 'NOT_FOUND');
}

/** Hanya untuk test. */
export function _reset(): void {
  database.statement('DELETE FROM products').run();
  reservations.clear();
  metadata.clear();
  seed();
}
