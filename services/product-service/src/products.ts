import { randomUUID } from 'node:crypto';
import { AppError } from './middleware/errors.ts';
import { ServiceDatabase } from '@ecommerce/storage';

export interface Product {
  id: string;
  name: string;
  price: number;
  stock: number;
  revision?: number;
}

export type ProductInput = Omit<Product, 'id' | 'revision'>;

/** Durable inventory and reservation receipts share one transactional database. */
const database = new ServiceDatabase('product');
const products = database.store<Product>('products');
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
  for (const p of initial) {
    const id = randomUUID();
    products.set(id, { id, ...p });
  }
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
    for (const line of lines) {
      const product = getProduct(line.productId);
      products.set(product.id, {
        ...product,
        stock: product.stock - line.quantity,
        revision: (product.revision ?? 0) + 1,
      });
    }
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
    for (const line of existing.items) {
      // A product deleted since the order has nowhere to return its stock to.
      const product = products.get(line.productId);
      if (!product) continue;
      products.set(product.id, {
        ...product,
        stock: product.stock + line.quantity,
        revision: (product.revision ?? 0) + 1,
      });
    }
    const released: Reservation = { ...existing, status: 'RELEASED', releasedAt };
    reservations.set(id, released);
    return released;
  });
}

export function listProducts(): Product[] {
  return [...products.values()];
}

export function getProduct(id: string): Product {
  const product = products.get(id);
  if (!product) throw new AppError(404, 'Produk tidak ditemukan', undefined, 'NOT_FOUND');
  return product;
}

export function createProduct(data: ProductInput): Product {
  const id = randomUUID();
  const product: Product = { id, ...data, revision: 1 };
  products.set(id, product);
  return product;
}

export function updateProduct(
  id: string,
  data: Partial<ProductInput>,
  expectedRevision?: number,
): Product {
  return database.transaction(() => {
    const product = getProduct(id);
    if (expectedRevision !== undefined && expectedRevision !== (product.revision ?? 0))
      throw new AppError(
        409,
        'Produk atau stok berubah. Muat ulang sebelum menyimpan.',
        undefined,
        'PRODUCT_CHANGED',
      );
    const updated = { ...product, ...data, revision: (product.revision ?? 0) + 1 };
    products.set(id, updated);
    return updated;
  });
}

export function deleteProduct(id: string): void {
  getProduct(id); // lempar 404 kalau tak ada
  products.delete(id);
}

/** Hanya untuk test. */
export function _reset(): void {
  products.clear();
  reservations.clear();
  metadata.clear();
  seed();
}
