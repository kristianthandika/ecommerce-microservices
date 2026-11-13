# E-Commerce Microservices — Node.js / Express / Fastify / React

> **Materi fitur tambahan:** tersedia [paket pembelajaran modular](docs/materi-lanjutan/README.md) untuk hardening, keranjang, checkout, riwayat pesanan, dashboard admin, serta header/footer. Paket mencakup modul peserta, praktikum, referensi API, panduan instruktur, dan panduan integrasi ke materi Word/PDF lama. Jalankan `node scripts/build-training-materials.mjs` untuk menyusun berkas Markdown gabungan pada folder materi workspace.

Sistem referensi **microservice** sekaligus **starter kit pelatihan** untuk
Inixindo Bandung ("Implementasi Arsitektur Microservice dengan Node.js &
React", 4 hari). Seluruh sistem berjalan lewat **satu perintah**
`docker compose up`.

> **Seluruh project ditulis dalam TypeScript.** Shared package dikompilasi
> (`tsc`), service dijalankan langsung sebagai `.ts` via type stripping bawaan
> Node 24, frontend lewat Vite. Lihat `DECISIONS.md`.

## Arsitektur

```
Browser ──▶ Frontend (React/nginx :3000)
Browser ──▶ Gateway (Fastify :8080)  ── satu-satunya pintu masuk API publik
                 │
     ┌───────────┼─────────────┐
     ▼           ▼             ▼
 auth-service  product-service  order-service   (Express, SQLite per service, internal)
  (:3001)        (:3002)          (:3003)
     ▲             ▲                │
     │ JWKS (cache)│                │ resilient HTTP (timeout/retry/breaker)
     └─────────────┴────────────────┘
```

- **gateway** (Fastify) — Backend-for-Frontend: reverse proxy, rate-limit +
  security header terpusat, correlation ID, aggregated health, tracing pengantar.
- **auth-service** (Express) — register/login, JWT **RS256**, endpoint **JWKS**.
- **product-service** (Express) — katalog + RBAC; verifikasi JWT via `jwks-rsa`
  (cache, tanpa memanggil auth-service tiap request).
- **order-service** (Express) — order; memanggil product-service lewat
  **resilient HTTP client** (timeout, retry+jitter, circuit breaker) buatan sendiri.
- **frontend** (React + Vite + Tailwind) — brand Inixindo Bandung, auth flow,
  live health widget.

Detail desain & anti-pattern: [`docs/BOUNDARY.md`](docs/BOUNDARY.md).

## Prasyarat

- **Docker Desktop** (untuk `docker compose up`).
- Untuk pengembangan lokal tanpa Docker: **Node.js 24 LTS** + npm.

## Menjalankan (Docker — cara utama)

```bash
node scripts/setup.mjs --demo-admin
docker compose up --build -d --wait
```

Lalu buka:

| URL                          | Keterangan           |
| ---------------------------- | -------------------- |
| http://localhost:3000        | Dashboard (frontend) |
| http://localhost:8080        | API Gateway          |
| http://localhost:8080/health | Aggregated health    |

Admin hanya dibuat jika diaktifkan secara eksplisit. Perintah setup di atas menghasilkan password acak dalam `.env` (email `admin@inixindo.local`). Form login tidak berisi kredensial bawaan. Jangan bagikan `.env`.

Menghentikan: `docker compose down` (tambah `-v` untuk hapus volume keypair).

> Hanya gateway (8080) & frontend (3000) yang diekspos ke host. auth/product/
> order hanya bisa diakses lewat network internal Docker.

## Pengembangan lokal (tanpa Docker, Hari 1–3)

```bash
npm install
npm run build:packages     # kompilasi shared package (logger, resilient-http-client)
npm run dev:all            # jalankan 4 service sekaligus (concurrently)
# frontend terpisah:
npm run dev --workspace=frontend
```

URL antar-service default `localhost` (lihat `.env.example`). Docker Compose
meng-override ke hostname internal Docker.

## Testing, typecheck, lint

```bash
npm test          # semua workspace (Vitest) — tes unit, regresi, dan integrasi
npm run typecheck # tsc --noEmit semua workspace
npm run lint      # eslint (typescript-eslint)
```

## Alur Pelatihan (branch starter/solution)

Selain kode lengkap di `main`, repo ini menyediakan **16 fitur** (`mX.Y`)
sebagai **pasangan branch** untuk praktikum langsung. Tiap fitur punya:

- **`starter/mX.Y-…`** — kondisi SEBELUM fitur + `EXERCISE.md` (tujuan, yang
  perlu dibangun, acceptance, dan **jebakan debugging spesifik** fitur itu).
  Implementasi fitur belum ada — inilah titik mulai peserta.
- **`solution/mX.Y-…`** — kondisi SESUDAH: implementasi lengkap + test lulus.

Solution satu fitur menjadi starter fitur berikutnya, jadi seluruhnya membentuk
rantai berurutan. `solution/m4.5` = isi `main`.

### Cara memakai di kelas

```bash
# 1. Mulai dari starter fitur yang sedang dipelajari
git checkout starter/m2.2-resilient-http-client
cat EXERCISE.md                 # baca tujuan + acceptance + cara debugging

# 2. Peserta mengimplementasikan fitur...
npm run build:packages          # bila fitur menyentuh shared package
npm test                        # jalankan test terkait

# 3. Bandingkan / lihat kunci jawaban
git diff solution/m2.2-resilient-http-client     # apa yang seharusnya berubah
git checkout solution/m2.2-resilient-http-client # solusi lengkap + test
```

`npm install` cukup **sekali** untuk semua branch (dependency root konstan).
Karena service dijalankan sebagai `.ts` dan shared package dikompilasi, jalankan
`npm run build:packages` setiap berada di branch yang sudah memuat
`packages/*` sebelum menjalankan service/test service.

### Peta fitur → branch

| Modul | Fitur (slug branch)             | Fokus                                              |
| ----- | ------------------------------- | -------------------------------------------------- |
| 0     | `m0.1-monorepo-bootstrap`       | npm workspaces, toolchain TS                       |
| 0     | `m0.2-brand-shared-infra`       | `packages/logger`, brand frontend                  |
| 1     | `m1.1-service-boundary`         | DDD ringan, `docs/BOUNDARY.md`                     |
| 1     | `m1.2-auth-bootstrap`           | Express 5, security middleware, error handler, zod |
| 1     | `m1.3-auth-jwt-jwks`            | bcrypt, JWT RS256, JWKS, `kid`                     |
| 2     | `m2.1-product-distributed-auth` | verifikasi JWT via `jwks-rsa` (cache), RBAC        |
| 2     | `m2.2-resilient-http-client`    | timeout/retry/circuit breaker manual               |
| 2     | `m2.3-order-chaos`              | order-service + chaos test                         |
| 3     | `m3.1-api-gateway`              | Fastify proxy, rate-limit, X-Forwarded-For         |
| 3     | `m3.2-correlation-id`           | correlation ID lintas service                      |
| 3     | `m3.3-health-tracing-loadtest`  | health agregat, `@fastify/otel`, autocannon        |
| 4     | `m4.1-frontend-auth`            | React auth flow, error seragam                     |
| 4     | `m4.2-health-widget`            | live service-health widget                         |
| 4     | `m4.3-containerization`         | Dockerfile multi-stage, non-root, nginx            |
| 4     | `m4.4-docker-compose`           | orkestrasi, healthcheck-gated                      |
| 4     | `m4.5-capstone`                 | chaos, production checklist, README                |

Rincian tiap fitur + jebakan debugging ada sebagai satu file `.md` per fitur di
[`docs/exercises/`](docs/exercises/) (akumulatif di tiap branch). Untuk membuka
starter & solution sebuah fitur berdampingan:

```bash
bash scripts/dev/worktrees.sh m2.2      # buat worktree starter & solution
bash scripts/dev/worktrees.sh --list    # daftar fitur
bash scripts/dev/worktrees.sh --clean   # bersihkan
```

## Chaos test (capstone)

Buktikan resilience & pemulihan otomatis saat satu service tumbang:

```bash
docker compose stop product-service     # order → 503 graceful, health → degraded
docker compose start product-service    # circuit breaker menutup, order sukses lagi
```

Amati juga **health widget** di dashboard berubah merah→hijau, dan `/health`
gateway berpindah `degraded`→`ok`.

## Load test

```bash
npm run loadtest   # autocannon ke gateway; ringkasan disimpan ke services/gateway/loadtest-*.txt
```

Catatan: rate-limit gateway (100/menit/IP) akan menolak sebagian besar request
di beban tinggi — itu **fitur** (proteksi), terlihat sebagai respons non-2xx.

## Struktur

```
packages/       logger, resilient-http-client (library, dikompilasi ke dist)
services/       auth-service, product-service, order-service, gateway
frontend/       React + Vite + Tailwind (build → nginx)
docs/           BOUNDARY.md, PRODUCTION-CHECKLIST.md, exercises/ (per fitur)
scripts/dev/    worktrees.sh (buka starter & solution berdampingan)
```

## Docker Compose vs Kubernetes (ringkas)

| Aspek             | Docker Compose          | Kubernetes                        |
| ----------------- | ----------------------- | --------------------------------- |
| Cakupan           | Satu host, dev/demo     | Cluster multi-node, production    |
| Scaling           | Manual (`--scale`)      | Otomatis (HPA), self-healing      |
| Service discovery | DNS internal Compose    | Service/DNS + Ingress             |
| Health & restart  | healthcheck + `restart` | liveness/readiness probe, rollout |
| Config/secret     | `.env`, volume          | ConfigMap, Secret, RBAC           |
| Kapan             | belajar, lokal, CI      | skala besar, HA, rilis progresif  |

Prototype ini pakai Compose karena paling pas untuk pelatihan; konsep yang
dipelajari (boundary, health, resilience, observability) langsung terbawa ke
Kubernetes. Langkah menuju production: [`docs/PRODUCTION-CHECKLIST.md`](docs/PRODUCTION-CHECKLIST.md).

## Catatan penting

- **Penyimpanan SQLite per service** dengan volume Docker persisten; tes memakai database memory terisolasi. Lihat `docs/HARDENING.md`.

- Keputusan teknis & trade-off: [`DECISIONS.md`](DECISIONS.md).
- Latihan per-fitur & jebakan debugging: [`docs/exercises/`](docs/exercises/) (satu file per fitur).

## Perubahan setelah audit

Order sekarang mewajibkan header `Idempotency-Key` (8-128 karakter alfanumerik, `_`, atau `-`). Harga berupa integer rupiah. ID produk wajib UUID. Stok dikurangi secara atomik melalui endpoint reservasi internal yang diautentikasi. Order terputus disimpan sebagai `PENDING` dan dipulihkan otomatis. Frontend menggunakan API same-origin `/api`.

```bash
npm run build:packages
npm test
npm run typecheck
npm run lint
node scripts/e2e.mjs --chaos   # stack Docker harus healthy; menghentikan/restart service proyek ini
```

Rincian perbaikan, backup, secret file, TLS opsional, dan batas deployment: [`docs/HARDENING.md`](docs/HARDENING.md). Materi latihan dan branch lama menggambarkan prototype sebelum hardening.

## Paket fitur belanja dan admin

- **Katalog**: pencarian produk, pagination, dan tambah ke keranjang.
- **Keranjang**: tersimpan per pengguna, ubah jumlah, hapus item, serta pemeriksaan stok/harga.
- **Checkout**: alamat penerima dan konfirmasi pesanan dengan idempotensi serta reservasi stok atomik.
- **Pesanan saya**: riwayat, filter status, detail item/alamat, dan pembaruan status pending.
- **Dashboard admin**: ringkasan stok/pesanan, CRUD produk, pencarian pesanan, serta proses `Baru -> Diproses -> Selesai`.

Akses dari navigasi setelah login pada `http://localhost:3000`. Menu admin hanya tersedia untuk akun admin. Pembayaran online dan ongkir belum tersedia; total adalah total produk. Panduan lengkap dan kontrak API: [docs/SHOPPING-FEATURES.md](docs/SHOPPING-FEATURES.md).

```bash
node scripts/e2e-shopping.mjs --chaos
```

## Keamanan API (OWASP)

Sesi memakai access token 15 menit plus refresh token berotasi di cookie HttpOnly; login diperlambat per akun setelah lima kegagalan. Mutasi keranjang memakai `If-Match`/`ETag`. Pesanan dapat dibatalkan dan stoknya dikembalikan tepat sekali. Pemetaan setiap risiko OWASP API Security Top 10 (2023) ke kode dan tes ada di [`docs/OWASP-API-SECURITY.md`](docs/OWASP-API-SECURITY.md); latihan kelasnya di [M11](docs/materi-lanjutan/07-keamanan-api-owasp.md).
