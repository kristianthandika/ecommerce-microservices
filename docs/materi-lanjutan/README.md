# Paket materi lanjutan: dari prototype ke alur belanja utuh

**Versi acuan:** source code lokal pada 13 November 2026. **Bahasa:** Indonesia. **Sasaran:** peserta dan instruktur pelatihan Node.js, Express, Fastify, React, dan Docker yang telah menyelesaikan modul dasar.

Paket ini mendokumentasikan seluruh penambahan setelah prototype awal: penguatan hasil audit, penyimpanan persisten, reservasi stok, keranjang, checkout, riwayat/detail pesanan, dashboard admin, serta pembaruan header dan footer. Format sumber adalah Markdown agar mudah diedit dan disisipkan ke materi Word/PDF. Dokumen Word/PDF lama tidak ditimpa oleh paket ini.

## Isi dan urutan pemakaian

**Pembaruan keamanan 14 November 2026:** baca [penutupan celah keamanan](08-penutupan-celah-keamanan.md) sebelum praktikum. Akun baru dan akun biasa lama yang belum diverifikasi harus memverifikasi email (tautan dan password) sebelum bisa masuk; kotak surat lokal tersedia bagi admin. Pendaftaran dan lupa password selalu menjawab sama untuk alamat mana pun. Bab ini juga menjelaskan pencabutan JWT dan dampak gangguan auth-service.

| Berkas                                                           | Pembaca dan kegunaan                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [01-modul-peserta.md](01-modul-peserta.md)                       | Materi konsep, arsitektur, model data, aturan bisnis, dan pembahasan implementasi            |
| [02-praktikum.md](02-praktikum.md)                               | Langkah praktik, dataset, eksperimen kegagalan, hasil yang diharapkan, dan bukti pengumpulan |
| [03-referensi-api.md](03-referensi-api.md)                       | Endpoint, autentikasi, payload, respons, validasi, status HTTP, dan kode error               |
| [04-panduan-instruktur.md](04-panduan-instruktur.md)             | Rundown, demo, jawaban acuan, penilaian, dan pemecahan masalah kelas                         |
| [05-peta-kode-dan-pengujian.md](05-peta-kode-dan-pengujian.md)   | Navigasi source, namespace database, tes terkait, dan batas verifikasi                       |
| [06-panduan-integrasi-materi.md](06-panduan-integrasi-materi.md) | Peta penyisipan ke modul lama, koreksi narasi, panduan gambar, dan checklist penerbitan      |
| [07-keamanan-api-owasp.md](07-keamanan-api-owasp.md)             | M11 opsional: OWASP API Security Top 10, praktik pembuktian kontrol, dan diskusi desain      |

Urutan peserta: modul → praktikum → referensi API saat diperlukan. Instruktur membaca seluruh paket, terutama panduan integrasi, sebelum menggabungkannya ke materi lama. Jawaban acuan tidak perlu dimasukkan ke handout peserta.

## Hasil belajar

Setelah menyelesaikan paket ini, peserta dapat:

1. Menjelaskan mengapa pengecekan stok saja belum mencegah overselling.
2. Membedakan transaksi lokal, idempotency key, versi keranjang, revisi produk, dan recovery worker.
3. Mengikuti alur katalog → keranjang → checkout → detail pesanan melalui gateway.
4. Menjelaskan kepemilikan data dan pembatasan akses pengguna/admin pada backend.
5. Menguji konflik, respons yang hilang, stok kurang, restart, dan pemulihan tanpa menggandakan alokasi stok.
6. Menilai responsivitas dan aksesibilitas header/footer serta membedakan uji komponen dari uji browser.

## Rencana waktu yang disarankan

Paket lengkap merupakan **tambahan dua hari, masing-masing enam jam belajar efektif**, setelah pelatihan dasar empat hari. Istirahat berada di luar durasi berikut. Ini rekomendasi penyusunan kelas; bukan perubahan otomatis terhadap silabus resmi.

| Hari tambahan | Modul                                        |        Durasi | Hasil kerja                                                           |
| ------------- | -------------------------------------------- | ------------: | --------------------------------------------------------------------- |
| 1             | M5 — Penguatan sistem setelah audit          |     120 menit | Analisis bug, transaksi lokal, persistensi, dan batas operasional     |
| 1             | M6 — Keranjang persisten                     |      90 menit | CRUD keranjang dan demonstrasi konflik versi                          |
| 1             | M7 — Checkout dan konsistensi stok           |     150 menit | Checkout, idempotensi lintas key, snapshot alamat/harga, dan recovery |
| 2             | M8 — Riwayat pesanan dan admin               |     150 menit | Ownership, RBAC, revision guard, ringkasan, dan fulfillment           |
| 2             | M9 — Header, footer, dan pengalaman pengguna |      90 menit | Navigasi responsif, menu mobile, aksesibilitas, dan penanganan layout |
| 2             | M10 — Pengujian integrasi dan evaluasi       |     120 menit | Tes regresi, E2E, chaos, laporan bukti, dan presentasi                |
|               | **Total**                                    | **720 menit** | **12 jam efektif**                                                    |
| Opsional      | M11 — Keamanan API (OWASP API Top 10)        |     120 menit | Bukti kontrol per risiko, celah yang tersisa, dan usulan desain       |

Jika waktu terbatas, gunakan demo terarah dua jam: alur belanja 30 menit, konflik/idempotensi 30 menit, admin 20 menit, recovery 20 menit, dan diskusi 20 menit. Format ini tidak menggantikan praktikum lengkap.

## Prasyarat dan cara mulai

- Memahami REST, JWT/JWKS, middleware, state React, TypeScript, dan Docker Compose.
- Menggunakan **revisi source terbaru yang berisi paket ini**, bukan branch starter prototype lama.
- Menyiapkan Node.js sesuai `package.json` dan Docker Desktop dengan Linux containers.
- Menjalankan perintah dari folder `ecommerce-microservices` kecuali dinyatakan lain.

```bash
node scripts/setup.mjs --demo-admin
docker compose up --build -d --wait
```

Perintah setup hanya membuat `.env` jika berkas tersebut belum ada. Ia tidak menimpa konfigurasi yang sudah ada. Password admin acak dibaca secara lokal dari `.env`; jangan salin nilainya ke materi, slide, screenshot, atau log kelas. Untuk PowerShell yang memblokir `npm.ps1`, gunakan `npm.cmd` pada perintah npm di paket ini.

## Batas domain yang harus konsisten di seluruh materi

- `CONFIRMED` berarti **stok berhasil dialokasikan**, bukan pembayaran diterima.
- Total adalah **total produk**. Pembayaran, ongkir, kurir, dan refund belum diimplementasikan. Pembatalan order tersedia dan mengembalikan stok yang dialokasikan.
- Fulfillment `NEW → PROCESSING → COMPLETED` terpisah dari status order `PENDING/CONFIRMED/FAILED/CANCELLATION_REQUESTED/CANCELLED`.
- SQLite tersedia untuk satu host dan satu replica per service. Jangan menyebut implementasi ini siap horizontal scaling lintas host.
- Access token (15 menit) berada di memory frontend; sesi bertahan setelah refresh halaman melalui refresh token di cookie HttpOnly. Logout mencabut sesi di server.
- Modul M5–M11 dikerjakan di branch `bridge/m5-m11-materi-lanjutan`, yang berisi kode lengkap ini dan menyambung langsung dari `solution/m4.5-capstone`. Praktikumnya membaca, menjalankan, dan menguji sistem itu; lab menulis kode untuk fitur-fitur ini ada di rantai `starter/m12.x` → `solution/m12.x` sesudahnya (lihat [daftar lab](../exercises/README.md)).

Referensi operasional: [hardening](../HARDENING.md), [fitur belanja](../SHOPPING-FEATURES.md), dan [hasil verifikasi](../VERIFICATION.md).

## Pemeriksaan paket dokumentasi

Tautan relatif, keseimbangan code block, JSON contoh, pencocokan 23 endpoint terhadap source, total durasi, dan konsistensi dua hasil gabungan telah diperiksa saat penyusunan. Tujuh blok PowerShell pada sumber praktikum lolos pemeriksaan parser tanpa menjalankan request atau prompt kredensial. Tiga diagram Mermaid disediakan sebagai source; belum diekspor atau diverifikasi layout cetaknya. Suite aplikasi tidak dijalankan ulang hanya untuk perubahan dokumentasi.

Laporan pemeriksaan lokal berada di `.e2e/training-docs-validation.json`. Hasil ini memeriksa paket dokumentasi, bukan bukti baru pengujian aplikasi atau hasil penerbitan Word/PDF.
