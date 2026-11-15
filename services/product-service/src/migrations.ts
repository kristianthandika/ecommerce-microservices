import type { ServiceMigration } from '@ecommerce/storage';

/**
 * Relational schema owned by product-service. The catalogue moves out of the
 * key/value `records` table so search, paging and stock summaries run in SQL, and
 * the database itself refuses negative stock (a second guard behind the
 * transactional check in `reserveStock`).
 *
 * Reservation receipts stay in `records`: they are only ever read by ID.
 * Released migrations are never edited. Append a new one instead.
 */
export const migrations: readonly ServiceMigration[] = [
  {
    name: 'product-001-relational-products',
    up: (db) =>
      db.exec(`
        CREATE TABLE products (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
          price INTEGER NOT NULL CHECK (price > 0),
          stock INTEGER NOT NULL CHECK (stock >= 0),
          revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
        ) STRICT;
        -- Catalogue order (name, then id as a stable tie-breaker).
        CREATE INDEX products_by_name ON products (name COLLATE NOCASE, id);
        -- Low-stock and out-of-stock counts for the admin summary.
        CREATE INDEX products_by_stock ON products (stock);

        INSERT INTO products (id, name, price, stock, revision)
        SELECT key,
               json_extract(value, '$.name'),
               json_extract(value, '$.price'),
               json_extract(value, '$.stock'),
               coalesce(json_extract(value, '$.revision'), 0)
        FROM records WHERE namespace = 'products';

        DELETE FROM records WHERE namespace = 'products';
      `),
  },
];
