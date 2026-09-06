# Latihan per Fitur (m0.1 – m4.5) + Cara Debugging

Materi praktikum 16 fitur. Tiap bagian: **Tujuan**, **Yang dibangun**,
**Acceptance**, dan **Cara Debugging** (jebakan SPESIFIK fitur itu — bukan
sekadar "cek log"). Jebakan diambil dari audit desain sistem ini.

> Catatan penyampaian: implementasi lengkap ada di `main` (satu commit per
> modul). Untuk kelas berbasis latihan, tiap fitur bisa dijadikan pasangan
> branch `starter/`(kosong + bagian ini) dan `solution/`(terisi).

---

## MODUL 0 — Bootstrap & Brand

### m0.1 Monorepo Bootstrap
- **Tujuan:** memahami npm workspaces sebagai monorepo sederhana.
- **Yang dibangun:** root `package.json` (workspaces `packages/*`,`services/*`,`frontend`), `tsconfig.base.json`, ESLint/Prettier, `.env.example`.
- **Acceptance:** `npm install` sukses & me-link seluruh workspace.
- **Cara Debugging:** "Cannot find module" untuk package internal → `npm ls --workspaces` untuk pastikan symlink terbentuk; cocokkan path di `workspaces` dengan struktur folder. Di TS: import antar-service pakai ekstensi `.ts`, dan **shared package harus di-build** (`npm run build:packages`) karena Node menolak type-stripping di `node_modules`.

### m0.2 Brand & Shared Infrastructure
- **Tujuan:** satu konfigurasi logger dipakai ulang; token brand konsisten.
- **Yang dibangun:** `packages/logger` (pino JSON + correlation id), Tailwind token brand, aset `logo.png`/`footer.png`.
- **Acceptance:** log JSON terstruktur dari service; warna & logo brand tampil di frontend.
- **Cara Debugging:** log tidak JSON → cek `LOG_LEVEL` dan pastikan pretty-print hanya aktif via `LOG_PRETTY=true` (bukan default). Warna brand tidak muncul → cek `content` glob di `tailwind.config.js` mencakup `./src/**/*.{ts,tsx}`.

---

## MODUL 1 — Fondasi & auth-service

### m1.1 Service Boundary Design
- **Tujuan:** merancang batas layanan (DDD ringan) & menghindari anti-pattern.
- **Yang dibangun:** `docs/BOUNDARY.md` (event storming, bounded context, alasan, 3 anti-pattern, pengantar Saga).
- **Acceptance:** dokumen mencakup kelima bagian.
- **Cara Debugging (review):** cek desain benar-benar **menghindari** distributed monolith / nanoservice / shared database — bukan cuma menyebut istilah.

### m1.2 auth-service Bootstrap & Security Middleware
- **Tujuan:** pola service Express production-grade.
- **Yang dibangun:** helmet, cors, express-rate-limit, `pino-http`, error handler terpusat, middleware validasi `zod`.
- **Acceptance:** route yang `throw` mengembalikan JSON error terstruktur (bukan stack trace); body invalid → 400 (bukan 500); log request JSON.
- **Cara Debugging:** error tidak sampai ke handler → jangan bungkus dengan `try/catch` yang menelan error; Express 5 menangkap `throw`/reject async otomatis. Response HTML default Express → pastikan error handler didaftarkan **paling akhir**.

### m1.3 Register/Login, JWT RS256, JWKS
- **Tujuan:** auth terdistribusi berbasis kunci publik.
- **Yang dibangun:** bcrypt, keypair RS256 **load-or-generate**, `kid` = JWK thumbprint, endpoint `/.well-known/jwks.json`.
- **Acceptance:** register→login→akses route terproteksi→token invalid ditolak; JWK dari endpoint benar-benar bisa memverifikasi token; restart tidak menghasilkan keypair baru.
- **Cara Debugging:** `bcrypt.compare` selalu false → urutan argumen `compare(plain, hash)`. `invalid signature` di service lain → **`kid`**: `export({format:'jwk'})` TIDAK memberi `kid`; sematkan `kid` yang sama di JWK **dan** header JWT (`keyid`). Token invalid setelah restart → pastikan keypair **di-load** dari file kalau sudah ada (bukan generate ulang).

---

## MODUL 2 — Layanan Kedua, Komunikasi & Resilience

### m2.1 product-service & Distributed Auth
- **Tujuan:** verifikasi JWT tanpa memanggil auth-service tiap request.
- **Yang dibangun:** `jwks-rsa` (cache), RBAC admin-only, validasi zod produk.
- **Acceptance:** setelah panggilan pertama, mematikan auth-service TIDAK mempengaruhi verifikasi berikutnya (dari cache); non-admin → 403; body invalid → 400.
- **Cara Debugging:** `ECONNREFUSED` ke auth padahal jalan → jangan hardcode hostname Docker; pakai `AUTH_SERVICE_URL` (default localhost). JWKS ter-fetch tapi gagal verifikasi → cocokkan `kid` header JWT dengan `kid` di JWKS.

### m2.2 Resilient HTTP Client (dari nol)
- **Tujuan:** memahami timeout/retry/circuit breaker dengan menulisnya sendiri.
- **Yang dibangun:** `withTimeout`, `withRetry` (exponential backoff + jitter), `withCircuitBreaker` (CLOSED→OPEN→HALF_OPEN→CLOSED), `createResilientClient`.
- **Acceptance:** unit test tiap wrapper terisolasi (lihat `packages/resilient-http-client/tests`).
- **Cara Debugging:** breaker tidak pernah OPEN → state harus **persist** di closure (jangan dibuat ulang tiap panggilan). Retry tanpa jeda → pastikan delay benar-benar `await sleep(...)`.

### m2.3 order-service + Chaos Test
- **Tujuan:** komunikasi antar-service yang tangguh + graceful degradation.
- **Yang dibangun:** order store, `resilient-http-client` ke product-service (URL dari env), auth `jwks-rsa`.
- **Acceptance (3 skenario):** normal 201; product mati → order tetap merespons (503 graceful, bukan hang/crash); setelah breaker OPEN, panggilan ke product **tidak bertambah linear**. Test keluar bersih tanpa `--forceExit`.
- **Cara Debugging:** test menggantung → `await` `server.close()` di `afterAll` (promisify). Hasil chaos tidak konsisten → tunggu threshold breaker tercapai sebelum assertion.

---

## MODUL 3 — Gateway, Observability & Pola Lanjutan

### m3.1 API Gateway (Fastify)
- **Tujuan:** Backend-for-Frontend, satu pintu masuk.
- **Yang dibangun:** `@fastify/http-proxy` ke 3 service (target dari env), `@fastify/rate-limit` + `@fastify/helmet`, penerusan **X-Forwarded-For** anti-spoof.
- **Acceptance:** proxy benar; rate-limit & security header aktif; `req.ip` di service = IP klien asli.
- **Cara Debugging:** 502/504 → cek dulu service target langsung (`curl :3002/health`) untuk memisahkan masalah gateway vs service mati. **Dua lapis rate-limit itu disengaja** (gateway + per-service) — kalau dapat 429 tak terduga, cek limit per-service jangan lebih kecil dari gateway.

### m3.2 Correlation ID & Log Correlation
- **Tujuan:** satu request tertelusur lintas service.
- **Yang dibangun:** correlation id di gateway (`genReqId` + hook), diteruskan ke hop berikutnya; order-service meneruskan ke product-service.
- **Acceptance:** satu request gateway→order→product menghasilkan correlation id **yang sama** di log **ketiga** service.
- **Cara Debugging:** id hilang di product (hop kedua) → order harus **meneruskan** header `x-correlation-id` ke panggilan ke product (jangan generate baru). Cek: `docker compose logs <svc> | grep <id>` di ketiga service.

### m3.3 Health Agregat, Tracing, Load Test
- **Tujuan:** observability dasar + kapasitas.
- **Yang dibangun:** `/health` agregat, tracing `@fastify/otel` + ConsoleSpanExporter, script `autocannon`.
- **Acceptance:** `/health` benar per service; **span benar-benar tercetak** di console; load test menghasilkan file.
- **Cara Debugging:** span tidak muncul → pastikan pakai `@fastify/otel`, **BUKAN** `@opentelemetry/instrumentation-fastify` (deprecated) atau asumsi `auto-instrumentations-node` (sudah drop Fastify) — gagal **diam-diam**, jadi wajib uji dengan request sungguhan.

---

## MODUL 4 — Frontend, Containerization & Capstone

### m4.1 Frontend Auth Flow & Uniform Error
- **Tujuan:** integrasi React lewat gateway (BFF).
- **Yang dibangun:** login/register, token di **memory** (bukan localStorage), API client yang menormalkan error.
- **Acceptance:** component test alur login; login lewat gateway berhasil.
- **Cara Debugging:** CORS error → origin frontend (`localhost:3000`/`5173`) harus terdaftar di CORS gateway. Token "hilang" setelah refresh → **memang disengaja** (memory, demi keamanan). `VITE_API_BASE_URL` di-**bake saat build**, bukan runtime.

### m4.2 Live Service-Health Widget
- **Tujuan:** visualisasi status real-time.
- **Yang dibangun:** widget polling `/health` tiap 3 detik, indikator warna brand (success/danger).
- **Acceptance:** widget berubah saat satu service dimatikan.
- **Cara Debugging:** widget tak update → cek interval polling jalan; uji `/health` gateway berubah saat service dimatikan (curl dulu sebelum curiga ke widget).

### m4.3 Containerization
- **Tujuan:** image per service, aman & ramping.
- **Yang dibangun:** Dockerfile multi-stage, non-root, `.dockerignore`; frontend → **nginx** (bukan Node) dengan SPA fallback.
- **Acceptance:** build dari **context root repo**; container non-root; refresh route SPA tidak 404; frontend disajikan nginx.
- **Cara Debugging:** "module not found" saat build → context harus root repo (bukan folder service). **bcrypt native binding error di runtime** → jangan compile di glibc lalu jalankan di Alpine/musl; di sini **semua stage Alpine** + toolchain di stage build (lihat `DECISIONS.md`). `EACCES` menulis keypair → `chown` folder `keys/` ke user `node` sebelum `USER node`. Refresh 404 → `try_files ... /index.html` di `nginx.conf`.

### m4.4 Docker Compose Orchestration
- **Tujuan:** orkestrasi tanpa race condition.
- **Yang dibangun:** `docker-compose.yml`, network internal, volume keypair, `depends_on: condition: service_healthy`, healthcheck `node -e "fetch(...)"`.
- **Acceptance:** `docker compose up` dari clone bersih jalan tanpa race (uji beberapa kali); backend tidak bisa diakses dari host; restart auth **tidak** menginvalidasi token (volume keypair).
- **Cara Debugging:** service gagal connect padahal `up` → pakai `condition: service_healthy`, bukan `depends_on` polos. Frontend tak bisa panggil API → `VITE_API_BASE_URL` di-set **saat build** (build arg) & tetap `localhost:8080` (URL yang diakses browser, bukan `gateway:8080`).

### m4.5 Capstone: Chaos, Checklist, README
- **Tujuan:** membuktikan resilience end-to-end & memetakan jalan ke production.
- **Yang dibangun:** prosedur chaos (`stop`→amati→`start`→amati), `docs/PRODUCTION-CHECKLIST.md` (5 item), README final.
- **Acceptance:** chaos test benar-benar berjalan (bukan diklaim); checklist mencakup 5 item; README lengkap untuk `docker compose up`.
- **Cara Debugging:** breaker tak pulih → `resetTimeoutMs` cukup pendek untuk didemokan; beri jeda cukup antara `stop`→amati→`start`→amati.
