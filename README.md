# E-Commerce Microservices — Node.js / Express / Fastify / React

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
 auth-service  product-service  order-service   (Express, in-memory, internal)
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
docker compose up --build
```

Lalu buka:

| URL | Keterangan |
|---|---|
| http://localhost:3000 | Dashboard (frontend) |
| http://localhost:8080 | API Gateway |
| http://localhost:8080/health | Aggregated health |

Login demo (di-seed otomatis, **ganti di production**): `admin@inixindo.local` / `admin123`.

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
npm test          # semua workspace (Vitest) — 33 test
npm run typecheck # tsc --noEmit semua workspace
npm run lint      # eslint (typescript-eslint)
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
docs/           BOUNDARY.md, PRODUCTION-CHECKLIST.md, EXERCISES.md
```

## Docker Compose vs Kubernetes (ringkas)

| Aspek | Docker Compose | Kubernetes |
|---|---|---|
| Cakupan | Satu host, dev/demo | Cluster multi-node, production |
| Scaling | Manual (`--scale`) | Otomatis (HPA), self-healing |
| Service discovery | DNS internal Compose | Service/DNS + Ingress |
| Health & restart | healthcheck + `restart` | liveness/readiness probe, rollout |
| Config/secret | `.env`, volume | ConfigMap, Secret, RBAC |
| Kapan | belajar, lokal, CI | skala besar, HA, rilis progresif |

Prototype ini pakai Compose karena paling pas untuk pelatihan; konsep yang
dipelajari (boundary, health, resilience, observability) langsung terbawa ke
Kubernetes. Langkah menuju production: [`docs/PRODUCTION-CHECKLIST.md`](docs/PRODUCTION-CHECKLIST.md).

## Catatan penting

- **Penyimpanan in-memory** (bukan database) — simplifikasi disengaja untuk
  scope training; lihat `docs/PRODUCTION-CHECKLIST.md`.
- Keputusan teknis & trade-off: [`DECISIONS.md`](DECISIONS.md).
- Latihan per-fitur & jebakan debugging: [`docs/EXERCISES.md`](docs/EXERCISES.md).
