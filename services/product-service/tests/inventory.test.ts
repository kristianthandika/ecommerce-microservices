import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { _reset, createProduct, getProduct, reserveStock, updateProduct } from '../src/products.ts';

beforeEach(_reset);
describe('atomic stock reservation', () => {
  it('rejects a stale admin edit after checkout changes stock', () => {
    const product = createProduct({ name: 'Edit guard', price: 100, stock: 5 });
    reserveStock(randomUUID(), [{ productId: product.id, quantity: 2 }]);
    expect(() => updateProduct(product.id, { price: 200, stock: 5 }, product.revision)).toThrow(
      'berubah',
    );
    expect(getProduct(product.id).stock).toBe(3);
  });
  it('rejects duplicate-line overselling and leaves all stock unchanged', () => {
    const product = createProduct({ name: 'Limited', price: 100, stock: 50 });
    expect(() =>
      reserveStock(randomUUID(), [
        { productId: product.id, quantity: 40 },
        { productId: product.id, quantity: 40 },
      ]),
    ).toThrow('tidak cukup');
    expect(getProduct(product.id).stock).toBe(50);
  });
  it('deducts once, replays the same receipt and rejects changed payloads', () => {
    const product = createProduct({ name: 'Limited', price: 100, stock: 5 });
    const id = randomUUID();
    const items = [{ productId: product.id, quantity: 2 }];
    const first = reserveStock(id, items);
    expect(reserveStock(id, items)).toEqual(first);
    expect(getProduct(product.id).stock).toBe(3);
    expect(() => reserveStock(id, [{ productId: product.id, quantity: 1 }])).toThrow('berbeda');
  });
  it('rolls back the entire batch when any product is unavailable', () => {
    const a = createProduct({ name: 'A', price: 100, stock: 5 });
    const b = createProduct({ name: 'B', price: 100, stock: 0 });
    expect(() =>
      reserveStock(randomUUID(), [
        { productId: a.id, quantity: 2 },
        { productId: b.id, quantity: 1 },
      ]),
    ).toThrow();
    expect(getProduct(a.id).stock).toBe(5);
  });
});

describe('reservation release (saga compensation)', () => {
  it('returns stock once, even when released repeatedly', async () => {
    const { releaseReservation } = await import('../src/products.ts');
    const product = createProduct({ name: 'Release', price: 100, stock: 5 });
    const id = randomUUID();
    reserveStock(id, [{ productId: product.id, quantity: 3 }]);
    expect(getProduct(product.id).stock).toBe(2);
    expect(releaseReservation(id).status).toBe('RELEASED');
    expect(releaseReservation(id).status).toBe('RELEASED');
    expect(getProduct(product.id).stock).toBe(5);
    // A released reservation can never allocate again, even with the same items.
    expect(() => reserveStock(id, [{ productId: product.id, quantity: 3 }])).toThrow('dibatalkan');
    expect(getProduct(product.id).stock).toBe(5);
  });

  it('tombstones an unknown ID so a late reserve request cannot take stock', async () => {
    const { releaseReservation } = await import('../src/products.ts');
    const product = createProduct({ name: 'Late', price: 100, stock: 5 });
    const id = randomUUID();
    expect(releaseReservation(id).items).toEqual([]);
    expect(() => reserveStock(id, [{ productId: product.id, quantity: 1 }])).toThrow('dibatalkan');
    expect(getProduct(product.id).stock).toBe(5);
  });

  it('bumps the product revision so stale admin edits are rejected after a release', async () => {
    const { releaseReservation } = await import('../src/products.ts');
    const product = createProduct({ name: 'Revision', price: 100, stock: 5 });
    const id = randomUUID();
    reserveStock(id, [{ productId: product.id, quantity: 2 }]);
    const before = getProduct(product.id);
    releaseReservation(id);
    expect(() => updateProduct(product.id, { stock: 1 }, before.revision)).toThrow('berubah');
  });
});
