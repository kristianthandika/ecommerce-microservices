# Peta source dan verifikasi

Semua tautan source relatif terhadap repositori `ecommerce-microservices`. Rujukan menggunakan nama fungsi/komponen agar tidak bergantung pada nomor baris yang berubah ketika materi diedit.

## Peta implementasi

| Topik                                                | Berkas dan titik baca                                                                                                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database per service, transaksi, insert unik, backup | [storage/index.ts](../../packages/storage/src/index.ts): ServiceDatabase, Store, readSecret                                                                                       |
| Registrasi race-safe dan password                    | [users.ts](../../services/auth-service/src/users.ts), [auth/routes.ts](../../services/auth-service/src/routes.ts)                                                                 |
| Seed admin opt-in                                    | [auth/config.ts](../../services/auth-service/src/config.ts), [setup.mjs](../../scripts/setup.mjs)                                                                                 |
| JWT terdistribusi                                    | [product require-auth](../../services/product-service/src/middleware/require-auth.ts), [order require-auth](../../services/order-service/src/middleware/require-auth.ts)          |
| Timeout body, retry, breaker                         | [resilient-http-client](../../packages/resilient-http-client/src/index.ts)                                                                                                        |
| Routing /cart dan formatter error awal               | [gateway/app.ts](../../services/gateway/src/app.ts)                                                                                                                               |
| Health cache dan coalescing probe                    | [gateway/health.ts](../../services/gateway/src/health.ts)                                                                                                                         |
| Cart tersimpan versus quote                          | [cart.ts](../../services/order-service/src/cart.ts): getCart, changeItem, describeCart, renewCartVersion                                                                          |
| Tiket checkout dan alias key                         | [checkout.ts](../../services/order-service/src/checkout.ts): checkoutCart                                                                                                         |
| PENDING, konfirmasi, recovery, history, fulfillment  | [orders.ts](../../services/order-service/src/orders.ts), [order/index.ts](../../services/order-service/src/index.ts)                                                              |
| Validasi alamat/quantity/pagination/key              | [schemas.ts](../../services/order-service/src/schemas.ts)                                                                                                                         |
| HTTP cart/order/admin                                | [order/routes.ts](../../services/order-service/src/routes.ts), [require-role.ts](../../services/order-service/src/middleware/require-role.ts)                                     |
| Kontrak receipt dan lookup batch                     | [product-client.ts](../../services/order-service/src/product-client.ts)                                                                                                           |
| Reservasi atomik dan revision guard                  | [products.ts](../../services/product-service/src/products.ts)                                                                                                                     |
| Query katalog dan admin summary                      | [product/routes.ts](../../services/product-service/src/routes.ts)                                                                                                                 |
| State sesi dan cart frontend                         | [AuthContext](../../frontend/src/context/AuthContext.tsx), [CartContext](../../frontend/src/context/CartContext.tsx)                                                              |
| Client API dan normalisasi error                     | [client.ts](../../frontend/src/api/client.ts)                                                                                                                                     |
| Route UI dan guard admin                             | [App.tsx](../../frontend/src/App.tsx), [ProtectedRoute](../../frontend/src/components/ProtectedRoute.tsx)                                                                         |
| Katalog dan cart UI                                  | [DashboardPage](../../frontend/src/pages/DashboardPage.tsx), [CartPage](../../frontend/src/pages/CartPage.tsx)                                                                    |
| Checkout dan histori                                 | [CheckoutPage](../../frontend/src/pages/CheckoutPage.tsx), [OrdersPage](../../frontend/src/pages/OrdersPage.tsx), [OrderDetailPage](../../frontend/src/pages/OrderDetailPage.tsx) |
| Panel admin                                          | [AdminPage](../../frontend/src/pages/AdminPage.tsx)                                                                                                                               |
| Header, footer, skip link, layout                    | [Header](../../frontend/src/components/Header.tsx), [Footer](../../frontend/src/components/Footer.tsx), [ShopLayout](../../frontend/src/components/ShopLayout.tsx)                |
| Brand dan komponen CSS                               | [index.css](../../frontend/src/index.css), [tailwind.config.js](../../frontend/tailwind.config.js)                                                                                |
| Same-origin API dan CSP                              | [site.conf](../../frontend/site.conf), [nginx.conf](../../frontend/nginx.conf)                                                                                                    |
| Persistence, resource, network, non-root             | [docker-compose.yml](../../docker-compose.yml), Dockerfile setiap service/frontend                                                                                                |
| TLS opsional dan secrets                             | [docker-compose.tls.yml](../../docker-compose.tls.yml), [nginx.tls.conf](../../frontend/nginx.tls.conf)                                                                           |
| CI                                                   | [ci.yml](../../.github/workflows/ci.yml)                                                                                                                                          |

## Model penyimpanan

Setiap service mempunyai satu file SQLite. Data yang hanya dibaca per kunci memakai tabel key/value `records(namespace,key,value,expires_at)`; data yang difilter, diurutkan, atau diagregasi memakai tabel relasional milik service tersebut, dibuat oleh migrasi bernama yang dicatat di `schema_migrations`.

| Database       | Tabel / namespace         | Makna                                                                             |
| -------------- | ------------------------- | --------------------------------------------------------------------------------- |
| auth.sqlite    | `records`: users_email/id | Lookup pengguna dengan email unik dan ID                                          |
| auth.sqlite    | `records`: refresh_*      | Hash refresh token dan keluarga sesi; penghitung gagal login                      |
| product.sqlite | tabel `products`          | Produk, stok (`CHECK stock >= 0`), revision; indeks nama dan stok                 |
| product.sqlite | `records`: reservations   | Receipt reservasi, fingerprint item, status RELEASED/tombstone                    |
| product.sqlite | `records`: metadata       | Penanda seed agar katalog tidak dibuat ulang saat kosong/restart                  |
| order.sqlite   | tabel `orders`            | Status, fulfillment, total, penerima, waktu sebagai kolom; sisanya JSON `details` |
| order.sqlite   | tabel `order_lines`       | Jumlah yang diminta per produk; dasar batas tahan per pelanggan                   |
| order.sqlite   | `records`: carts          | Keranjang milik user dengan version                                               |
| order.sqlite   | `records`: checkout_*     | Snapshot checkout dan pengikatan key ke versi keranjang                           |
| order.sqlite   | `records`: idempotency    | Pengikatan key kanonis per pengguna ke ID order (retensi 24 jam)                  |

User tidak memilih namespace, key, atau SQL melalui API; semua nilai masuk sebagai parameter terikat. Price, total, status, dan userId bukan field bebas yang dipercaya dari browser. Perubahan struktur tabel ditambahkan sebagai migrasi baru di `src/migrations.ts` service terkait, tidak dengan mengubah migrasi yang sudah dirilis.

## Matriks invariant dan pengujian

| Invariant/perilaku                                                             | Bukti utama                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email bersamaan hanya satu berhasil; password byte limit; JSON 400             | [auth.test.ts](../../services/auth-service/tests/auth.test.ts)                                                                                                   |
| Persistensi, uniqueness, rollback, backup/restore dasar                        | [storage.test.ts](../../packages/storage/tests/storage.test.ts)                                                                                                  |
| Timeout body lambat, cancellation, oversized body, stale breaker result        | [resilient.test.ts](../../packages/resilient-http-client/tests/resilient.test.ts)                                                                                |
| Proxy, correlation ID, IP forwarding, health, rate limit 429                   | [gateway.test.ts](../../services/gateway/tests/gateway.test.ts)                                                                                                  |
| RBAC product dan JWKS cache                                                    | [product.test.ts](../../services/product-service/tests/product.test.ts)                                                                                          |
| Tidak oversell, receipt replay, rollback batch, stale admin edit               | [inventory.test.ts](../../services/product-service/tests/inventory.test.ts)                                                                                      |
| Cart ownership/version, checkout lintas key, snapshot, receipt hilang, restock | [checkout.test.ts](../../services/order-service/tests/checkout.test.ts)                                                                                          |
| Idempotensi order, ownership, kontrak upstream rusak                           | [idempotency.test.ts](../../services/order-service/tests/idempotency.test.ts)                                                                                    |
| If-Match/ETag keranjang, pembatalan + release stok, retensi Idempotency-Key    | [cart-cancel.test.ts](../../services/order-service/tests/cart-cancel.test.ts)                                                                                    |
| Release idempotent, tombstone, revisi produk setelah release                   | [inventory.test.ts](../../services/product-service/tests/inventory.test.ts)                                                                                      |
| Refresh token: TTL, rotasi, balapan tab, reuse, logout, CSRF; backoff login    | [sessions.test.ts](../../services/auth-service/tests/sessions.test.ts)                                                                                           |
| Cache JWKS tahan kid palsu; limiter tidak menghukum panggilan antar-service    | [signing-keys.test.ts](../../services/product-service/tests/signing-keys.test.ts), [rate-limit.test.ts](../../services/product-service/tests/rate-limit.test.ts) |
| Migrasi skema v1→v2, retensi terjadwal                                         | [storage.test.ts](../../packages/storage/tests/storage.test.ts)                                                                                                  |
| Sesi frontend (pulih saat reload, perpanjangan, logout), header If-Match       | [auth.test.tsx](../../frontend/src/test/auth.test.tsx), [client.test.ts](../../frontend/src/test/client.test.ts)                                                 |
| Timeout, breaker, pemulihan HTTP                                               | [order.chaos.test.ts](../../services/order-service/tests/order.chaos.test.ts)                                                                                    |
| Login dan expiry sesi                                                          | [login.test.tsx](../../frontend/src/test/login.test.tsx), [auth.test.tsx](../../frontend/src/test/auth.test.tsx)                                                 |
| Checkout double submit dan retry                                               | [order.test.tsx](../../frontend/src/test/order.test.tsx)                                                                                                         |
| Cart persisten dan hapus unavailable                                           | [cart.test.tsx](../../frontend/src/test/cart.test.tsx)                                                                                                           |
| Admin edit revision dan guard route                                            | [admin.test.tsx](../../frontend/src/test/admin.test.tsx)                                                                                                         |
| Stack asli, restart, stok, redaksi secret                                      | [e2e.mjs](../../scripts/e2e.mjs)                                                                                                                                 |
| Seluruh alur belanja/admin dan recovery cart                                   | [e2e-shopping.mjs](../../scripts/e2e-shopping.mjs)                                                                                                               |

Perbedaan lingkup penting: beberapa tes domain memakai test double HTTP atau database memory. E2E API memakai container nyata dan melewati nginx/gateway. Uji komponen memakai lingkungan DOM tes; bukan browser visual penuh.

## Baseline dan cara mencatat hasil

Pada revisi implementasi yang menjadi acuan paket ini tercatat:

| Kelompok              | Jumlah tes lulus |
| --------------------- | ---------------: |
| Resilient HTTP client |               14 |
| Storage               |                1 |
| Auth-service          |               11 |
| Gateway               |                8 |
| Order-service         |               12 |
| Product-service       |               10 |
| Frontend              |                8 |
| **Total workspace**   |           **64** |
| E2E audit             |      14 skenario |
| E2E belanja           |      11 skenario |

Typecheck, lint, build image, readiness, dan pemeriksaan HTTP asset juga pernah lulus pada sesi implementasi. Pembaruan header/footer mempertahankan delapan tes frontend serta build yang lulus. Audit npm online saat hardening melaporkan nol advisori; hasil tersebut memiliki batas waktu dan bukan bukti OS image bebas kerentanan.

**Saat menyusun dokumentasi ini, source dan kontrak dibaca ulang; suite aplikasi tidak dijalankan ulang hanya untuk perubahan dokumentasi.** Catat hasil baru pada tanggal/revisi kelas, jangan menyatakan baseline historis sebagai eksekusi baru.

Perintah verifikasi tersedia pada README paket dan praktikum. Untuk laporan kelas, isi tanggal, OS, versi Node/Docker, identitas revisi, perintah, exit code, jumlah pass/fail, lokasi hasil, dan batas. Kedua E2E menulis JSON pada `.e2e/`; jangan mempublikasikan seluruh konfigurasi privat sebagai bukti.

## Batas yang wajib tercatat

- Pemeriksaan visual Firefox Windows melalui alat computer-use terhalang dukungan kebijakan URL. Tidak ada klaim seluruh viewport/browser sudah diotomasi.
- Screenshot layout, Escape/fokus menu, overflow, dan screen reader tetap perlu pengujian manual/runner browser yang sesuai.
- Workflow CI tersedia dalam source, tetapi hasil eksekusi GitHub harus dilihat pada hostingnya; file workflow saja bukan bukti pipeline pernah sukses.
- Recovery bersifat terbatas per proses dan deployment SQLite satu host. Belum ada distributed transaction manager, broker, pembayaran, kurir, atau refund.
- Backup pada volume yang sama perlu dipindahkan keluar host dan diuji restore. Restore database service pada titik waktu berbeda memerlukan rekonsiliasi.

Rujukan hasil implementasi lengkap: [VERIFICATION.md](../VERIFICATION.md). Rujukan operasional dan batas production: [HARDENING.md](../HARDENING.md).
