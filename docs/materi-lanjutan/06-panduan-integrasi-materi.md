# Panduan menggabungkan ke materi pelatihan

## Posisi terhadap paket empat hari

Paket lama tetap menjadi materi prototype empat hari. Paket lanjutan ini dapat dijadikan dua hari tambahan atau beberapa bab pilihan setelah capstone. Jangan mengganti angka durasi pada sampul lama tanpa menyesuaikan silabus, rundown, dan persetujuan penyelenggara.

Sumber materi lama tersedia di `materi/modul-pdf/materi.md` dan `pengajar.md`; dokumen Word/PDF juga sudah ada. Panduan ini tidak menimpa hasil ekspor lama atau mengubah seluruh isi generator lama. Instruktur/editor memilih bagian yang akan disisipkan, lalu melakukan ekspor dan pemeriksaan layout kembali.

## Peta penyisipan

| Materi dasar                  | Tambahan yang relevan                                                              | Tindakan editor                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Hari 1, auth/security         | Registrasi unik setelah await, batas byte bcrypt, audience/expiry, bootstrap admin | Tambahkan pembahasan penguatan setelah contoh register/login                |
| Hari 2, product/order         | SQLite, transaksi batch, receipt, idempotensi dan key alternatif                   | Ganti narasi check-stock-only bila bab ditujukan untuk implementasi terkini |
| Hari 2, resilience            | Timeout mencakup body, cancellation, ukuran respons, generasi breaker              | Sisipkan kasus regresi setelah wrapper dasar                                |
| Hari 3, gateway/health        | Route /cart, cache health, pengecualian probe, handler awal dan error 429          | Perbarui diagram route serta demo rate-limit                                |
| Hari 4, frontend              | CartProvider, checkout, history/detail, guard admin, header/footer responsif       | Jadikan bab M6–M9 atau lampiran implementasi lanjutan                       |
| Hari 4, Docker/capstone       | Volume database, secret file, TLS opsional, backup, recovery checkout              | Perbarui checklist operasional dan tugas akhir                              |
| Panduan peserta               | L0–L9                                                                              | Salin langkah dan lembar bukti; jangan sertakan jawaban instruktur          |
| Hari 1–4, keamanan            | OWASP API Security Top 10, sesi refresh token, If-Match, pembatalan                | Tambahkan M11 sebagai sesi penutup atau lampiran keamanan                   |
| Catatan pengajar/solusi acuan | Rundown, tabel jawaban, rubrik, troubleshooting                                    | Tempatkan pada panduan fasilitator terpisah                                 |

## Koreksi narasi yang wajib diperiksa

Jika modul lama dan baru digabungkan sebagai satu implementasi terkini, revisi klaim berikut:

1. **Data selalu hilang saat restart** → data service sekarang disimpan pada SQLite/volume; kehilangan data merupakan penjelasan versi prototype, bukan kondisi saat ini.
2. **Seed ID produk selalu berubah saat product restart** → seed memakai metadata dan data dipertahankan. Jangan jadikan perubahan ID sebagai ekspektasi uji restart baru.
3. **Admin otomatis admin123** → admin opt-in; setup menghasilkan password acak jika `.env` belum ada. Jangan memasukkan password mesin pengembang ke materi.
4. **Browser langsung memanggil gateway localhost:8080 sebagai default bundle** → frontend saat ini menggunakan same-origin `/api`; nginx/Vite meneruskan ke gateway.
5. **Order hanya memeriksa stok** → reservasi batch mengurangi stok dan menyimpan receipt dalam transaksi lokal.
6. **Setiap key baru selalu membuat order baru** → checkout juga dibatasi oleh user/versi cart; key alternatif terikat pada versi yang sama.
7. **Semua JSON error sama code-nya** → bentuk error seragam, tetapi code bisa berbeda menurut lapisan. Fulfillment masih memakai APP_ERROR untuk sebagian penolakan.
8. **CONFIRMED berarti pembayaran lunas** → confirmed berarti alokasi stok; pembayaran belum tersedia.
9. **COMPLETED berasal dari tracking kurir** → status ini ditetapkan admin; tidak ada integrasi kurir.
10. **Backup satu file SQLite yang sedang aktif cukup** → gunakan online backup dan perlakukan WAL/restore sesuai prosedur.
11. **Footer harus memakai banner tinggi tetap** → implementasi baru memakai layout logo/teks yang responsif.
12. **Semua fitur tambahan mempunyai starter/solution branch** → belum dibuat untuk paket lanjutan; jangan membuat perintah checkout fiktif.
13. **64 tes menjamin semua browser sudah diuji** → tes mempunyai cakupan dan batas; uji visual/keyboard tetap dicatat terpisah.
14. **JWT berlaku 1 jam** (modul dasar, contoh payload L1.x) → access token kini 15 menit dan diperpanjang lewat refresh token. Contoh `exp` 1 jam hanya benar untuk versi sebelum hardening.
15. **Token di memory, refresh halaman = login ulang (disengaja)** (modul dasar Hari 4) → access token tetap di memory, tetapi sesi dipulihkan lewat refresh token di cookie HttpOnly; refresh halaman tidak lagi memaksa login ulang, dan logout mencabut sesi di server.
16. **Keranjang mengirim `version` di body** → mutasi keranjang memakai `If-Match`/`ETag`; konflik 412, tanpa precondition 428. Body `version` masih diterima sementara (deprecated, konflik 409).
17. **Pembatalan belum ada** → pembatalan tersedia sebagai saga dengan kompensasi; stok dikembalikan tepat sekali.
18. **Keamanan cukup dijelaskan dengan helmet/CORS/rate limit** → petakan ke OWASP API Security Top 10 memakai [M11](07-keamanan-api-owasp.md) dan [pemetaan bukti](../OWASP-API-SECURITY.md).

Bila sengaja mempertahankan prototype sebagai tahap pembelajaran, beri label jelas “versi sebelum hardening”, lalu tampilkan perubahan dan alasannya. Hindari dua bab yang sama-sama menyebut perilaku berbeda sebagai kondisi terbaru.

## Ilustrasi dan screenshot yang perlu disiapkan saat penerbitan

Diagram Mermaid tersedia pada modul peserta: arsitektur, sequence checkout, dan state order. Untuk Word/PDF yang tidak merender Mermaid, ekspor diagram menjadi gambar/SVG menggunakan renderer yang disetujui, lalu periksa label dan keterbacaannya. Kode Mermaid belum merupakan gambar siap cetak otomatis.

| Nomor usulan | Objek                | Hal yang harus tampak                                                |
| ------------ | -------------------- | -------------------------------------------------------------------- |
| G-L01        | Katalog dan navigasi | Branding baru, tombol tambah, badge jumlah unit                      |
| G-L02        | Keranjang            | Quantity, total quote, update/hapus, warning stok                    |
| G-L03        | Checkout             | Alamat, total produk, keterangan tanpa pembayaran/ongkir             |
| G-L04        | Detail pesanan       | Dua sumbu status dan snapshot alamat/item                            |
| G-L05        | Admin produk         | Ringkasan, form, konflik expectedRevision                            |
| G-L06        | Admin pesanan        | Pencarian, filter, transisi PROCESSING/COMPLETED                     |
| G-L07        | Header/footer mobile | Menu terbuka, footer wrap, tidak ada scroll horizontal akibat layout |
| G-L08        | Hasil recovery       | Order ID sama, stok sekali, health pulih                             |

Gunakan akun dan alamat dummy. Masking password, bearer token, service token, serta isi `.env`. Jangan memakai screenshot yang memperlihatkan data peserta lain. Keterangan gambar harus menyebut hasil yang terlihat, bukan mengklaim perilaku yang tidak dibuktikan gambar itu.

## Paket siap sunting

Jalankan dari folder `ecommerce-microservices`:

```bash
node scripts/build-training-materials.mjs
```

Perintah ini menyusun dua berkas Markdown gabungan pada `materi/tambahan-fitur/` di workspace:

- `materi-tambahan.md`: modul peserta, praktikum, referensi API, dan peta source/pengujian.
- `panduan-pengajar.md`: panduan instruktur beserta panduan integrasi ini.

Sumber kanonis tetap enam dokumen pada folder paket. Script menyesuaikan level heading dan tautan relatif; ia tidak mengubah source aplikasi, tidak membaca `.env`, dan tidak membuat Word/PDF. Edit sumber kanonis lalu regenerasi, jangan memelihara dua salinan yang isinya berbeda.

## Checklist sebelum dibagikan

- [ ] Durasi sampul, silabus, dan rundown konsisten; 12 jam efektif tambahan dijelaskan.
- [ ] Bab prototype dan bab terkini diberi label versi yang jelas.
- [ ] Semua ID/key contoh dinyatakan ilustrasi; praktikum mengambil nilai aktual dari respons.
- [ ] Semua endpoint memakai base URL yang benar; route internal tidak diajarkan sebagai endpoint browser.
- [ ] Jumlah tes dan hasil dicatat bersama revisi/tanggal; klaim tidak disalin sebagai hasil baru.
- [ ] Ringkasan confirmedValue tidak disebut penerimaan pembayaran.
- [ ] Jawaban instruktur tidak ikut handout peserta bila ingin dipakai sebagai evaluasi.
- [ ] Diagram telah dirender bila format akhir memerlukannya; teks dan panah terbaca saat dicetak.
- [ ] Screenshot diambil pada source terkini, termasuk header/footer terbaru, dan bebas kredensial nyata.
- [ ] Code block, tabel, page break, hyperlink, caption, dan penomoran diperiksa setelah ekspor Word/PDF.
- [ ] Port/subnet yang dipakai kelas tidak bertabrakan dan semua kelompok memahami efek opsi chaos.
- [ ] Materi tidak menyatakan fitur backlog sebagai fitur yang sudah berjalan.

Dokumentasi operasional tetap mengacu pada [HARDENING.md](../HARDENING.md) dan [PRODUCTION-CHECKLIST.md](../PRODUCTION-CHECKLIST.md). Hindari menyalin prosedur production menjadi instruksi kelas tanpa meninjau konteksnya.
