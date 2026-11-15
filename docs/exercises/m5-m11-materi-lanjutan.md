# Jembatan M5–M11 — Dari Prototype ke Sistem Belanja Utuh

| Branch                          | Waktu                       | Sebelumnya | Berikutnya |
| ------------------------------- | --------------------------- | ---------- | ---------- |
| `bridge/m5-m11-materi-lanjutan` | 2 hari (12 jam) + M11 2 jam | m4.5       | m12.1      |

Branch ini **bukan** pasangan starter/solution. Isinya kode lengkap yang dipakai
materi lanjutan M5–M11, sama persis dengan kode yang menjadi dasar lab modul 12.
Modul M5–M11 dikerjakan dengan **membaca, menjalankan, dan menguji** sistem ini,
bukan menulis fitur dari nol.

## Apa yang berubah sejak m4.5

Lompatan dari capstone ke branch ini besar (sekitar 200 berkas). Tabel ini membantu
Anda tahu harus mencari di mana:

| Area                 | Di m4.5                 | Di branch ini                                                                                     | Dibahas di        |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------- | ----------------- |
| Penyimpanan          | `Map` di memory         | SQLite per service (`packages/storage`), migrasi skema, backup online                             | M5, m12.4         |
| Pesanan              | langsung `CONFIRMED`    | reservasi stok atomik, `Idempotency-Key`, recovery `PENDING`, pembatalan dengan kompensasi        | M5, M7, m12.2     |
| Belanja              | tidak ada               | keranjang persisten, checkout dengan alamat, riwayat & detail pesanan, dashboard admin            | M6–M8             |
| Konkurensi           | -                       | `If-Match`/`ETag` di keranjang, revisi produk                                                     | M6, m12.1         |
| Sesi                 | JWT 1 jam di memory     | access token 15 menit + refresh token berotasi di cookie HttpOnly, pencabutan sesi lintas service | m12.3, m12.7      |
| Akun                 | register langsung aktif | verifikasi email (tautan + password), tanpa enumerasi akun, lupa password, device cookie          | M11, m12.8–m12.11 |
| Batas penyalahgunaan | rate limit              | + backoff login per akun, batas tahan stok per pelanggan, kuota email                             | M11, m12.5        |
| API                  | tanpa versi             | `/api/v1`, spesifikasi OpenAPI 3.1 yang dibangkitkan dari skema                                   | m12.6             |
| Gateway              | proxy + health          | + penjaga route internal, batas waktu, kebijakan header di tepi                                   | m12.12            |
| Frontend             | login + dashboard       | toko lengkap, admin, kotak surat pelatihan, header/footer responsif                               | M8, M9            |
| Docker               | 5 container             | + root filesystem read-only, jaringan internal, overlay TLS dan email                             | M5, M10           |
| Pengujian            | 35 tes                  | 219 tes + E2E (`scripts/e2e*.mjs`) termasuk chaos                                                 | M10               |

Untuk melihat perbedaannya sendiri:

```bash
git diff --stat solution/m4.5-capstone bridge/m5-m11-materi-lanjutan | tail -1
git diff solution/m4.5-capstone bridge/m5-m11-materi-lanjutan -- services/order-service/src/orders.ts
```

## Menjalankan sistem

```bash
git switch bridge/m5-m11-materi-lanjutan
npm ci && npm run build:packages
npm run typecheck && npm test          # 219 tes
```

Dengan Docker (cara yang dipakai praktikum):

```bash
node scripts/setup.mjs --demo-admin    # membuat .env berisi token dan password admin acak
docker compose up --build -d --wait
```

Perbedaan penting dari m4.4:

- Password admin demo **tidak lagi** `admin123`. Lihat nilai `SEED_ADMIN_EMAIL` dan
  `SEED_ADMIN_PASSWORD` di berkas `.env` yang baru dibuat. Jangan menyalin nilainya
  ke laporan.
- API diakses lewat frontend di `http://localhost:3000/api/v1/...`. Port 8080 hanya
  terbuka untuk `127.0.0.1`.
- Data kini disimpan di volume (`auth-data`, `product-data`, `order-data`).
  `docker compose down -v` **menghapus semuanya**.
- Akun baru harus diverifikasi lewat email sebelum bisa masuk. Di mode pelatihan,
  email "terkirim" ke kotak surat yang bisa dibaca admin di `http://localhost:3000/admin/outbox`.

## Cara mengerjakan M5–M11

Ikuti paket materi lanjutan dengan urutan berikut:

1. [`docs/materi-lanjutan/README.md`](../materi-lanjutan/README.md): peta isi dan rencana waktu.
2. [`01-modul-peserta.md`](../materi-lanjutan/01-modul-peserta.md): konsep tiap modul.
3. [`02-praktikum.md`](../materi-lanjutan/02-praktikum.md): langkah praktik L0–L9 dan bukti yang dikumpulkan.
4. [`03-referensi-api.md`](../materi-lanjutan/03-referensi-api.md): buka saat butuh detail endpoint.
5. Opsional M11: [`07-keamanan-api-owasp.md`](../materi-lanjutan/07-keamanan-api-owasp.md) dan
   [`08-penutupan-celah-keamanan.md`](../materi-lanjutan/08-penutupan-celah-keamanan.md).

Praktikum memakai PowerShell. Di Git Bash, `curl` dengan `-H 'content-type: application/json'`
memberi hasil yang sama.

## Sebelum lanjut ke modul 12

- [ ] `npm test` lulus (219 tes) dan stack Docker `healthy`.
- [ ] Anda bisa menjelaskan alur katalog → keranjang → checkout → detail pesanan, dan
      di service mana setiap langkah terjadi.
- [ ] Anda tahu mengapa pesanan memakai `Idempotency-Key` dan mengapa stok dikurangi
      dalam satu transaksi.

## Lanjut

Setiap lab modul 12 mencabut **satu** fitur dari kode ini, lalu meminta Anda
mengembalikannya:

```bash
docker compose down
git switch starter/m12.1-cart-if-match
npm ci && npm run build:packages
```
