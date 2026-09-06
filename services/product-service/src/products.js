import { randomUUID } from 'node:crypto';
import { AppError } from './middleware/errors.js';

/** Product store IN-MEMORY (simplifikasi training — lihat PRODUCTION-CHECKLIST). */
const products = new Map();

function seed() {
  if (products.size > 0) return;
  const initial = [
    { name: 'Kaos Inixindo', price: 120000, stock: 50 },
    { name: 'Mug Microservice', price: 65000, stock: 100 },
    { name: 'Sticker Pack DevOps', price: 25000, stock: 200 },
  ];
  for (const p of initial) {
    const id = randomUUID();
    products.set(id, { id, ...p });
  }
}
seed();

export function listProducts() {
  return [...products.values()];
}

export function getProduct(id) {
  const product = products.get(id);
  if (!product) throw new AppError(404, 'Produk tidak ditemukan', undefined);
  return product;
}

export function createProduct(data) {
  const id = randomUUID();
  const product = { id, ...data };
  products.set(id, product);
  return product;
}

export function updateProduct(id, data) {
  const product = getProduct(id);
  const updated = { ...product, ...data };
  products.set(id, updated);
  return updated;
}

export function deleteProduct(id) {
  getProduct(id); // lempar 404 kalau tak ada
  products.delete(id);
}

/** Hanya untuk test. */
export function _reset() {
  products.clear();
  seed();
}
