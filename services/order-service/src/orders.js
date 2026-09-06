import { randomUUID } from 'node:crypto';
import { fetchProduct } from './product-client.js';
import { AppError } from './middleware/errors.js';

/** Order store IN-MEMORY (simplifikasi training). */
const orders = new Map();

/**
 * Buat order: untuk tiap item, validasi produk & ambil harga TERKINI dari
 * product-service (lewat resilient client). Harga "dibekukan" ke order supaya
 * tidak berubah kalau katalog berubah nanti.
 *
 * @param {{ userId: string, items: {productId: string, quantity: number}[] }} input
 * @param {{ correlationId?: string }} ctx
 */
export async function createOrder({ userId, items }, ctx = {}) {
  const lineItems = [];
  for (const item of items) {
    const product = await fetchProduct(item.productId, ctx); // bisa throw AppError 503/404
    if (product.stock < item.quantity) {
      throw new AppError(409, `Stok produk ${product.name} tidak cukup`, undefined);
    }
    lineItems.push({
      productId: product.id,
      name: product.name,
      unitPrice: product.price,
      quantity: item.quantity,
      subtotal: product.price * item.quantity,
    });
  }

  const total = lineItems.reduce((sum, li) => sum + li.subtotal, 0);
  const order = {
    id: randomUUID(),
    userId,
    items: lineItems,
    total,
    status: 'CONFIRMED',
    createdAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  return order;
}

export function listOrdersForUser(userId) {
  return [...orders.values()].filter((o) => o.userId === userId);
}

export function getOrder(id, userId) {
  const order = orders.get(id);
  if (!order || order.userId !== userId) {
    throw new AppError(404, 'Order tidak ditemukan', undefined);
  }
  return order;
}

/** Hanya untuk test. */
export function _reset() {
  orders.clear();
}
