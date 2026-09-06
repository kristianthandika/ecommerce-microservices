# PROGRESS.md

Status 16 fitur (mX.Y). Sistem lengkap berjalan lewat `docker compose up`.

| Fitur | Judul | Status |
|---|---|---|
| m0.1 | Monorepo Bootstrap | ✅ |
| m0.2 | Brand & Shared Infrastructure | ✅ |
| m1.1 | Service Boundary Design | ✅ |
| m1.2 | auth-service Bootstrap & Security Middleware | ✅ |
| m1.3 | Register/Login, JWT RS256, JWKS | ✅ |
| m2.1 | product-service & Distributed Auth | ✅ |
| m2.2 | Resilient HTTP Client | ✅ |
| m2.3 | order-service dengan Chaos Test | ✅ |
| m3.1 | API Gateway | ✅ |
| m3.2 | Correlation ID | ✅ |
| m3.3 | Health Check, Tracing, Load Test | ✅ |
| m4.1 | Frontend Auth Flow | ✅ |
| m4.2 | Live Health Widget | ✅ |
| m4.3 | Containerization | ✅ |
| m4.4 | Docker Compose | ✅ |
| m4.5 | Capstone | ✅ |

## Diverifikasi berjalan (Docker)

- `docker compose up` → 5 container, startup ter-gate healthcheck (auth→product→order→gateway→frontend).
- `/health` gateway = ok; hanya gateway (8080) & frontend (3000) terekspos ke host; backend tidak terjangkau dari host.
- E2E lewat gateway: login → katalog → buat order (201).
- Correlation ID sama di log gateway+order+product (satu request tertelusur).
- Chaos: stop product → order 503 graceful + health degraded → start product → pulih.
- Restart auth-service → token lama tetap valid (volume keypair persist).
- 33 test hijau, typecheck & lint bersih di semua workspace.

## Catatan penyimpangan dari spesifikasi

- Seluruh sistem dibangun di `main` dengan **satu commit per modul**, BUKAN
  16 pasang branch `starter/`+`solution/`. Prioritas permintaan adalah aplikasi
  yang benar-benar berjalan via Docker + best practice + TypeScript. Konten
  latihan & jebakan debugging per fitur tetap disediakan di `docs/EXERCISES.md`
  (setara isi `EXERCISE.md` per branch). Pembuatan branch berpasangan bisa
  ditambahkan sebagai langkah lanjutan bila dibutuhkan.
- Seluruh project pindah ke **TypeScript** (permintaan eksplisit di tengah jalan).
