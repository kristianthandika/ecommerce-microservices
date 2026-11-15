# Lab Praktikum: E-Commerce Microservices

Folder ini berisi panduan langkah demi langkah untuk membangun sistem e-commerce
microservice dari repo kosong sampai versi lengkap yang ada di branch `main`.
Setiap lab adalah satu fitur. Lab disusun berurutan dan **saling menyambung**:
hasil akhir satu lab menjadi titik awal lab berikutnya.

**Baru pertama kali?** Baca dulu [Panduan Pemula](00-panduan-pemula.md). Panduan
itu menjelaskan alat yang perlu dipasang, cara berpindah branch, cara menjalankan
tes, dan apa yang harus dilakukan bila terjadi error.

## Cara kerja branch

Setiap lab punya dua branch:

| Branch           | Isinya                                                       | Dipakai untuk   |
| ---------------- | ------------------------------------------------------------ | --------------- |
| `starter/<lab>`  | Kode **sebelum** fitur dibuat, ditambah panduan lab ini      | Titik awal Anda |
| `solution/<lab>` | Kode **sesudah** fitur dibuat, lengkap dengan tes yang lulus | Kunci jawaban   |

Semua branch membentuk **satu garis lurus**:

```
starter/m0.1 → solution/m0.1 → starter/m0.2 → solution/m0.2 → … → solution/m4.5
  → bridge/m5-m11-materi-lanjutan
  → starter/m12.1 → solution/m12.1 → … → solution/m12.12  (isinya sama dengan main)
```

- `starter/<lab berikutnya>` = `solution/<lab sebelumnya>` + panduan lab berikutnya.
  Jadi setelah menyelesaikan satu lab, Anda bisa langsung pindah ke starter lab
  berikutnya tanpa kehilangan apa pun.
- **Modul 0–4** membangun sistem dari nol. Di starter, kode fitur itu belum ada sama
  sekali; Anda menulisnya sendiri.
- **Jembatan M5–M11** membawa Anda ke kode lengkap yang dipakai
  materi lanjutan (`docs/materi-lanjutan/`, tersedia mulai branch jembatan): SQLite, keranjang,
  checkout, riwayat, admin, dan hardening. Modul M5–M11 berupa studi kode dan
  praktikum terhadap sistem yang berjalan, bukan menulis fitur dari nol.
- **Modul 12** memakai kode lengkap itu. Di setiap starter, **satu fitur dicabut** dan
  diganti tanda `TODO m12.x`. Tes fitur itu gagal; tugas Anda membuatnya lulus lagi
  tanpa merusak tes lain.

Perintah singkat untuk membuka starter dan solution berdampingan:

```bash
bash scripts/dev/worktrees.sh m2.2      # dua folder: starter & solution m2.2
bash scripts/dev/worktrees.sh --list    # daftar lab
bash scripts/dev/worktrees.sh --clean   # hapus folder-folder tadi
```

(`scripts/dev/worktrees.sh` baru ada mulai `solution/m4.5-capstone`. Sebelum itu, pakai
`git diff` seperti dijelaskan di Panduan Pemula.)

## Kebiasaan yang membuat lab lancar

1. Mulai setiap lab dengan `git switch starter/<lab>` lalu `npm ci`.
2. Jalankan tes **sebelum** mengubah apa pun, supaya Anda tahu kondisi awalnya.
3. Simpan pekerjaan Anda di branch sendiri (`git switch -c latihan/<lab>`), bukan di
   branch starter.
4. Ubah sedikit, jalankan tes, ulangi. Jangan menulis semuanya dulu baru menguji.
5. Baru buka solution setelah benar-benar mencoba. Bandingkan dengan
   `git diff starter/<lab> solution/<lab>`.

## Daftar lab

Lab yang namanya belum bertaut panduannya muncul ketika Anda pindah ke branch starter-nya (15 lab lagi).

| Modul | Lab                                                                           | Branch awal                             |
| ----- | ----------------------------------------------------------------------------- | --------------------------------------- |
| 0     | [m0.1 — Monorepo bootstrap](m0.1-monorepo-bootstrap.md)                       | `starter/m0.1-monorepo-bootstrap`       |
| 0     | [m0.2 — Brand & shared infrastructure](m0.2-brand-shared-infra.md)            | `starter/m0.2-brand-shared-infra`       |
| 1     | [m1.1 — Desain batas layanan](m1.1-service-boundary.md)                       | `starter/m1.1-service-boundary`         |
| 1     | [m1.2 — Bootstrap auth-service & middleware keamanan](m1.2-auth-bootstrap.md) | `starter/m1.2-auth-bootstrap`           |
| 1     | [m1.3 — Register/login, JWT RS256, JWKS](m1.3-auth-jwt-jwks.md)               | `starter/m1.3-auth-jwt-jwks`            |
| 2     | [m2.1 — product-service & distributed auth](m2.1-product-distributed-auth.md) | `starter/m2.1-product-distributed-auth` |
| 2     | [m2.2 — Resilient HTTP client](m2.2-resilient-http-client.md)                 | `starter/m2.2-resilient-http-client`    |
| 2     | [m2.3 — order-service dengan chaos test](m2.3-order-chaos.md)                 | `starter/m2.3-order-chaos`              |
| 3     | [m3.1 — API gateway (Fastify)](m3.1-api-gateway.md)                           | `starter/m3.1-api-gateway`              |
| 3     | [m3.2 — Correlation ID](m3.2-correlation-id.md)                               | `starter/m3.2-correlation-id`           |
| 3     | [m3.3 — Health agregat, tracing, load test](m3.3-health-tracing-loadtest.md)  | `starter/m3.3-health-tracing-loadtest`  |
| 4     | [m4.1 — Alur login frontend](m4.1-frontend-auth.md)                           | `starter/m4.1-frontend-auth`            |
| 4     | [m4.2 — Widget health](m4.2-health-widget.md)                                 | `starter/m4.2-health-widget`            |
| 4     | [m4.3 — Containerization](m4.3-containerization.md)                           | `starter/m4.3-containerization`         |
| 4     | m4.4 — Docker Compose                                                         | `starter/m4.4-docker-compose`           |
| 4     | m4.5 — Capstone                                                               | `starter/m4.5-capstone`                 |
| 5–11  | m5-m11 — Jembatan ke materi lanjutan (M5–M11)                                 | `bridge/m5-m11-materi-lanjutan`         |
| 12    | m12.1 — Konkurensi keranjang dengan If-Match/ETag                             | `starter/m12.1-cart-if-match`           |
| 12    | m12.2 — Pembatalan order sebagai saga                                         | `starter/m12.2-cancel-saga`             |
| 12    | m12.3 — Refresh token berotasi                                                | `starter/m12.3-refresh-session`         |
| 12    | m12.4 — Order ke tabel relasional                                             | `starter/m12.4-relational-orders`       |
| 12    | m12.5 — Batas tahan stok per pelanggan (API6)                                 | `starter/m12.5-hold-limit`              |
| 12    | m12.6 — OpenAPI dan versi API (API9)                                          | `starter/m12.6-openapi-versioning`      |
| 12    | m12.7 — Pencabutan sesi lintas service                                        | `starter/m12.7-session-revocation`      |
| 12    | m12.8 — Pendaftaran tanpa enumerasi akun (API2)                               | `starter/m12.8-register-no-enumeration` |
| 12    | m12.9 — Verifikasi email dengan password                                      | `starter/m12.9-verify-with-password`    |
| 12    | m12.10 — Lupa password                                                        | `starter/m12.10-password-reset`         |
| 12    | m12.11 — Device cookie anti-lockout                                           | `starter/m12.11-device-cookie`          |
| 12    | m12.12 — Hardening gateway                                                    | `starter/m12.12-gateway-hardening`      |
