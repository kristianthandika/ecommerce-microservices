# Production Checklist — Dari Prototype Menuju Production

Prototype 4 hari ini **berjalan penuh** (5 container lewat `docker compose up`)
tapi **sengaja** menyederhanakan beberapa hal supaya fokus ke konsep
microservice. Dokumen ini mencatat kelima item dari silabus yang WAJIB
ditangani sebelum sistem seperti ini layak production, dan kenapa belum ada di
prototype.

> Ini bukan daftar kelalaian — ini peta jalan sadar. Prototype ini dibangun
> untuk mengajarkan boundary, resilience, dan observability, bukan untuk
> menyimpan data pelanggan sungguhan.

## 1. Database per Service (persisten)

**Sekarang:** tiap service memakai **in-memory store** (`Map`). Data hilang saat
container restart (mis. user & produk yang dibuat saat demo).

**Untuk production:** tiap service punya database sendiri (mis. auth →
PostgreSQL, product → PostgreSQL, order → PostgreSQL/terpisah). Prinsip
**database per service** dipertahankan (tidak ada shared database — lihat
`BOUNDARY.md`). Tambahkan migration, connection pool, backup, dan indeks.

## 2. Secret Management

**Sekarang:** kredensial admin demo & konfigurasi lewat environment variable
biasa; RSA keypair disimpan di Docker volume. Cukup untuk lokal, TIDAK untuk
production.

**Untuk production:** simpan secret di secret manager (HashiCorp Vault, AWS
Secrets Manager, Docker/Kubernetes Secrets), rotasi berkala, jangan pernah
commit ke repo, dan jangan seed admin dengan password default. Keypair RS256
dikelola & dirotasi lewat KMS.

## 3. Message Queue (komunikasi asynchronous)

**Sekarang:** order→product **sinkron** lewat HTTP (dengan resilience). Cukup
untuk validasi harga/stok satu langkah.

**Untuk production:** alur multi-langkah lintas service (mis. buat order →
kurangi stok → pembayaran → notifikasi) lebih baik **asynchronous** lewat
message queue (RabbitMQ/Kafka/NATS) dengan **Saga pattern** + compensating
action. Meng-decouple service, menyerap lonjakan beban, dan menghindari
cascading failure. (Lihat pengantar Saga di `BOUNDARY.md`.)

## 4. Distributed Tracing Penuh

**Sekarang:** tracing **pengantar** — `@fastify/otel` + **ConsoleSpanExporter**
di gateway saja (span tercetak ke stdout). Cukup untuk memahami konsepnya.

**Untuk production:** ekspor span ke backend tracing (Jaeger/Tempo/Zipkin/
vendor OTLP), instrumentasikan **semua** service (bukan cuma gateway),
propagasikan trace context (W3C `traceparent`) lintas HTTP, dan korelasikan
dengan log & metrics (tiga pilar observability).

## 5. CI/CD per Service

**Sekarang:** build manual lewat `docker compose build`. Test dijalankan
manual (`npm test`).

**Untuk production:** pipeline CI/CD **per service** — tiap service di-lint,
di-typecheck, di-test, di-build image, di-scan (SCA/secret), lalu di-deploy
independen (blue-green/canary). Inilah janji microservice: deploy satu service
tanpa menyentuh yang lain.

---

## Catatan keamanan tambahan yang sudah diterapkan di prototype

Sebagian praktik keamanan dasar SUDAH ada (sesuai silabus Hari 4):

- Container **non-root** (`USER node`), multi-stage build, base image minimal (Alpine).
- Hanya **gateway** & **frontend** yang expose port; service lain hanya di network internal Docker.
- **helmet** (security header) + **rate limiting** terpusat di gateway, plus lapisan per-service.
- **X-Forwarded-For** ditulis gateway (anti-spoof), `trust proxy` dibatasi di service.
- JWT **RS256** + JWKS (verifikasi terdistribusi tanpa membagikan private key).
- Password di-hash **bcrypt**; secret tidak di-log (redaction di logger).
