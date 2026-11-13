# Pemetaan OWASP API Security Top 10 (2023)

Dokumen ini memetakan setiap risiko [OWASP API Security Top 10 — 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) ke kontrol yang ada di kode, tempat kontrol itu berada, dan pengujian yang membuktikannya berjalan. Celah yang masih terbuka ditulis apa adanya.

Status per 14 November 2026, cabang `main`. Bukti "E2E" mengacu pada nama pemeriksaan di [`scripts/e2e.mjs`](../scripts/e2e.mjs) yang dijalankan terhadap stack Docker nyata melalui nginx dan gateway.

## Ringkasan

| Risiko                                               | Status    | Kontrol utama                                                                  |
| ---------------------------------------------------- | --------- | ------------------------------------------------------------------------------ |
| API1 Broken Object Level Authorization               | Terpenuhi | Kepemilikan dari klaim `sub` JWT; order orang lain dijawab 404                 |
| API2 Broken Authentication                           | Sebagian  | RS256 + JWKS, access token 15 menit, refresh token berotasi, backoff per akun  |
| API3 Broken Object Property Level Authorization      | Terpenuhi | Skema zod membuang field tak dikenal; respons dipetakan ke bentuk publik       |
| API4 Unrestricted Resource Consumption               | Sebagian  | Rate limit berlapis, batas body/halaman/item, timeout, batas memori container  |
| API5 Broken Function Level Authorization             | Terpenuhi | `requireRole`/`requireAdmin` di server; route internal butuh service token     |
| API6 Unrestricted Access to Sensitive Business Flows | Sebagian  | Idempotensi, reservasi stok atomik, batas jumlah; belum ada batas per pengguna |
| API7 Server Side Request Forgery                     | Terpenuhi | Tidak ada URL dari pengguna; ID divalidasi UUID dan di-encode                  |
| API8 Security Misconfiguration                       | Terpenuhi | Header keamanan, CORS allowlist, error generik, container non-root read-only   |
| API9 Improper Inventory Management                   | Sebagian  | Referensi API manual, gateway allowlist prefix; belum ada OpenAPI/versi        |
| API10 Unsafe Consumption of APIs                     | Terpenuhi | Respons upstream divalidasi skema dan aritmetikanya diperiksa ulang            |

"Terpenuhi" berarti kontrol yang relevan untuk fitur yang ada sudah diterapkan dan diuji, bukan bahwa risikonya nol.

## API1 — Broken Object Level Authorization

**Kontrol.** Identitas pemilik selalu diambil dari klaim `sub` JWT yang sudah diverifikasi, tidak pernah dari body atau query. Order milik pengguna lain dijawab 404 (bukan 403) agar keberadaan ID tidak terbongkar.

- Keranjang disimpan per `sub`: [`cart.ts:13`](../services/order-service/src/cart.ts#L13), dipanggil dengan `req.user.sub` di [`routes.ts`](../services/order-service/src/routes.ts).
- Detail order: [`orders.ts` `getOrder`](../services/order-service/src/orders.ts) memeriksa `order.userId !== userId`.
- Pembatalan: [`orders.ts:195`](../services/order-service/src/orders.ts#L195) memakai pemeriksaan yang sama.
- Daftar order pelanggan selalu ditambah filter `userId` dari token.

**Bukti uji.**

- Unit: `idempotency.test.ts` › _coalesces concurrent retries, rejects key reuse and hides other users orders_; `cart-cancel.test.ts` › _lets the owner cancel a new order, restocks once and hides it from others_.
- E2E: _concurrent same-key requests produce one order…_ (pengguna lain mendapat 404 dan daftar kosong), _cancelling an order returns its stock exactly once_ (pembatalan oleh pengguna lain 404).

## API2 — Broken Authentication

**Kontrol.**

- JWT RS256; verifikasi mengunci algoritme, `iss`, `aud`, `sub`, dan `exp`: [`require-auth.ts`](../services/product-service/src/middleware/require-auth.ts). Token dengan `alg` selain RS256 atau `kid` tidak valid ditolak sebelum mencari key.
- Kunci publik diambil dari JWKS dengan cache dan cooldown; `kid` palsu tidak bisa menghabiskan kuota fetch: [`signing-keys.ts`](../services/product-service/src/middleware/signing-keys.ts).
- Access token 15 menit. Refresh token opaque disimpan sebagai hash SHA-256, dikirim sebagai cookie `HttpOnly; Secure; SameSite=Strict; Path=/api/auth`, dirotasi setiap dipakai. Pemakaian ulang token yang sudah dirotasi mencabut seluruh sesi: [`sessions.ts` `rotateSession`](../services/auth-service/src/sessions.ts).
- Logout mencabut sesi di server. Endpoint cookie dilindungi CSRF tiga lapis (SameSite, header kustom, allowlist Origin): [`routes.ts` `requireSameSiteRequest`](../services/auth-service/src/routes.ts).
- Login: bcrypt dengan hash umpan untuk email tak dikenal (waktu respons seragam), batas 72 byte, limit per IP 20/menit, dan backoff eksponensial per akun setelah 5 kegagalan, termasuk untuk email yang tidak terdaftar: [`sessions.ts` `assertLoginAllowed`](../services/auth-service/src/sessions.ts).
- Access token hanya di memory frontend, tidak di `localStorage`.

**Bukti uji.**

- Unit: `sessions.test.ts` (9 tes: TTL 900 detik, atribut cookie, rotasi, balapan dua tab, deteksi pemakaian ulang, logout, CSRF, backoff per akun); `signing-keys.test.ts`; `product.test.ts` › _banjir token palsu ber-kid acak…_.
- E2E: _refresh tokens are HttpOnly cookies that rotate and can be revoked_, _repeated wrong passwords slow down that account only_, _forged key IDs cannot lock legitimate users out of authentication_.
- Browser (Playwright): cookie refresh tidak terlihat di `document.cookie`, tidak ada JWT di web storage, sesi pulih setelah reload, logout menutup sesi.

**Celah.**

- Access token yang sudah terbit tetap berlaku sampai 15 menit setelah logout atau pencabutan sesi (konsekuensi verifikasi terdistribusi).
- Kebijakan password hanya panjang minimum 8; belum ada pemeriksaan password bocor, verifikasi email, atau MFA.
- Belum ada endpoint ganti password atau ubah role yang mencabut sesi (fungsi pencabutan sudah tersedia di `sessions.ts`).

## API3 — Broken Object Property Level Authorization

**Kontrol.**

- Mass assignment: semua body divalidasi `z.object`, yang membuang field yang tidak dideklarasikan. Register hanya bisa membuat role `user`: [`users.ts:68`](../services/auth-service/src/users.ts#L68).
- Harga, total, status, `userId`, dan `fulfillmentStatus` tidak pernah dibaca dari klien. Harga dan total diambil dari receipt reservasi product-service.
- Data berlebih: respons dipetakan ke bentuk publik, tanpa `passwordHash` ([`publicUser`](../services/auth-service/src/users.ts#L117)) dan tanpa `input`, `fingerprint`, `failureStatus` milik order (`publicOrder` di [`orders.ts`](../services/order-service/src/orders.ts)).

**Bukti uji.**

- Unit: `auth.test.ts` › _register → 201 dan mengembalikan user tanpa password_.
- E2E: _register, login, profile and admin bootstrap_ (register dengan `role: 'admin'` tetap menghasilkan role `user`).

## API4 — Unrestricted Resource Consumption

**Kontrol.**

- Rate limit berlapis: gateway 100/menit/IP ([`app.ts`](../services/gateway/src/app.ts)), backstop per service 300/menit/IP, login/register 20/menit/IP, refresh/logout 60/menit/IP. Panggilan antar-service dikecualikan hanya bila membawa service token valid.
- Ukuran: body 100 KB di service dan nginx, respons upstream maksimal 1 MiB ([`resilient-http-client`](../packages/resilient-http-client/src/index.ts)).
- Jumlah: halaman maksimal 100, 50 produk per order/keranjang, kuantitas 1–1000, pencarian 100 karakter ([`schemas.ts`](../services/order-service/src/schemas.ts)).
- Waktu: timeout per percobaan dan total, `requestTimeout` server 15 detik, maksimal 32 operasi reservasi/pelepasan aktif per proses.
- Retensi: Idempotency-Key, refresh token, dan penghitung gagal login dihapus terjadwal, sehingga tabel tidak tumbuh tanpa batas.
- Container: `mem_limit` 512 MB, `cpus` 1, `pids_limit` 128, tmpfs dibatasi 64 MB.

**Bukti uji.**

- Unit: `gateway.test.ts` › _rate-limit exhaustion returns a consistent 429_; `rate-limit.test.ts`; `auth.test.ts` › _maps malformed JSON to 400 and oversized payloads to 413_; `cart-cancel.test.ts` › _forgets keys of settled orders after the retention window…_.
- E2E: _cart catalog reads for all users are not throttled as one client_, _305 health polls do not exhaust business or health quotas_, `GET /products?limit=1000` → 400.

**Celah.** Daftar order dan produk dibaca penuh dari SQLite lalu difilter di memory, sehingga biaya per request tumbuh linear dengan jumlah data. Rencana perbaikannya (tabel relasional + indeks + cursor) ada di [HARDENING.md](HARDENING.md).

## API5 — Broken Function Level Authorization

**Kontrol.**

- Endpoint admin memeriksa role di server, bukan hanya menyembunyikan menu: `requireRole('admin')` di [product-service](../services/product-service/src/routes.ts) dan `requireAdmin` di [order-service](../services/order-service/src/routes.ts).
- Endpoint internal (`/internal/reservations/*`) mewajibkan service token yang dibandingkan constant-time ([`service-token.ts`](../services/product-service/src/middleware/service-token.ts)), tidak dirutekan gateway, dan gateway membuang header `x-service-token` kiriman klien ([`correlation.ts:33`](../services/gateway/src/correlation.ts#L33)).
- Gateway hanya meneruskan prefix `/auth`, `/products`, `/orders`, `/cart`; selain itu 404.

**Bukti uji.**

- Unit: `product.test.ts` › _POST dengan token non-admin → 403 (RBAC)_; `rate-limit.test.ts` › _rejects internal reservations without a valid service token_; `gateway.test.ts` › _membuang x-service-token kiriman klien…_ dan _route tak dikenal → 404…_; `cart-cancel.test.ts` (pelanggan memanggil endpoint batal admin → 403); `admin.test.tsx` (pelanggan diarahkan keluar dari halaman admin).
- E2E: _RBAC and integer currency validation protect product writes_, _unknown routes use the uniform error shape and hide internal routes_.

## API6 — Unrestricted Access to Sensitive Business Flows

**Kontrol.**

- Checkout: Idempotency-Key wajib, satu snapshot keranjang menghasilkan paling banyak satu order, reservasi stok atomik tanpa overselling.
- Batas per request: kuantitas maksimal 1000 per produk dan 50 produk per order.
- Pembatalan oleh admin dapat mengembalikan stok yang ditahan pemesanan berlebihan.
- Login berulang dari banyak IP terhadap satu akun diperlambat per akun.

**Bukti uji.** E2E _concurrent distinct orders never oversell remaining stock_, _concurrent same-key requests produce one order and one stock deduction_; shopping E2E _one cart snapshot produces one order across concurrent different keys_.

**Celah.** Aplikasi belum memiliki pembayaran, jadi konfirmasi order langsung menahan stok. Satu akun (atau banyak akun hasil registrasi otomatis) dapat menahan seluruh stok. Mitigasi yang dianjurkan: batas unit yang ditahan per pengguna, kedaluwarsa otomatis untuk order yang belum dibayar setelah pembayaran ada, dan anti-otomasi (CAPTCHA atau verifikasi email) pada registrasi.

## API7 — Server Side Request Forgery

**Kontrol.** Tidak ada fitur yang mengambil URL dari pengguna. URL service lain berasal dari environment. ID yang disisipkan ke path upstream divalidasi sebagai UUID lalu di-`encodeURIComponent` ([`product-client.ts:34`](../services/order-service/src/product-client.ts#L34)). Lokasi JWKS tetap dari konfigurasi; header JWT seperti `jku`/`x5u` tidak dipakai untuk mengambil kunci.

**Bukti uji.** E2E _UUID validation, required key and duplicate-line stock checks_ (`productId: '../health'` → 400).

## API8 — Security Misconfiguration

**Kontrol.**

- Header: helmet di gateway dan setiap service; nginx menambahkan CSP ketat, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, dan `server_tokens off` ([`site.conf`](../frontend/site.conf)).
- CORS dengan allowlist origin, bukan `*`.
- Error tak terduga dijawab 500 generik tanpa stack trace; upstream mati dijawab 503/504, bukan 500.
- Container: user non-root, `cap_drop: [ALL]`, `no-new-privileges`, root filesystem read-only, jaringan backend `internal`, port host hanya di loopback ([`docker-compose.yml`](../docker-compose.yml)).
- Gateway hanya mempercayai `X-Forwarded-For` dari IP nginx. Secret bisa dibaca dari file; log menyensor `authorization`, `cookie`, `set-cookie`, dan `x-service-token`.
- Overlay TLS dengan HSTS tersedia di [`docker-compose.tls.yml`](../docker-compose.tls.yml).

**Bukti uji.**

- Unit: `gateway.test.ts` › _security header (helmet)…_ dan _upstream yang mati → 503…_.
- E2E: _frontend, SPA route, CSP and aggregated health_, _containers run with a read-only root filesystem_, _container logs do not contain service or administrator secrets_; `scripts/verify-tls.mjs`.

**Celah.** Konfigurasi default memakai HTTP di loopback; TLS harus diaktifkan lewat overlay untuk deployment. Image belum dipindai otomatis di CI.

## API9 — Improper Inventory Management

**Kontrol.** Seluruh endpoint publik dan internal didokumentasikan di [referensi API](materi-lanjutan/03-referensi-api.md). Gateway memakai allowlist prefix, sehingga route internal tidak terekspos. Jalur lama (`version` di body keranjang) masih diterima tetapi ditandai header `Deprecation: true`.

**Celah.** Belum ada spesifikasi OpenAPI yang dapat dibaca mesin, belum ada versi API di path atau header, belum ada tanggal sunset untuk jalur deprecated, dan belum ada tes otomatis yang membandingkan route di kode dengan dokumentasi. Ini prioritas berikutnya karena spesifikasi juga diperlukan untuk DAST yang efektif.

## API10 — Unsafe Consumption of APIs

**Kontrol.** order-service memperlakukan respons product-service sebagai input tidak tepercaya:

- Divalidasi dengan skema zod (reservasi, katalog, pelepasan) di [`product-client.ts`](../services/order-service/src/product-client.ts).
- Aritmetika diperiksa ulang: subtotal = harga × jumlah, total = jumlah subtotal, item dan jumlah sama dengan yang diminta, ID reservasi sama.
- Respons dibatasi 1 MiB, dengan timeout, retry ber-jitter, dan circuit breaker.
- Kunci JWKS hanya diterima untuk RS256 dengan `kid` berformat valid.

**Bukti uji.** Unit `idempotency.test.ts` › _rejects malformed upstream contracts and retains recoverable pending work_; `resilient.test.ts` (14 tes); `order.chaos.test.ts`; E2E _product outage degrades gracefully and pending order recovers exactly once_.

## Posisi di materi pelatihan

Sebelum dokumen ini, materi e-commerce (modul PDF, `docs/materi-lanjutan`, `docs/exercises`) tidak menyebut OWASP API Security sama sekali. Kontrol seperti RBAC, rate limit, dan helmet sudah diajarkan, tetapi tidak dikaitkan dengan kategori risikonya, dan BOLA, property-level authorization, inventory, serta unsafe consumption tidak dibahas secara eksplisit. Satu-satunya rujukan OWASP di workspace berada di modul lain (Trello Board, OWASP Top 10 untuk aplikasi web).

Materi pendamping dengan latihan per risiko: [Modul 7 — Keamanan API (OWASP)](materi-lanjutan/07-keamanan-api-owasp.md).
