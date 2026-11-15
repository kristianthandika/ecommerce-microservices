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
  // Lookup produk independen antar-item → jalankan paralel supaya latency tidak
  // tumbuh linear dengan jumlah item (hanya ~satu round-trip). Urutan hasil
  // tetap sesuai `items` (Promise.all mempertahankan urutan).
  const products = await Promise.all(items.map((item) => fetchProduct(item.productId, ctx)));

  const lineItems: OrderLineItem[] = items.map((item, i) => {
    const product = products[i];
    if (product.stock < item.quantity) {
      throw new AppError(409, `Stok produk ${product.name} tidak cukup`, undefined, 'OUT_OF_STOCK');
    }
    return {
      productId: product.id,
      name: product.name,
      unitPrice: product.price,
      quantity: item.quantity,
      subtotal: product.price * item.quantity,
    };
  });

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
