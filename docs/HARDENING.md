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
- **Login.** Selain limit per IP, setiap email mendapat backoff eksponensial setelah lima kegagalan (30 detik sampai 15 menit). Penghitung ikut berlaku untuk email yang tidak terdaftar agar tidak membocorkan keberadaan akun. Akun yang belum diverifikasi dijawab persis seperti password salah. Browser yang pernah berhasil masuk membawa cookie `device_id` dan dinilai dengan penghitungnya sendiri, sehingga backoff yang dipicu orang lain tidak menahan pemilik akun di browser itu.
- **Keranjang.** Mutasi memakai `If-Match`/`ETag` (412 bila usang, 428 bila tidak ada). `version` di body masih diterima sementara dengan header `Deprecation` (RFC 9745).
- **Pembatalan.** Saga dengan kompensasi: niat batal disimpan dulu (`CANCELLATION_REQUESTED`), lalu product-service melepas stok secara idempotent. Pelepasan untuk ID tanpa receipt menulis tombstone sehingga reservasi yang terlambat ditolak. Bila product-service tidak terjangkau, API menjawab 202 dan recovery menyelesaikannya.
- **Retensi.** Pemetaan Idempotency-Key, alias checkout, dan tiket dihapus 24 jam (`IDEMPOTENCY_RETENTION_HOURS`) setelah order-nya selesai; yang masih PENDING atau sedang dibatalkan ditunda. Refresh token, keluarga sesi, dan penghitung login dihapus setelah kedaluwarsa. Order dan receipt reservasi tidak dihapus.
- **Migrasi skema.** Storage memakai migrasi inti bertahap (`SCHEMA_VERSION` 3) ditambah migrasi bernama milik tiap service yang dicatat di tabel `schema_migrations`. Setiap langkah berjalan dalam transaksinya sendiri. Sebelum database berisi data dimigrasi, salinan dibuat dengan `VACUUM INTO` (`<service>.sqlite.pre-<langkah>-<timestamp>.bak` di folder data). Database yang ditulis versi lebih baru (versi inti lebih tinggi atau migrasi service yang tidak dikenal) ditolak saat start.
- **Tabel relasional.** Order (`orders`, `order_lines`) dan katalog (`products`) pindah dari blob JSON ke tabel `STRICT` dengan `CHECK` dan indeks `(user_id, created_at, id)`, `(status, created_at, id)`, `(created_at, id)`, serta `(name, id)`. Daftar, ringkasan admin, dan antrean recovery menjadi query SQL; stok diubah dengan `UPDATE ... SET stock = stock + ?` dan database menolak stok negatif. Kolom menyimpan yang difilter dan diagregasi; sisa order (snapshot item, alamat, data pembatalan) tetap JSON di kolom `details`. Receipt reservasi tetap key/value karena hanya dibaca per ID. Pindah ke PostgreSQL tetap mungkin bila butuh multi-host; skemanya bisa dibawa hampir apa adanya.
- **Batas tahan per pelanggan (OWASP API6).** Maksimal 5 pesanan aktif dan 10 unit per produk (`ORDER_MAX_OPEN_ORDERS`, `ORDER_MAX_UNITS_PER_PRODUCT`), diperiksa dalam transaksi pembuatan order.
- **Versi dan inventaris API (OWASP API9).** Gateway melayani `/v1/...`; jalur tanpa versi menjadi alias dengan `Deprecation`, `Sunset` (`LEGACY_API_SUNSET`, bawaan 14 Mei 2027), dan `Link: rel="successor-version"`, dan dapat dimatikan dengan `LEGACY_API_ENABLED=false`. Spesifikasi OpenAPI 3.1 dibangkitkan dari skema zod dan dibandingkan dengan router setiap service oleh tes.
- **Container.** Root filesystem read-only; hanya volume data/keys dan tmpfs (`/tmp`, cache nginx, masing-masing 64 MB) yang dapat ditulis.

Kontrol terbaru dan batas yang tersisa:

- Logout memakai pencabutan keluarga sesi (`sid`). Auth menolak langsung; product/order memakai cache 5 detik (ditambah waktu komunikasi). Cache kedaluwarsa dan auth gagal dihubungi menghasilkan 503, sehingga JWT tidak diterima terus sampai kedaluwarsa. Ketersediaan operasi terproteksi kini bergantung pada sinkronisasi pencabutan.
- Pencarian nama produk dan order memakai `instr(lower(...))` yang memindai tabel; `lower()` SQLite hanya melipat huruf ASCII. Pakai FTS5 bila katalog sangat besar.
- Receipt reservasi dan tombstone disimpan selamanya; retensinya menunggu kebijakan retur.
- Belum ada pembayaran, sehingga order terkonfirmasi langsung menahan stok. Batas tahan berlaku per akun dan mencakup pembatalan yang belum selesai. Verifikasi email diwajibkan sebelum akun bisa masuk; CAPTCHA belum dipasang dan banyak email terverifikasi masih dapat dimiliki satu orang.
- OpenAPI diperiksa generator, tes cakupan/kontrak, dan linter Redocly melalui `npm run openapi:check`. Hasil tersebut tidak menggantikan DAST atau penetration test.

## Audit ulang 14 November 2026

Perubahan dari pemeriksaan ulang terhadap OWASP API Security Top 10 dan OWASP Top 10:

- **Penjaga route internal (API5/API8).** `isInternalPath` kini mencocokkan path yang akan dikirim proxy, bukan hanya yang diterima. Sebelumnya `/v1/auth/./internal/...`, `%2e`, dan `.\` lolos dari gateway dan tiba di auth-service sebagai `/internal/...`; hanya service token yang masih menahannya. Lewat nginx celah ini tidak terjangkau karena nginx menormalisasi URL; yang terdampak adalah akses langsung ke gateway.
- **Batas waktu gateway (API4).** `requestTimeout` Fastify bawaannya tanpa batas. Kini 15 detik (`GATEWAY_REQUEST_TIMEOUT_MS`), dan upstream yang menggantung dilepas setelah 15 detik (`GATEWAY_UPSTREAM_TIMEOUT_MS`) dengan jawaban 504.
- **Daftar pencabutan sesi (API4).** Batas baca 1 MiB hanya memuat sekitar 15.000 sesi, padahal skemanya menerima 100.000. Di atas batas itu daftar gagal dibaca dan semua request terproteksi di product/order dijawab 503. Batas baca kini 8 MiB, sepadan dengan batas skema.
- **Error handler Express (API8).** URL dengan percent-encoding rusak dan body dengan `Content-Encoding` tak didukung atau rusak sebelumnya dijawab 500; kini 400 atau 415 tanpa meneruskan pesan aslinya.
- **Header di tepi (API8).** Gateway membuang `access-control-*` kiriman service di belakangnya (nilai bawaan service menimpa `CORS_ORIGIN` gateway) dan memberi `Cache-Control: no-store` pada respons yang tidak menyatakan aturan cache sendiri.
- **TLS ke upstream.** `@fastify/reply-from` tidak memverifikasi sertifikat upstream secara bawaan. Verifikasi diaktifkan; berlaku bila URL service memakai `https://`.
- **Jejak audit (A09).** Baris log `request completed`/`request errored` di service memuat `userId`, `role`, dan `sessionId` dari token yang sudah diverifikasi. Error handler gateway kini mencatat penyebab error.

Empat risiko yang semula dicatat sebagai belum ditutup, dan penutupannya:

- **Penebakan akun lewat pendaftaran (API2).** `POST /auth/register` selalu menjawab `202` dengan isi yang sama. Alamat yang sudah punya akun tidak diubah; pemiliknya diberi tahu lewat email. Password selalu di-hash dan setiap hasil menulis satu record, sehingga lamanya respons juga sama; email dikirim setelah respons ditulis. Login menolak akun yang belum diverifikasi dengan jawaban password salah, karena tanpa itu "daftar lalu coba masuk" membocorkan hal yang sama.
- **Alamat diduduki akun yang tidak diverifikasi.** Verifikasi membutuhkan tautan dari email dan password akun, jadi pemilik kotak surat tidak bisa mengaktifkan pendaftaran orang lain, dan pendaftar tidak bisa mengaktifkan alamat yang emailnya tidak ia baca. Mendaftar ulang mengganti password akun yang belum diverifikasi; akun itu dihapus setelah 24 jam. Reset password lewat tautan email (`/auth/password-reset`, `/auth/password-reset/confirm`) mengakhiri semua sesi akun, melupakan perangkat yang dikenal, dan sekaligus memverifikasi akun.
- **Backoff login dipakai mengunci korban.** Device cookie (pola OWASP): browser yang pernah berhasil masuk ke suatu akun dinilai dengan penghitung kegagalan cookie-nya sendiri. Cookie bukan kredensial dan hangus setelah lima password salah.
- **Kualitas kode dan rantai pasok.** ESLint memeriksa promise yang tidak di-await (`no-floating-promises`, `no-misused-promises`, `await-thenable`) pada semua berkas yang tercakup tsconfig. Action GitHub di-pin ke commit SHA.

Daftar pencabutan sesi ikut dirapikan: tiap sesi mencatat sampai kapan access token terakhirnya berlaku, sehingga sesi yang sudah lama diam dicabut tanpa menambah entri dan entri hanya hidup selama access token masih bisa dipakai (bukan 61 menit). Itu membuat pencabutan semua sesi saat reset password tidak membengkakkan daftar.

Batas yang tersisa:

- Dengan `EMAIL_VERIFICATION_REQUIRED=false` (hanya untuk pengembangan lokal) akun langsung aktif, sehingga perlindungan terhadap penebakan akun dan pendudukan alamat tidak berlaku.
- Device cookie tidak menolong perangkat baru milik korban selama serangan berlangsung; jalan keluarnya lupa password. Siapa pun yang membaca kotak surat korban dapat mengambil alih akunnya, seperti pada semua reset lewat email.
- Perbedaan waktu respons pendaftaran dan permintaan reset sudah disamakan sebatas yang bisa dilakukan aplikasi; pengukuran statistik jangka panjang dari jaringan yang sama tidak diuji.
- Pendaftaran dan lupa password mengirim email ke alamat yang diminta siapa pun. Batasnya satu email per jenis per menit dan sepuluh per 24 jam per alamat; orang yang menghabiskan kuota itu membuat pemilik alamat tidak bisa meminta tautan baru sampai jendelanya berakhir (tautan yang sudah terkirim tetap berlaku). CAPTCHA belum dipasang.
- Daftar pencabutan tetap punya batas keras 100.000 sesi yang masih aktif, dan limiter masih per proses.
- Uji browser Playwright (`scripts/e2e-browser-security.mjs`) sudah disesuaikan dengan alur baru tetapi belum dijalankan ulang.

## Pengiriman verifikasi email

Compose dasar adalah mode pelatihan: `MAIL_TRANSPORT=outbox` dan `MAIL_ALLOW_INSECURE_OUTBOX=true`. Admin membaca email simulasi pada `/admin/outbox`; tidak ada pengiriman ke inbox nyata. Akun biasa lama tanpa flag verifikasi tidak bisa masuk sampai pemiliknya mendaftar ulang dengan alamat yang sama (password lama tetap dipakai untuk verifikasi) atau memakai lupa password. Token verifikasi sekali pakai berlaku 24 jam dan hanya berguna bersama password akun; token atur ulang password berlaku 1 jam.

Untuk pengiriman nyata, siapkan relay HTTPS yang menerima JSON `{to, subject, text}`, `MAIL_WEBHOOK_TOKEN` dari secret, `FRONTEND_ORIGIN` HTTPS, serta konfigurasi TLS. Jalankan dengan tambahan `-f docker-compose.mail.yml` setelah overlay TLS. Overlay mail mematikan outbox dan memberi auth-service network egress; backend lain tetap pada network internal. Endpoint kotak surat tidak tersedia pada mode webhook. Provider dan pengiriman inbox nyata harus diuji oleh operator sebelum deployment.

Lihat [bab penutupan celah keamanan](materi-lanjutan/08-penutupan-celah-keamanan.md) untuk alur, dampak migrasi, dan praktikum.

Pemetaan lengkap ke OWASP API Security Top 10: [OWASP-API-SECURITY.md](OWASP-API-SECURITY.md).
