import type { ServiceMigration } from '@ecommerce/storage';

/**
 * TODO m12.4 — tambahkan migrasi `order-001-relational-orders`:
 * - tabel `orders` (kolom untuk yang difilter/diurutkan/diagregasi, JSON `details`
 *   untuk sisanya) dan `order_lines (order_id, product_id, quantity)`
 * - indeks untuk riwayat pelanggan, antrean recovery, dan daftar admin
 * - pindahkan data dari `records` namespace `orders`, lalu hapus record lamanya
 *
 * Released migrations are never edited. Append a new one instead.
 */
export const migrations: readonly ServiceMigration[] = [];
