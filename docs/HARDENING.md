# Perbaikan audit dan pengoperasian

Implementasi ini menggantikan penyimpanan in-memory prototype dengan SQLite per service. Deploy yang didukung adalah satu host, satu replica untuk setiap service, dan volume persisten lokal. SQLite bukan pengganti PostgreSQL untuk deployment multi-host. Jangan menaruh file SQLite/WAL di network filesystem atau menjalankan replica dengan database lokal yang berbeda.

## Menjalankan

```bash
node scripts/setup.mjs --demo-admin
docker compose up --build -d --wait
```

Setup hanya membuat `.env` jika belum ada, menghasilkan service token dan password admin acak, serta tidak mencetak secret. Tanpa `--demo-admin`, bootstrap admin nonaktif. Kredensial training tersimpan dalam `.env` yang diabaikan Git. File itu harus diperlakukan sebagai secret. Buka `http://localhost:3000`; API browser menggunakan `/api` pada origin yang sama. Port host hanya terikat ke loopback. Backend tidak memiliki port host dan hanya terhubung ke network internal. Gateway mempercayai X-Forwarded-For hanya dari alamat frontend yang dikonfigurasi, dan menimpa header tersebut sebelum meneruskannya ke service.

Subnet default `10.241.17.0/24` dan `10.241.18.0/24` dipilih agar tidak bentrok dengan network Docker yang ada saat pengujian. Jika perlu menggantinya, sesuaikan kedua subnet, IP frontend, dan `TRUSTED_PROXY_CIDR` secara bersamaan.

Untuk development lokal, jalankan `npm install`, `npm run build:packages`, lalu `npm run dev:all` dan `npm run dev --workspace=frontend`. Script service membaca `.env` root; Vite mem-proxy `/api`. SQLite lokal berada dalam folder `data/` pada working directory service. Vitest menggunakan database memory terisolasi.

## Integritas order

- `POST /orders` membutuhkan JWT dan `Idempotency-Key`, 8-128 karakter `[A-Za-z0-9_-]`. Simpan key yang sama ketika mengulang operasi yang hasilnya belum diketahui. Mengubah payload dengan key yang sama menghasilkan 409.
- Item dengan produk sama digabungkan. Harga adalah integer rupiah; nilai total divalidasi sebagai safe integer.
- Order `PENDING` dan pemetaan key disimpan sebelum request ke product-service. Product-service memeriksa seluruh batch, mengurangi stok, dan menyimpan receipt reservasi dalam satu transaksi SQLite.
- Reservasi menggunakan ID order sebagai key. Respons yang hilang boleh diulang tanpa mengurangi stok lagi. Order menjadi `CONFIRMED` setelah receipt tervalidasi tersimpan. Penolakan produk/stok menjadi `FAILED`; kegagalan jaringan tetap `PENDING`.
- Recovery worker melanjutkan order PENDING setelah restart dan gangguan jaringan. Konfirmasi di sini berarti stok telah dialokasikan; aplikasi belum mengimplementasikan pembayaran, pengiriman, ataupun pembatalan/refund. Karena tidak ada pembayaran atau langkah lanjutan yang dapat ditolak, alur saat ini tidak memerlukan kompensasi pembayaran. Tambahkan state machine dan kompensasi reservasi sebelum memperluas workflow tersebut.
- Maksimal 32 operasi reservasi aktif per proses. Batch menggantikan fan-out sampai 50 request per order. Retry dibatasi deadline; pembatalan caller menghentikan request/backoff. Timeout mencakup body dengan batas ukuran 1 MiB.

## Database dan backup

Volume `auth-data`, `product-data`, dan `order-data` terpisah; `auth-keys` menyimpan private key. Transaksi memakai WAL dan synchronous FULL. Schema version 1 dibuat otomatis; versi schema lebih baru ditolak. Perubahan schema berikutnya harus memakai migration eksplisit.

Backup konsisten menggunakan SQLite online backup API, bukan menyalin file `.sqlite` yang sedang ditulis:

```bash
docker compose exec auth-service node /app/scripts/backup.ts auth /app/data/backups
docker compose exec product-service node /app/scripts/backup.ts product /app/data/backups
docker compose exec order-service node /app/scripts/backup.ts order /app/data/backups
```

Salin backup keluar host dan amankan juga volume keypair. Folder backup pada volume yang sama hanya staging, bukan perlindungan terhadap kerusakan host. Untuk restore, hentikan service terkait, amankan database dan WAL lama, pulihkan backup sebagai `auth.sqlite`, `product.sqlite`, atau `order.sqlite`, dengan kepemilikan user `node`, lalu jalankan kembali dan periksa integrity/readiness. Jangan menghapus volume menggunakan `down -v` jika data masih dibutuhkan. Restore titik waktu berbeda antarservice memerlukan rekonsiliasi order dan receipt reservasi.

## Secrets dan TLS

Auth dan komunikasi internal mendukung `SEED_ADMIN_PASSWORD_FILE` dan `INTERNAL_SERVICE_TOKEN_FILE`. File secret diprioritaskan terhadap nilai environment. Gunakan secret manager platform untuk menyediakannya. Private signing key tetap berada pada volume lokal; integrasi KMS dan rotasi key dengan overlap JWKS masih memerlukan konfigurasi platform dan kebijakan operasional.

Overlay TLS disediakan untuk sertifikat milik deployment. Siapkan `TLS_CERT_FILE`, `TLS_KEY_FILE`, `ADMIN_PASSWORD_FILE`, dan `SERVICE_TOKEN_FILE` yang berisi path host. Service token minimal 32 karakter; password admin 16-72 byte UTF-8. Sertifikat/key harus dapat dibaca proses nginx non-root. Gunakan certificate chain yang dipercaya klien dan sesuai hostname. Set `FRONTEND_ORIGIN` sesuai origin HTTPS.

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml up --build -d --wait
```

Overlay menutup port gateway host dan mengganti HTTP frontend dengan HTTPS loopback port 443 (dapat diubah melalui `HTTPS_PORT`; pengujian lokal memakai 3443 agar tidak bentrok dengan listener lain). Untuk publikasi sungguhan, konfigurasikan ingress/firewall, hostname, certificate renewal, rate-limit terdistribusi bila scaling, serta backup terjadwal. Jangan membuka port publik atau mengubah trust proxy tanpa meninjau boundary tersebut.

## Verifikasi dan batasnya

```bash
npm run build:packages
npm run typecheck
npm run lint
npm test
npm audit --audit-level=moderate
node scripts/e2e.mjs --chaos
```

E2E memakai stack nyata melalui nginx dan gateway: register/login/profile, race registrasi, RBAC, validasi input, idempotensi konkuren, overselling, ownership, polling health, backup, restart, dan kegagalan/pemulihan product-service. Hasil tersimpan di `.e2e/results.json`. Jalankan pada lingkungan testing; script membuat akun/order uji dan menghentikan/restart service proyek ini. Dibutuhkan admin bootstrap pada `.env`. Tunggu jendela rate-limit selesai sebelum mengulang banyak tes API; jangan menonaktifkan rate-limit untuk produksi.

Tes component frontend mencakup login, expiry, 401 dari sesi lama, dan klik ganda/retry. Alur browser diuji manual di Chromium melalui Playwright (lihat VERIFICATION.md); uji itu belum menjadi bagian CI. Keberhasilan tes tidak menjamin ketiadaan seluruh bug, dan bukan bukti kapasitas beban production atau audit penetration test lengkap.

Workflow GitHub Actions menjalankan pemeriksaan source, audit dependency, build Docker, E2E, dan menyimpan hasil. Workflow ini belum dieksekusi di GitHub pada sesi lokal; deployment dan kredensial registry/hosting harus dikonfigurasi sesuai target organisasi. Tambahkan image scanning dan observability backend (metrics, alert, tracing end-to-end) sebelum melayani data pelanggan nyata.

## Hardening lanjutan

- **Verifikasi JWT (product/order).** Seluruh key set JWKS di-cache di memory (`middleware/signing-keys.ts`). `kid` yang tidak dikenal hanya boleh memicu satu fetch per 30 detik, sehingga token palsu tidak dapat menghabiskan kuota fetch milik pengguna sah. Jika auth-service tidak terjangkau, key yang sudah dikenal tetap dipakai sampai 60 menit (stale-if-error); setelah itu service menjawab 503. Konsekuensinya, key yang dicabut dari JWKS masih dapat diterima selama auth-service tidak terjangkau, paling lama 60 menit.
- **Rate limit service.** Limiter tiap service adalah backstop 300 request/menit per IP di belakang limiter gateway (100/menit). Panggilan service-ke-service yang membawa `x-service-token` valid dikecualikan; path `/internal/*` saja tidak lagi menjadi alasan pengecualian. Gateway membuang `x-service-token` kiriman klien.
- **Error gateway.** Route tak dikenal dijawab 404 `NOT_FOUND` dan ikut dihitung rate-limit. Service yang tidak terjangkau dijawab 503 `UPSTREAM_UNAVAILABLE` dengan `Retry-After: 5`, timeout 504 `UPSTREAM_TIMEOUT`.
- **Recovery order.** Order PENDING diproses dari yang tertua, maksimal 100 per siklus; siklus berhenti pada 503 dan dilanjutkan 10 detik kemudian. Status akhir hanya ditulis bila order masih PENDING saat transaksi dijalankan.
- **Storage.** `transaction()` menolak callback async, bergabung dengan transaksi yang sedang terbuka, dan memakai prepared statement yang di-cache.
- **nginx.** `resolver 127.0.0.11` dengan `proxy_pass` ber-variabel membuat nginx mengikuti perubahan IP gateway; `server_tokens off`; `index.html` selalu divalidasi ulang (`no-cache`) sedangkan aset ber-hash di-cache satu tahun; ditambah `Permissions-Policy` dan `form-action 'self'`.

## Sesi, concurrency, pembatalan, dan retensi

- **Sesi.** Access token JWT berumur 15 menit (`JWT_EXPIRES_IN_SECONDS`) dan hanya disimpan di memory frontend. Refresh token opaque disimpan auth-service sebagai hash SHA-256, dikirim sebagai cookie `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`, dan dirotasi setiap dipakai. Token lama yang dipakai ulang setelah jendela 10 detik dianggap dicuri dan seluruh keluarga sesinya dicabut. Logout mencabut sesi di server. Endpoint refresh/logout mewajibkan header `X-Requested-With` dan, bila ada, `Origin` dari `REFRESH_ALLOWED_ORIGINS`. Overlay TLS menyetel origin HTTPS. Untuk lingkungan tanpa HTTPS selain `localhost`, `REFRESH_COOKIE_SECURE=false` diperlukan, tetapi jangan dipakai di production.
- **Login.** Selain limit per IP, setiap email mendapat backoff eksponensial setelah lima kegagalan (30 detik sampai 15 menit). Penghitung ikut berlaku untuk email yang tidak terdaftar agar tidak membocorkan keberadaan akun.
- **Keranjang.** Mutasi memakai `If-Match`/`ETag` (412 bila usang, 428 bila tidak ada). `version` di body masih diterima sementara dengan header `Deprecation` (RFC 9745).
- **Pembatalan.** Saga dengan kompensasi: niat batal disimpan dulu (`CANCELLATION_REQUESTED`), lalu product-service melepas stok secara idempotent. Pelepasan untuk ID tanpa receipt menulis tombstone sehingga reservasi yang terlambat ditolak. Bila product-service tidak terjangkau, API menjawab 202 dan recovery menyelesaikannya.
- **Retensi.** Pemetaan Idempotency-Key, alias checkout, dan tiket dihapus 24 jam (`IDEMPOTENCY_RETENTION_HOURS`) setelah order-nya selesai; yang masih PENDING atau sedang dibatalkan ditunda. Refresh token, keluarga sesi, dan penghitung login dihapus setelah kedaluwarsa. Order dan receipt reservasi tidak dihapus.
- **Migrasi skema.** Storage memakai migrasi inti bertahap (`SCHEMA_VERSION` 3) ditambah migrasi bernama milik tiap service yang dicatat di tabel `schema_migrations`. Setiap langkah berjalan dalam transaksinya sendiri. Sebelum database berisi data dimigrasi, salinan dibuat dengan `VACUUM INTO` (`<service>.sqlite.pre-<langkah>-<timestamp>.bak` di folder data). Database yang ditulis versi lebih baru (versi inti lebih tinggi atau migrasi service yang tidak dikenal) ditolak saat start.
- **Tabel relasional.** Order (`orders`, `order_lines`) dan katalog (`products`) pindah dari blob JSON ke tabel `STRICT` dengan `CHECK` dan indeks `(user_id, created_at, id)`, `(status, created_at, id)`, `(created_at, id)`, serta `(name, id)`. Daftar, ringkasan admin, dan antrean recovery menjadi query SQL; stok diubah dengan `UPDATE ... SET stock = stock + ?` dan database menolak stok negatif. Kolom menyimpan yang difilter dan diagregasi; sisa order (snapshot item, alamat, data pembatalan) tetap JSON di kolom `details`. Receipt reservasi tetap key/value karena hanya dibaca per ID. Pindah ke PostgreSQL tetap mungkin bila butuh multi-host; skemanya bisa dibawa hampir apa adanya.
- **Batas tahan per pelanggan (OWASP API6).** Maksimal 5 pesanan aktif dan 10 unit per produk (`ORDER_MAX_OPEN_ORDERS`, `ORDER_MAX_UNITS_PER_PRODUCT`), diperiksa dalam transaksi pembuatan order.
- **Versi dan inventaris API (OWASP API9).** Gateway melayani `/v1/...`; jalur tanpa versi menjadi alias dengan `Deprecation`, `Sunset` (`LEGACY_API_SUNSET`, bawaan 14 Mei 2027), dan `Link: rel="successor-version"`, dan dapat dimatikan dengan `LEGACY_API_ENABLED=false`. Spesifikasi OpenAPI 3.1 dibangkitkan dari skema zod dan dibandingkan dengan router setiap service oleh tes.
- **Container.** Root filesystem read-only; hanya volume data/keys dan tmpfs (`/tmp`, cache nginx, masing-masing 64 MB) yang dapat ditulis.

Batas yang belum ditangani:

- Access token yang sudah terbit tetap berlaku sampai 15 menit setelah logout atau pencabutan sesi.
- Pencarian nama produk dan order memakai `instr(lower(...))` yang memindai tabel; `lower()` SQLite hanya melipat huruf ASCII. Pakai FTS5 bila katalog sangat besar.
- Receipt reservasi dan tombstone disimpan selamanya; retensinya menunggu kebijakan retur.
- Belum ada pembayaran, sehingga order terkonfirmasi langsung menahan stok. Batas tahan berlaku per akun; banyak akun hasil registrasi otomatis tetap bisa menahan stok bersama-sama karena registrasi belum memakai CAPTCHA atau verifikasi email (OWASP API6).
- Spesifikasi OpenAPI belum divalidasi linter eksternal; pemeriksaan strukturalnya dilakukan tes sendiri.

Pemetaan lengkap ke OWASP API Security Top 10: [OWASP-API-SECURITY.md](OWASP-API-SECURITY.md).
