# Penutupan celah keamanan: stok, inventaris API, logout, dan email

Revisi 14 November 2026. Bab ini melengkapi M11 dan menjadi acuan ketika langkah autentikasi pada praktikum lama berbeda. Branch latihan `m12.x` tetap merupakan snapshot latihan pada revisi pembuatannya; perubahan terbaru dibaca pada `main` setelah merge.

## Aturan yang diterapkan

| Area          | Perilaku terbaru                                                                                           | Batasnya                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| API6          | Maksimal 5 pesanan aktif dan 10 unit per produk per akun                                                   | Nilai bawaan dapat diubah melalui `ORDER_MAX_OPEN_ORDERS` dan `ORDER_MAX_UNITS_PER_PRODUCT`; bukan kuota pembelian seumur hidup |
| Pembatalan    | `CANCELLATION_REQUESTED` masih memakai kuota sampai pelepasan stok berhasil dan status menjadi `CANCELLED` | Gangguan product-service menunda pengembalian kuota                                                                             |
| API9          | OpenAPI 3.1 pada `/api/v1/openapi.json`, pengecekan drift generator, dan cakupan route                     | Kontrak respons tetap perlu dites terhadap implementasi nyata                                                                   |
| Logout        | JWT membawa `sid`; auth-service menyimpan pencabutan secara durable                                        | Product/order memakai cache singkat, sehingga propagasi tidak serentak                                                          |
| Gangguan auth | Cache pencabutan yang kedaluwarsa menyebabkan 503 `SESSION_CHECK_UNAVAILABLE`                              | Katalog publik tetap tersedia; operasi terproteksi menunggu auth pulih                                                          |
| Email         | Akun biasa harus memverifikasi email sebelum membuat order atau checkout                                   | Kepemilikan alamat email tidak membuktikan satu orang hanya mempunyai satu akun                                                 |

Pemeriksaan kuota dijalankan dalam transaksi database yang sama dengan pembuatan order. Item produk yang sama dijumlahkan terlebih dahulu. Retry dengan key yang telah diterima mengembalikan order yang sama. Jatah baru tersedia setelah order selesai atau pembatalan selesai, bukan ketika niat batal baru diterima.

## Mengapa logout perlu pemeriksaan tambahan

Tanda tangan JWT membuktikan siapa penerbit token dan apakah isinya diubah. Tanda tangan tidak mengetahui bahwa pengguna baru saja menekan Keluar. Karena itu, setiap access token dikaitkan dengan keluarga refresh token melalui klaim `sid`.

Logout dan deteksi pemakaian ulang refresh token mencatat keluarga yang dicabut. Auth-service menolak sesi tersebut langsung. Product-service dan order-service mengambil daftar dari endpoint internal menggunakan service token, menggabungkan permintaan bersamaan, dan menyimpan cache selama `REVOCATION_MAX_AGE_MS` (bawaan 5.000 ms). Ada jeda cache dan waktu komunikasi; jangan mengajarkan bahwa logout langsung berlaku serentak di semua proses.

Jika cache sudah kedaluwarsa dan auth-service tidak terjangkau, request terproteksi ditolak sementara dengan 503. Ini keputusan keamanan yang mengurangi ketersediaan saat auth bermasalah. Menggunakan daftar lama tanpa batas akan membuka kembali celah token logout yang tetap dapat dipakai selama 15 menit. Token tanpa `sid` ditolak; pengguna sesi lama perlu masuk kembali setelah upgrade.

Frontend juga menjaga balapan refresh/logout. Respons refresh yang terlambat tidak boleh menghidupkan kembali sesi yang sedang diakhiri. Kegagalan logout harus terlihat dan dapat dicoba ulang; jangan menyimpulkan server telah mencabut sesi hanya karena halaman login tampil.

## Verifikasi email dan migrasi akun

1. Registrasi menyimpan akun biasa dengan `emailVerified: false` ketika verifikasi diwajibkan.
2. Token acak sekali pakai dikirim melalui email; database verifikasi menyimpan hash, batas waktu, dan pemiliknya. Tautan berlaku 24 jam.
3. Tautan membawa token pada fragment `/verify-email#token=...`; fragment tidak dikirim sebagai path HTTP. Halaman mengirim token ke `POST /api/v1/auth/verify-email`.
4. Setelah verifikasi, login atau refresh menerbitkan JWT baru dengan `email_verified: true`. JWT lama yang belum terverifikasi tetap ditolak untuk checkout.
5. Katalog dan keranjang dapat dipakai sebelum verifikasi; `POST /orders` dan `POST /cart/checkout` menolak dengan 403 `EMAIL_NOT_VERIFIED`.

Akun biasa lama tanpa flag verifikasi tidak dianggap sudah membuktikan email. Minta pengiriman ulang setelah login. Admin bootstrap dipercaya sebagai akun operator. Tombol kirim ulang memiliki cooldown per akun; endpoint tetap memiliki rate limit. Email yang gagal dikirim tidak membatalkan akun yang telah dibuat, sehingga pengguna dapat mencoba pengiriman ulang setelah login.

## Mode pelatihan dan pengiriman nyata

Compose dasar memilih `MAIL_TRANSPORT=outbox` dan mengaktifkan `MAIL_ALLOW_INSECURE_OUTBOX=true` secara eksplisit. Pesan disimpan sementara, terlihat melalui halaman admin `/admin/outbox`, dan hanya dapat dibaca administrator. Ini kotak surat simulasi: tidak ada email yang dikirim ke alamat sebenarnya. Orang yang dapat membaca kotak surat dapat menggunakan tautan verifikasi; karena itu mode ini hanya untuk kelas/lokal.

Untuk pengiriman nyata, gunakan relay milik operator yang menerima `POST {to, subject, text}` dan meneruskan email. Konfigurasikan URL HTTPS `MAIL_WEBHOOK_URL`, bearer secret `MAIL_WEBHOOK_TOKEN`, serta `FRONTEND_ORIGIN` HTTPS. Jangan menaruh secret aktual di dokumentasi atau Git. Overlay berikut membuka akses keluar hanya bagi auth-service, mematikan outbox, dan mewajibkan verifikasi:

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml -f docker-compose.mail.yml up --build -d --wait
```

Sertifikat dan file secret TLS harus disiapkan sesuai [HARDENING.md](../HARDENING.md). Endpoint outbox tidak tersedia pada mode webhook. Keberhasilan tes dengan relay tiruan tidak membuktikan email telah tiba di inbox nyata. Provider email, DNS pengiriman, dan kredensial organisasi tetap perlu disediakan operator.

CAPTCHA belum dipasang. Kontrol yang dipilih untuk tugas ini adalah verifikasi email sebelum alokasi stok, bersama kuota per akun dan rate limit. Untuk peluncuran dengan risiko bot tinggi, evaluasi CAPTCHA serta pemantauan multi-akun berdasarkan kebutuhan bisnis; jangan menganggap email terverifikasi menghapus seluruh risiko API6.

## Praktikum tambahan dan bukti yang dikumpulkan

Gunakan stack lokal pelatihan serta akun dan produk uji. Jangan menjalankan chaos test pada layanan pelanggan nyata.

1. Daftarkan akun baru, login, lalu coba checkout. Buktikan respons 403 dan stok tidak berubah.
2. Login sebagai admin, buka kotak surat pelatihan dan gunakan tautan akun uji. Coba tautan yang sama lagi: pemakaian kedua ditolak. Login ulang akun uji dan buktikan checkout berhasil.
3. Simpan JWT akun uji hanya di variabel proses, logout, lalu ulangi request terproteksi. Auth menolak langsung; product/order menolak setelah cache pencabutan diperbarui. Jangan menyalin token ke laporan.
4. Pada suite chaos, hentikan auth-service setelah cache terisi. Setelah cache kedaluwarsa, route terproteksi memberi 503 dan katalog publik tetap 200. Nyalakan lagi auth-service dan buktikan pemulihan.
5. Tahan kuota stok, minta pembatalan ketika product-service mati, lalu coba pesanan baru. Kuota belum boleh kembali sampai pembatalan benar-benar selesai.
6. Unduh OpenAPI dan bandingkan GET keranjang dengan hasil PUT/DELETE item. GET berisi kutipan harga/ketersediaan; mutasi mengembalikan record keranjang. Spesifikasi harus membedakan kedua bentuk tersebut.

```bash
npm run openapi:check
npm run typecheck
npm run lint
npm test
node scripts/e2e.mjs --chaos
node scripts/e2e-shopping.mjs --chaos
```

Laporkan status HTTP, perubahan stok/kuota, jeda pencabutan, hasil tes, dan keterbatasan verifikasi. Bukti eksekusi terbaru dicatat di [VERIFICATION.md](../VERIFICATION.md), sedangkan pemetaan risiko ada di [OWASP-API-SECURITY.md](../OWASP-API-SECURITY.md).
