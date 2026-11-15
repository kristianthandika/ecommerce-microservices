import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ServiceDatabase } from '@ecommerce/storage';
import { migrations } from '../src/migrations.ts';
import * as catalogue from '../src/products.ts';

/** The catalogue lives in a relational table; these tests pin its contract. */
beforeEach(() => catalogue._reset());

describe('relational catalogue', () => {
  it('moves legacy product records into the products table', () => {
    const directory = mkdtempSync(join(tmpdir(), 'product-migration-'));
    try {
      const legacy = new DatabaseSync(join(directory, 'product.sqlite'));
      legacy.exec(
        `CREATE TABLE records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
           expires_at INTEGER, PRIMARY KEY(namespace,key)); PRAGMA user_version=2;`,
      );
      const insert = legacy.prepare('INSERT INTO records (namespace,key,value) VALUES (?,?,?)');
      insert.run('products', 'a', '{"id":"a","name":"Mug","price":65000,"stock":3,"revision":4}');
      insert.run('products', 'b', '{"id":"b","name":"Kaos","price":120000,"stock":0}');
      insert.run('reservations', 'r', '{"id":"r"}');
      legacy.close();

      const db = new ServiceDatabase('product', { directory, migrations });
      try {
        expect(db.statement('SELECT * FROM products ORDER BY id').all()).toEqual([
          { id: 'a', name: 'Mug', price: 65000, stock: 3, revision: 4 },
          { id: 'b', name: 'Kaos', price: 120000, stock: 0, revision: 0 },
        ]);
        expect(db.store('products').size).toBe(0);
        expect(db.store('reservations').size).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses negative stock at the database level', () => {
    const directory = mkdtempSync(join(tmpdir(), 'product-check-'));
    const db = new ServiceDatabase('product', { directory, migrations });
    try {
      db.statement('INSERT INTO products VALUES (?,?,?,?,?)').run('x', 'X', 100, 1, 0);
      expect(() =>
        db.statement('UPDATE products SET stock = stock - 2 WHERE id = ?').run('x'),
      ).toThrow('CHECK constraint failed');
      expect(db.statement('SELECT stock FROM products WHERE id = ?').get('x')?.stock).toBe(1);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('searches, orders and pages in SQL', () => {
    for (const name of ['zebra Tote', 'Alpha Mug', 'beta mug'])
      catalogue.createProduct({ name, price: 1000, stock: 2 });
    const mugs = catalogue.searchProducts({ q: 'MUG', limit: 10 });
    expect(mugs.total).toBe(3); // includes the seeded "Mug Microservice"
    expect(mugs.products.map((p) => p.name)).toEqual(['Alpha Mug', 'beta mug', 'Mug Microservice']);
    const page = catalogue.searchProducts({ q: 'mug', offset: 1, limit: 1 });
    expect(page.products.map((p) => p.name)).toEqual(['beta mug']);
    expect(page.total).toBe(3);
    // `%` and `_` are plain characters, not wildcards.
    expect(catalogue.searchProducts({ q: '%' }).total).toBe(0);
  });

  it('summarises stock with aggregate queries', () => {
    catalogue.createProduct({ name: 'Low', price: 1000, stock: 5 });
    catalogue.createProduct({ name: 'Out', price: 1000, stock: 0 });
    expect(catalogue.stockSummary()).toEqual({ totalProducts: 5, lowStock: 1, outOfStock: 1 });
  });

  it('returns requested products in request order and skips unknown IDs', () => {
    const [first, second] = catalogue.listProducts();
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(
      catalogue.getProducts([second.id, missing, first.id]).map((product) => product.id),
    ).toEqual([second.id, first.id]);
  });
});
