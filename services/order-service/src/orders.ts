import { randomUUID } from 'node:crypto';
import { fetchProduct } from './product-client.ts';
import { AppError } from './middleware/errors.ts';

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

export interface Order {
  id: string;
  userId: string;
  items: OrderLineItem[];
  total: number;
  status: 'CONFIRMED';
  createdAt: string;
}

/** Order store IN-MEMORY (simplifikasi training). */
const orders = new Map<string, Order>();

/**
 * Buat order: untuk tiap item, validasi produk & ambil harga TERKINI dari
 * product-service (lewat resilient client). Harga "dibekukan" ke order supaya
 * tidak berubah kalau katalog berubah nanti.
 */
export async function createOrder(
  { userId, items }: { userId: string; items: OrderItemInput[] },
  ctx: { correlationId?: string } = {},
): Promise<Order> {
  const lineItems: OrderLineItem[] = [];
  for (const item of items) {
    const product = await fetchProduct(item.productId, ctx); // bisa throw AppError 503/404
    if (product.stock < item.quantity) {
      throw new AppError(409, `Stok produk ${product.name} tidak cukup`, undefined, 'OUT_OF_STOCK');
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
  const order: Order = {
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

export function listOrdersForUser(userId: string): Order[] {
  return [...orders.values()].filter((o) => o.userId === userId);
}

export function getOrder(id: string, userId: string): Order {
  const order = orders.get(id);
  if (!order || order.userId !== userId) {
    throw new AppError(404, 'Order tidak ditemukan', undefined, 'NOT_FOUND');
  }
  return order;
}

/** Hanya untuk test. */
export function _reset(): void {
  orders.clear();
}
