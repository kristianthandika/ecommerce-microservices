# Latihan per Fitur (Starter/Solution)

> **Tambahan setelah prototype:** [paket materi lanjutan](../materi-lanjutan/README.md) menyediakan latihan L0–L9 untuk source terkini, termasuk hardening, cart/checkout, history/admin, dan header/footer. Fitur lanjutan m12.x di bagian bawah halaman ini memiliki pasangan branch starter/solution sendiri.

Satu file `.md` per fitur (`mX.Y`). Tiap file berisi: tujuan, yang perlu
dibangun, acceptance, dan **jebakan debugging spesifik** fitur itu.

Untuk tiap fitur ada sepasang branch:

- `starter/mX.Y-…` — kondisi SEBELUM + file latihan ini (implementasi belum ada).
- `solution/mX.Y-…` — kondisi SESUDAH (implementasi lengkap + test lulus).

Di branch mana pun, `docs/exercises/` berisi file untuk seluruh fitur **sampai
titik itu** (akumulatif), jadi `ls docs/exercises/` menunjukkan latihan yang
sudah tersedia. Solution satu fitur menjadi starter fitur berikutnya.

Buka starter & solution berdampingan dengan helper:

```bash
bash scripts/dev/worktrees.sh m2.2      # buat 2 worktree: starter & solution
bash scripts/dev/worktrees.sh --list    # daftar fitur
bash scripts/dev/worktrees.sh --clean   # bersihkan semua worktree
```

## Daftar fitur

| Modul | Fitur                                                                         |
| ----- | ----------------------------------------------------------------------------- |
| 0     | [m0.1 — Monorepo Bootstrap](m0.1-monorepo-bootstrap.md)                       |
| 0     | [m0.2 — Brand & Shared Infrastructure](m0.2-brand-shared-infra.md)            |
| 1     | [m1.1 — Service Boundary Design](m1.1-service-boundary.md)                    |
| 1     | [m1.2 — auth-service Bootstrap & Security](m1.2-auth-bootstrap.md)            |
| 1     | [m1.3 — Register/Login, JWT RS256, JWKS](m1.3-auth-jwt-jwks.md)               |
| 2     | [m2.1 — product-service & Distributed Auth](m2.1-product-distributed-auth.md) |
| 2     | [m2.2 — Resilient HTTP Client](m2.2-resilient-http-client.md)                 |
| 2     | [m2.3 — order-service dengan Chaos Test](m2.3-order-chaos.md)                 |
| 3     | [m3.1 — API Gateway](m3.1-api-gateway.md)                                     |
| 3     | [m3.2 — Correlation ID](m3.2-correlation-id.md)                               |
| 3     | [m3.3 — Health, Tracing, Load Test](m3.3-health-tracing-loadtest.md)          |
| 4     | [m4.1 — Frontend Auth Flow](m4.1-frontend-auth.md)                            |
| 4     | [m4.2 — Live Health Widget](m4.2-health-widget.md)                            |
| 4     | [m4.3 — Containerization](m4.3-containerization.md)                           |
| 4     | [m4.4 — Docker Compose](m4.4-docker-compose.md)                               |
| 4     | [m4.5 — Capstone](m4.5-capstone.md)                                           |

## Fitur lanjutan (m12.x)

Fitur berikut dibangun di atas kode final (`feature/materi-lanjutan`). Berbeda dari rantai M0–M4, **setiap pasangan bercabang dari titik yang sama**: `starter/m12.x` adalah kode final dengan satu fitur dicabut, dan `solution/m12.x` mengembalikannya. Urutan pengerjaan bebas, dan `git diff starter/m12.x solution/m12.x` hanya berisi implementasi fitur itu.

| Modul | Fitur                                                                       |
| ----- | --------------------------------------------------------------------------- |
| 12    | [m12.1 — Konkurensi keranjang dengan If-Match/ETag](m12.1-cart-if-match.md) |
| 12    | [m12.2 — Pembatalan order sebagai saga](m12.2-cancel-saga.md)               |
| 12    | [m12.3 — Refresh token berotasi](m12.3-refresh-session.md)                  |
| 12    | [m12.4 — Order ke tabel relasional](m12.4-relational-orders.md)             |
| 12    | [m12.5 — Batas tahan stok per pelanggan (API6)](m12.5-hold-limit.md)        |
| 12    | [m12.6 — OpenAPI dan versi API (API9)](m12.6-openapi-versioning.md)         |
