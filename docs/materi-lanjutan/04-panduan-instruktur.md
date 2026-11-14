# Panduan instruktur dan jawaban acuan

Dokumen ini mendampingi modul peserta dan lembar praktikum. Simpan bagian jawaban/rubrik sebagai panduan fasilitator, bukan otomatis digabungkan ke handout peserta.

## Persiapan sebelum kelas

1. Gunakan salinan source yang benar-benar berisi paket lanjutan. Catat commit bila sudah tersedia, atau identifikasi revisi kerja dan tanggalnya bila perubahan belum di-commit. Jangan mengasumsikan branch starter/solution baru telah dibuat.
2. Periksa Node, Docker Desktop, port 3000/8080, ruang disk, dan kesiapan image. Build awal dapat memerlukan unduhan; persiapkan sebelum sesi, jangan menghabiskan waktu konsep untuk menunggu dependency.
3. Siapkan `.env` dan admin opt-in dengan password unik. Berkas yang sudah ada tidak ditimpa script setup. Jangan menaruh kredensial aktual pada proyektor atau rekaman kelas.
4. Gunakan satu stack lokal per peserta/kelompok. Jika server digunakan bersama, kuota per-IP dan data bersama akan memengaruhi hasil; alokasikan skenario serta dataset unik secara eksplisit.
5. Jalankan baseline unit/typecheck/lint dan kedua suite E2E pada lingkungan uji. Catat hasil yang benar-benar keluar, jangan menyalin angka 64 sebagai jaminan setiap revisi berikutnya.
6. Sediakan browser untuk praktik viewport dan keyboard. Ketidaktersediaan alat otomatis Firefox Windows pada sesi pengembangan tidak boleh menghapus pemeriksaan visual dari agenda kelas.

## Rundown dua hari tambahan

| Modul | Penjelasan, demo, diskusi/evaluasi |     Praktikum | Total |
| ----- | ---------------------------------: | ------------: | ----: |
| M5    |                           65 menit | L0 20 + L1 35 |   120 |
| M6    |                           20 menit | L2 40 + L3 30 |    90 |
| M7    |                           65 menit | L4 50 + L5 35 |   150 |
| M8    |                           70 menit | L6 50 + L7 30 |   150 |
| M9    |                           50 menit |         L8 40 |    90 |
| M10   |                           50 menit |         L9 70 |   120 |

Hari tambahan pertama: M5–M7, 360 menit efektif. Hari kedua: M8–M10, 360 menit efektif. Pisahkan istirahat dari angka tersebut. Untuk kelas yang belum menguasai JWT, async, dan transaksi, kurangi cakupan atau tambah waktu; jangan mempercepat bagian konsistensi dengan sekadar menyalin kode.

## Urutan demo yang disarankan

### Demo 1 — Produk di keranjang belum mengurangi stok

Tampilkan produk stok sepuluh. Pelanggan menambahkan dua unit dan melihat total. Baca stok lewat API: masih sepuluh. Setelah checkout, stok delapan dan order confirmed. Tanyakan kapan keputusan bisnis menjadi durable dan service mana yang memiliki stok.

### Demo 2 — Dua jenis konflik

Pertama simulasikan dua tab dengan versi cart sama; perubahan kedua harus 409 CART_CHANGED. Kemudian buka form edit produk, lakukan checkout dari pelanggan, dan simpan form lama: 409 PRODUCT_CHANGED. Jelaskan bahwa version dan revision melindungi objek berbeda.

### Demo 3 — Key berbeda tidak berarti checkout baru

Kirim satu snapshot/alamat dengan dua key. Tunjukkan satu ID order dan satu pengurangan stok. Berikutnya pakai salah satu key itu pada versi baru: harus konflik. Jangan menyebut key sekadar UUID acak; server harus menyimpan ikatan maknanya.

### Demo 4 — Hasil HTTP belum tentu hasil transaksi

Gunakan suite recovery untuk menghindari demonstrasi yang mengandalkan timing klik. Tunjukkan PENDING, service stop/restart, dan konfirmasi setelah pulih. Pada tes receipt hilang, product dapat sudah commit walau respons tidak sampai. Bedakan tiga bukti: request gagal, order tersimpan, dan stok teralokasi.

### Demo 5 — Header/footer sebagai kasus debugging layout

Bandingkan rasio banner lama dengan ruang container. Gunakan DevTools menghitung lebar elemen, lalu jelaskan penggantian ke logo proporsional dan teks yang dapat wrap. Uji menu pada 768 dan 1280 px serta skip link. Perubahan ini tidak memerlukan service baru atau modifikasi logika order.

## Jawaban acuan pertanyaan utama

| Pertanyaan                                                                  | Pokok jawaban yang diharapkan                                                                                                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mengapa Map tidak cukup?                                                    | Data proses tidak durable dan tidak menjadi sumber bersama antarreplica; SQLite menyimpan data per service pada disk/volume.                                                     |
| Mengapa precheck email tidak cukup?                                         | Dua request dapat melewati precheck sebelum await hashing selesai; primary key/insert unik memastikan hanya satu pendaftaran commit.                                             |
| Mengapa 72 karakter tidak sama dengan 72 byte?                              | UTF-8 memakai jumlah byte berbeda per karakter; bcrypt memakai maksimal 72 byte.                                                                                                 |
| Mengapa transaksi lokal bukan transaksi lintas service?                     | Setiap service meng-commit database sendiri; HTTP dapat gagal di antara commit. Diperlukan identitas durable dan recovery, bukan asumsi satu transaksi ACID lintas file/service. |
| Mengapa harga di cart belum final?                                          | Quote membaca katalog; receipt saat reservasi membekukan harga transaksi. Total dari client tidak dipercaya.                                                                     |
| Mengapa stok perlu dicek dalam satu batch?                                  | Semua baris dan jumlah produk duplikat harus diperhitungkan sebelum alokasi; kekurangan satu item membatalkan seluruh batch.                                                     |
| Apa yang sama ketika replay?                                                | Identitas order/reservasi dan efek alokasi. Field operasional order dapat berubah setelahnya.                                                                                    |
| Mengapa key alternatif juga disimpan?                                       | Jika hanya key pertama yang diikat, key kedua bisa salah dipakai lagi pada checkout/legacy order lain.                                                                           |
| Apakah semua 503 berarti tidak ada transaksi?                               | Tidak. Hasil jaringan ambigu; periksa riwayat dan ulangi identitas lama.                                                                                                         |
| Mengapa cart baru tidak langsung dikosongkan?                               | Checkout lama tidak boleh membuang perubahan pengguna. Implementasi mempertahankan seluruh versi baru, bukan otomatis mengurangi hanya delta.                                    |
| Mengapa 404 untuk order pengguna lain?                                      | Menjaga ownership dan tidak mengungkap keberadaan order melalui detail.                                                                                                          |
| Apakah semua PUT produk terlindungi revision guard?                         | Tidak; guard dijalankan bila expectedRevision disertakan. Form admin mengirimnya, API kompatibel lama masih opsional.                                                            |
| Apakah fulfillment COMPLETED berarti uang sudah masuk atau kurir mengantar? | Tidak. Itu penandaan operasional admin pada domain yang belum memiliki pembayaran/kurir.                                                                                         |
| Mengapa timeout perlu membaca body?                                         | Fetch selesai pada header belum berarti body selesai. Reader dan batas ukuran harus masuk deadline.                                                                              |
| Mengapa rate-limit sempat menjadi 500?                                      | Custom error kehilangan statusCode dan scope proxy tidak mewarisi handler jika dipasang terlambat. Handler awal serta statusCode yang dipertahankan menyelesaikannya.            |

## Hasil praktikum dan bukti minimum

| Latihan | Bukti minimum                                              | Indikasi jawaban keliru                                      |
| ------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| L0      | Lima service healthy dan base URL benar                    | Memanggil port backend host yang memang tidak dipublikasikan |
| L1      | 400 untuk JSON/password invalid; penjelasan insert unik    | Menganggap precheck sebelum await sudah menjamin unik        |
| L2      | Mutasi record dasar versus GET quote; stok belum turun     | Mengira PUT quantity=2 adalah penambahan dua                 |
| L3      | 409 untuk snapshot kedua; state pertama bertahan           | Menghapus pemeriksaan version agar request lolos             |
| L4      | ID sama untuk replay dan stok berkurang sekali             | Mengganti key/version setiap menerima timeout                |
| L5      | Item bertahan setelah gagal; versi baru untuk attempt baru | Mengosongkan cart pada semua error                           |
| L6      | 404 ownership; 403 admin; transisi status benar            | Mengandalkan menu tersembunyi tanpa bukti API                |
| L7      | 409 revisi lama dan stok tidak naik kembali                | Mengirim stok lama tanpa expectedRevision                    |
| L8      | Screenshot/fokus aktual dan alasan rasio gambar            | Hanya menambah overflow hidden pada body                     |
| L9      | Laporan tes, satu alokasi setelah recovery, backup         | Menganggap satu response 200 membuktikan seluruh workflow    |

## Rubrik penilaian (100 poin)

| Aspek                                | Poin | Kriteria                                                                           |
| ------------------------------------ | ---: | ---------------------------------------------------------------------------------- |
| Pemahaman arsitektur dan konsistensi |   25 | Boundary, transaksi lokal, version/key/revision, dan hasil ambigu dijelaskan benar |
| Alur fungsional                      |   30 | Cart, checkout, history/detail, serta admin bekerja sesuai skenario                |
| Integritas dan recovery              |   20 | Bukti konflik, tidak oversell, key reuse, serta restart/receipt retry              |
| Keamanan dan otorisasi               |   15 | RBAC/ownership melalui API dan kredensial tidak bocor dalam bukti                  |
| UX, aksesibilitas, dan laporan       |   10 | Menu/fokus/viewport diuji dan laporan menyebut batas verifikasi                    |

Syarat kelulusan yang disarankan: minimal 75/100 dan tidak ada kegagalan kritis pada kepemilikan order, penggandaan stok, atau pembocoran secret. Peserta yang gagal pada invariant kritis melakukan perbaikan dan menunjukkan bukti ulang; nilai tampilan tidak menutup kegagalan integritas.

## Troubleshooting kelas

| Gejala                                         | Periksa                                    | Tindakan yang sesuai                                                                                         |
| ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| npm.ps1 diblokir di Windows                    | Kebijakan shell                            | Pakai npm.cmd; jangan mengubah kebijakan keamanan OS sebagai langkah pertama                                 |
| Setup berkata .env sudah ada                   | Konfigurasi sebelumnya                     | Periksa konfigurasi privat; setup memang tidak menimpa file                                                  |
| Admin tidak dapat login                        | Email, password, flag seed, role akun lama | Gunakan admin yang valid; register publik tidak dapat menaikkan role                                         |
| Login hilang setelah refresh                   | Cookie refresh tidak terkirim/ditolak      | Periksa cookie `refresh_token` di DevTools dan origin (`REFRESH_ALLOWED_ORIGINS`)                            |
| Order/history tampak kosong                    | Akun aktif, filter, offset, dataset        | Cocokkan user/token dan query; jangan menyalin ID seed orang lain                                            |
| 409 CART_CHANGED                               | Versi lama pada tab/CLI                    | GET ulang lalu putuskan mutasi baru                                                                          |
| Form admin masih konflik setelah reload daftar | Form masih menyimpan revisi awal           | Tutup dan buka ulang form berdasarkan data baru                                                              |
| Checkout lama tetap ditolak setelah restock    | Tiket lama dan versi cart                  | Ambil versi cart yang diperbarui untuk attempt baru; replay lama memang tetap gagal                          |
| 429 muncul ketika banyak latihan dijalankan    | Retry-After dan kuota IP                   | Tunggu sesuai header; jangan menonaktifkan rate limit agar semua request menjadi 200                         |
| Health merah sesaat setelah start              | Readiness, log, cache agregat              | Tunggu probe berikutnya; Docker sehat bukan bukti semua dependensi selalu siap bersamaan                     |
| Docker network overlap                         | Subnet deployment lain                     | Ikuti HARDENING.md dan selaraskan subnet, IP frontend, serta trusted proxy; jangan hapus network proyek lain |
| Layout masih versi lama                        | Bundle/hash dan cache browser              | Pastikan container frontend dibangun ulang; hard reload jika perlu                                           |
| Tes frontend gagal sebelum berjalan            | Izin filesystem/config loader              | Bedakan kendala alat dari bug assertion; uji pada runner dengan akses yang sesuai                            |

## Jawaban acuan M11 (OWASP)

| Latihan | Hasil yang benar                                                                                                                                                                                                                                                                                                                                                | Kesalahan pemahaman yang sering muncul                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| S1      | GET dan cancel order milik orang lain → 404                                                                                                                                                                                                                                                                                                                     | Mengira 403 lebih aman; 403 justru membocorkan bahwa ID itu ada        |
| S2      | Role tetap `user`; total = harga katalog                                                                                                                                                                                                                                                                                                                        | Menganggap validasi di form React sudah cukup                          |
| S3      | Cookie HttpOnly tidak muncul di `document.cookie`; percobaan ke-6 → 429                                                                                                                                                                                                                                                                                         | Mengira penguncian permanen lebih baik; itu memberi penyerang alat DoS |
| S4      | 400, 403, 403, 404; beban tinggi → 429 dengan Retry-After                                                                                                                                                                                                                                                                                                       | Menyebut menu admin tersembunyi sebagai kontrol akses                  |
| S5      | CSP ada, `Server: nginx` tanpa versi, 404 seragam, read-only; spesifikasi 1.0.0 dengan 23 path; jalur lama 200 + `Deprecation`/`Sunset`/`Link`; `v2` → 404; route percobaan membuat tes cakupan gagal                                                                                                                                                           | Menganggap endpoint yang tidak didokumentasikan otomatis aman          |
| S6      | 11 unit → 409 `HOLD_LIMIT_EXCEEDED`; di luar transaksi dua request paralel sama-sama lolos; retry ditolak = pelanggan kehilangan order yang sudah ada; multi-akun: CAPTCHA/verifikasi email, batas per kartu/alamat kirim setelah ada pembayaran, bukan blok IP; allowlist host + blok IP privat + tanpa redirect untuk SSRF; tes kontrak `idempotency.test.ts` | Menaruh batas bisnis di frontend atau gateway saja; memblokir per IP   |

## Batas klaim saat mengajar

Jangan mengklaim bahwa sistem sudah menjalankan pembayaran, saga pembayaran (yang tersedia hanya saga pembatalan stok), event bus, shipping integration, KMS rotation, scaling multi-host, atau image OS scanning penuh. Workflow CI sudah ditulis dan pengujian lokal mempunyai bukti; eksekusi di GitHub harus dibuktikan terpisah.

Jangan menyatakan 64 tes berarti tidak ada bug. Angka tes hanya bermakna bersama revisi, skenario, hasil, dan batas. Tes header/footer sebelumnya adalah tes regresi komponen/build, bukan sertifikasi semua viewport atau screen reader.
