import type { ServiceMigration } from '@ecommerce/storage';

/**
 * Relational schema owned by order-service. Orders used to be JSON blobs in the
 * shared `records` table; every list, summary and recovery pass parsed all of them.
 * Columns hold what queries filter, sort or aggregate on; `details` keeps the rest
 * of the order (line snapshots, address, cancellation data) as JSON.
 *
 * Released migrations are never edited. Append a new one instead.
 */
export const migrations: readonly ServiceMigration[] = [
  {
    name: 'order-001-relational-orders',
    up: (db) =>
      db.exec(`
        CREATE TABLE orders (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN
            ('PENDING','CONFIRMED','FAILED','CANCELLATION_REQUESTED','CANCELLED')),
          fulfillment_status TEXT NOT NULL DEFAULT 'NEW'
            CHECK (fulfillment_status IN ('NEW','PROCESSING','COMPLETED')),
          total INTEGER NOT NULL CHECK (total >= 0),
          recipient TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          details TEXT NOT NULL CHECK (json_valid(details))
        ) STRICT;
        -- Customer history, newest first (also serves keyset pagination).
        CREATE INDEX orders_by_user ON orders (user_id, created_at DESC, id DESC);
        -- Recovery queue and status filters.
        CREATE INDEX orders_by_status ON orders (status, created_at, id);
        -- Admin list, newest first.
        CREATE INDEX orders_by_created ON orders (created_at DESC, id DESC);

        -- Requested quantities, one row per product. Used for per-customer limits.
        CREATE TABLE order_lines (
          order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
          product_id TEXT NOT NULL,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          PRIMARY KEY (order_id, product_id)
        ) STRICT, WITHOUT ROWID;

        INSERT INTO orders (id, user_id, status, fulfillment_status, total, recipient,
                            created_at, updated_at, details)
        SELECT key,
               json_extract(value, '$.userId'),
               json_extract(value, '$.status'),
               coalesce(json_extract(value, '$.fulfillmentStatus'), 'NEW'),
               coalesce(json_extract(value, '$.total'), 0),
               json_extract(value, '$.shippingAddress.recipient'),
               json_extract(value, '$.createdAt'),
               coalesce(json_extract(value, '$.updatedAt'), json_extract(value, '$.createdAt')),
               json_remove(value, '$.id', '$.userId', '$.status', '$.fulfillmentStatus',
                           '$.total', '$.createdAt', '$.updatedAt')
        FROM records WHERE namespace = 'orders';

        -- Older orders may lack the normalized request; their reserved lines are equivalent.
        INSERT INTO order_lines (order_id, product_id, quantity)
        SELECT r.key, json_extract(line.value, '$.productId'), sum(json_extract(line.value, '$.quantity'))
        FROM records r,
             json_each(r.value, CASE WHEN json_type(r.value, '$.input') = 'array'
                                     THEN '$.input' ELSE '$.items' END) line
        WHERE r.namespace = 'orders'
        GROUP BY r.key, json_extract(line.value, '$.productId');

        DELETE FROM records WHERE namespace = 'orders';
      `),
  },
];
