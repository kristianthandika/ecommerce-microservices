> Catatan revisi: keputusan prototype di bawah mendokumentasikan versi training awal. Implementasi setelah audit memakai SQLite, reservasi stok atomik, idempotensi, dan konfigurasi keamanan pada [docs/HARDENING.md](docs/HARDENING.md).

# DECISIONS.md — Catatan Keputusan Teknis

Keputusan teknis yang diambil selama membangun sistem, beserta alasannya.

## Bahasa: TypeScript untuk semua project

- **Seluruh workspace pakai TypeScript** (bukan JavaScript).
- **Shared packages** (`logger`, `resilient-http-client`) **dikompilasi ke `dist/`**
  dengan `tsc` (+ `.d.ts`). Alasan: Node 24 menolak strip types untuk file di
  bawah `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), sedangkan
  workspace package dikonsumsi lewat symlink di `node_modules`. Jadi package =
  library terkompilasi.
- **Services** (`auth`/`product`/`order`/`gateway`) **dijalankan langsung sebagai
  `.ts`** via type stripping bawaan Node 24 (`node src/index.ts`) — tanpa build
  step. Type-safety dijaga terpisah lewat `tsc --noEmit` (`npm run typecheck`).
- **Frontend** tetap Vite + TS (esbuild). `vite` dipin ke satu versi (7.x) di
  root supaya tidak ada duplikat copy yang bikin bentrok tipe plugin.
- **Import relatif pakai ekstensi `.ts`** (bukan `.js`). Node type stripping
  butuh path file yang sesungguhnya; TS 5.7 `rewriteRelativeImportExtensions`
  menulis ulang ke `.js` saat `tsc` meng-emit package.
- `tsconfig.base.json` di root jadi basis semua workspace (`module`/`resolution`
  `nodenext`, `strict`).

## Arsitektur & scope

- **Penyimpanan in-memory (bukan database sungguhan)** — simplifikasi disengaja
  untuk scope training 4 hari; silabus menempatkan "database per service" di
  checklist "prototype menuju production". Ditulis eksplisit di README &
  `docs/PRODUCTION-CHECKLIST.md`.
- **ESM (`"type": "module"`) di seluruh workspace** — idiomatik untuk Node 24,
  konsisten dengan native `fetch` dan top-level `await`.
- **Middleware `validate`/`errors`/`require-auth` diduplikasi per service**
  (bukan dijadikan package bersama ke-3) — silabus & prompt menekankan tiap
  service mengikuti "pola sama", dan tiap service dibuat bisa dibaca berdiri
  sendiri untuk keperluan training. Hanya `logger` dan `resilient-http-client`
  yang jadi shared package (sesuai struktur yang ditentukan).

## Keamanan / auth

- **`kid` = RFC 7638 JWK thumbprint** — deterministik untuk key yang sama,
  jadi konsisten lintas restart; disematkan di JWK endpoint dan header JWT
  (`keyid`) supaya `jwks-rsa` bisa memilih key yang benar.
- **Keypair load-or-generate** — dicek dulu; kalau file ada di-load, kalau
  belum di-generate + persist. Mencegah token lama invalid saat restart.
- **Admin di-seed saat startup** (`admin@inixindo.local` / `admin123`) —
  register publik hanya boleh membuat role `user`, jadi butuh admin awal untuk
  mendemokan RBAC. KREDENSIAL DEMO — wajib diganti di production.
- **`--color-success` (#1F9254)** — di luar aset brand asli, ditambahkan untuk
  indikator "service up" pada health widget (pasangan `--color-danger`).

## Warna & brand

- Palet brand Inixindo Bandung diterapkan sebagai token CSS + di
  `tailwind.config`. Font Poppins (Google Fonts) dengan fallback system stack.

## CORS: gateway DAN service backend (disengaja, bukan duplikasi)

Setiap service Express memasang `cors` DAN gateway memasang `@fastify/cors`.
Ini terlihat redundan, tapi **diperlukan**: `@fastify/http-proxy` meneruskan
header CORS dari upstream, dan `@fastify/cors` TIDAK menambahkan
`Access-Control-Allow-Origin` pada respons yang di-proxy. Terverifikasi: respons
proxied hanya membawa SATU header ACAO (dari service backend), bukan duplikat.
Karena itu `CORS_ORIGIN` service backend di-set ke origin frontend (via env di
`docker-compose.yml`). JANGAN menghapus CORS dari service backend "untuk
merapikan" — browser akan kehilangan ACAO pada request lewat gateway.

## Perbaikan hasil code review (keamanan & edge case)

- **auth login**: selalu jalankan `bcrypt.compare` (dengan hash umpan saat email
  tak dikenal) → menutup timing oracle untuk user enumeration.
- **resilient client**: pembatalan oleh caller tidak lagi salah diklasifikasi
  sebagai `TimeoutError`; circuit breaker HALF_OPEN hanya mengizinkan SATU probe
  konkuren (tidak membanjiri upstream yang belum pulih).
- **frontend api client**: `JSON.parse` dibungkus try/catch → body non-JSON
  (mis. 502/504 dari proxy) tetap jadi `ApiError` yang seragam.
- **order create**: lookup produk paralel (`Promise.all`) → latency tidak tumbuh
  linear dengan jumlah item.
- **auth getUserById**: indeks by-id (O(1)) menggantikan linear scan.

## Perbaikan hasil security review

- **Batas ukuran input** (anti-DoS/amplifikasi): `items` order dibatasi maks 50 &
  quantity maks 1000 (satu request tidak bisa memicu ratusan panggilan ke
  product-service); nama/harga/stok produk & panjang email/password diberi batas
  atas wajar.
- **Header keamanan frontend** (nginx): `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`. CSP sengaja tidak di-hardcode
  (bergantung origin gateway per-deployment).
- **Dependency**: `bcrypt` → v6 (menghapus rantai rentan `node-pre-gyp`/`tar`);
  OpenTelemetry SDK dinaikkan (`@opentelemetry/core` ≥ 2.8, menutup advisory
  W3C Baggage) sekaligus membuang 50 paket exporter OTLP yang tak dipakai.
  Hasil: `npm audit --omit=dev` = **0 kerentanan produksi**. Sisa kerentanan
  hanya di devDependency (vite/vitest/esbuild/autocannon) — tidak masuk image
  runtime.

## Keputusan lanjutan (14 November 2026)

- **Sesi: access token pendek + refresh token berotasi** — access token 15 menit
  tetap diverifikasi lokal via JWKS (tidak menambah panggilan ke auth-service per
  request). Refresh token opaque di cookie `HttpOnly; SameSite=Strict` dirotasi
  tiap pakai; pemakaian ulang di luar jendela 10 detik mencabut seluruh keluarga
  sesi. Jendela 10 detik ada karena dua tab yang me-refresh bersamaan bukan
  pencurian. Trade-off: token yang sudah terbit tidak bisa dicabut ≤15 menit.
  Ini menggantikan keputusan m4.1 "refresh halaman = login ulang".
- **Backoff login per akun, bukan lockout** — lockout permanen memberi penyerang
  cara mengunci akun korban; backoff 30 detik–15 menit memperlambat tebakan
  tanpa itu. Berlaku juga untuk email tak terdaftar (anti-enumerasi).
- **Concurrency keranjang via `If-Match`/`ETag`** — mekanisme standar HTTP;
  body pada `DELETE` tidak punya arti baku dan bisa dibuang proxy. Body
  `version` diterima sementara dengan header `Deprecation` (RFC 9745).
- **Pembatalan sebagai saga** — niat disimpan durable lebih dulu, pelepasan stok
  idempotent, tombstone untuk reservasi yang masih di jalan. Tidak memakai
  two-phase commit/event bus: recovery worker yang sudah ada cukup untuk satu
  langkah kompensasi.
- **Retensi Idempotency-Key 24 jam setelah order selesai** — hanya pemetaan yang
  dihapus, order tetap. Key order yang belum selesai tidak pernah dihapus.
- **Migrasi skema bertahap di storage** — daftar migrasi berurutan, tiap langkah
  satu transaksi, backup `VACUUM INTO` sebelum migrasi data lama.
- **Root filesystem read-only** untuk semua container; tmpfs dibatasi ukurannya.
- **Ditunda lalu dikerjakan (14 November 2026)**: tabel relasional, OpenAPI dan
  versi API, batas stok per pengguna. Lihat bagian berikut.

## Keputusan lanjutan: storage relasional, API6, API9 (14 November 2026)

- **Tabel relasional di SQLite yang sama, bukan PostgreSQL** — satu file per service
  tetap cukup untuk satu host; yang lambat adalah membaca semua blob lalu memfilter
  di JavaScript, bukan SQLite-nya. Kolom untuk yang difilter/diurutkan/diagregasi,
  JSON `details` untuk sisanya (snapshot item, alamat) supaya skema tidak meledak
  menjadi banyak tabel kecil. Kolom adalah sumber kebenaran; `details` tidak
  menyalinnya. Receipt reservasi tetap key/value karena hanya dibaca per ID.
- **Migrasi bernama per service (`schema_migrations`)** — `user_version` tetap untuk
  migrasi inti paket storage; tiap service punya daftar migrasi bernama sendiri.
  Satu angka versi bersama tidak bisa dipakai dua service yang skemanya berbeda.
  Build lama menolak database yang memuat migrasi yang tidak ia kenal.
- **Offset tetap ada, cursor ditambahkan** — UI memakai halaman bernomor dengan
  total, jadi offset dipertahankan tetapi dibatasi 10.000. Cursor keyset untuk klien
  API dan halaman dalam. Katalog produk tetap offset: kecil dan dikurasi admin.
- **Batas tahan stok 5 pesanan aktif / 10 unit per produk** — nilai awal untuk toko
  merchandise pelatihan; bisa diubah lewat env tanpa rilis. Dihitung dari pesanan
  aktif (bukan per request) karena yang disalahgunakan adalah stok yang ditahan.
  Diperiksa di transaksi pembuatan order supaya request paralel tidak lolos; retry
  dengan key yang sama dijawab lebih dulu supaya tidak pernah ditolak.
- **Tidak ada batas registrasi per jam per IP** — peserta satu kelas berbagi satu IP
  publik; batas seperti itu memblokir pengguna sah. Anti-otomasi yang tepat (CAPTCHA,
  verifikasi email) butuh layanan pihak ketiga dan dicatat sebagai celah.
- **Versi di path (`/api/v1`), bukan header** — terlihat di log, mudah di-cache, dan
  mudah dicoba dari browser. Jalur lama dipertahankan sebagai alias dengan
  `Deprecation`/`Sunset`/`Link` alih-alih langsung dimatikan. Cookie refresh pindah ke
  `Path=/api/v1/auth`; endpoint refresh baru diperkenalkan di rilis yang sama, jadi
  tidak ada klien lama yang bergantung pada path cookie lama.
- **OpenAPI dibangkitkan dari zod, bukan ditulis tangan** — skema request diambil dari
  objek yang sama dengan yang memvalidasi request, sehingga dokumen tidak bisa
  menyimpang diam-diam. Skema request dipindah ke `schemas.ts` tiap service agar bisa
  diimpor tanpa membuka database. Skema respons ditulis di generator dan dibuktikan
  terhadap respons nyata oleh E2E.

## Catatan lain

- (diisi bila ada blocker/command interaktif yang butuh penanganan khusus)
