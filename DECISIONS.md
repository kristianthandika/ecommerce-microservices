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

## Catatan lain

- (diisi bila ada blocker/command interaktif yang butuh penanganan khusus)
