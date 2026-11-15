# Keranjang, checkout, pesanan, dan admin

## Alur pelanggan

1. Login atau daftar akun, lalu buka **Katalog**. Pencarian nama dan pagination tersedia.
2. Gunakan **Tambah ke keranjang**. Jumlah barang tampil pada navigasi. Keranjang tersimpan di SQLite order-service dan tetap tersedia setelah login kembali atau service restart.
3. Buka **Keranjang** untuk mengubah jumlah atau menghapus barang. Harga dan stok dibaca dari katalog saat halaman dimuat. Produk yang dihapus atau stoknya tidak cukup tetap bisa dihapus dari keranjang.
4. Buka **Checkout**, isi nama, telepon, alamat, kota, provinsi, kode pos 5 digit, dan catatan opsional. Konfirmasi membuat satu pesanan dan mengalokasikan stok secara atomik. Harga akhir mengikuti katalog saat konfirmasi.
5. Buka **Pesanan saya** atau detail pesanan untuk melihat status, item, harga yang telah dibekukan, dan salinan alamat. Pesanan PENDING diperbarui berkala pada halaman detail.

Belum ada pembayaran online, penagihan, tarif ongkir, atau integrasi kurir. Total yang ditampilkan adalah total produk. `CONFIRMED` berarti stok berhasil dialokasikan, bukan pembayaran berhasil.

## Alur admin

Menu **Dashboard admin** hanya tampil untuk role admin, dan seluruh endpoint operasional juga memeriksa role pada backend.

- Ringkasan: jumlah produk, stok menipis/habis, pesanan terkonfirmasi, nilai pesanan, serta jumlah pending dan sedang diproses.
- Produk & stok: buat, cari, edit harga/stok, dan hapus produk dengan konfirmasi. Form edit membawa revisi produk; jika checkout mengubah stok sementara admin mengedit, penyimpanan ditolak 409 sehingga stok baru tidak tertimpa.
- Pesanan: cari berdasarkan ID/penerima, filter status, pagination, dan buka detail termasuk alamat.
- Pemrosesan: pesanan CONFIRMED mengikuti `NEW → PROCESSING → COMPLETED`. Transisi mundur atau melewati langkah ditolak; pengulangan status yang sama aman.
- Pembatalan: pelanggan dapat membatalkan pesanannya selama belum diproses; admin dapat membatalkan pesanan yang belum selesai. Stok dikembalikan tepat sekali. Refund belum tersedia karena belum ada pembayaran.

## Kontrak dan konsistensi

| Endpoint                              | Fungsi                                                      |
| ------------------------------------- | ----------------------------------------------------------- |
| `GET /cart`                           | Keranjang pengguna dengan harga/stok terkini                |
| `PUT /cart/items/:id`                 | Set jumlah absolut, body `{quantity}`, header `If-Match`    |
| `DELETE /cart/items/:id`              | Hapus item, header `If-Match`, tanpa body                   |
| `DELETE /cart`                        | Kosongkan keranjang, header `If-Match`, tanpa body          |
| `POST /orders/:id/cancel`             | Pelanggan membatalkan order (fulfillment masih NEW)         |
| `POST /orders/admin/:id/cancel`       | Admin membatalkan order yang belum COMPLETED                |
| `POST /cart/checkout`                 | Body `{version, shippingAddress}`, header `Idempotency-Key` |
| `GET /orders`                         | Pesanan pengguna, filter `status`, `q`, `limit`, `offset`   |
| `GET /orders/:id`                     | Detail milik pengguna tersebut                              |
| `GET /orders/admin`                   | Daftar semua pesanan untuk admin                            |
| `GET /orders/admin/summary`           | Ringkasan pesanan untuk admin                               |
| `GET /orders/admin/:id`               | Detail pesanan untuk admin                                  |
| `PATCH /orders/admin/:id/fulfillment` | Body `{status: PROCESSING atau COMPLETED}`                  |
| `GET /products/admin/summary`         | Ringkasan produk dan stok untuk admin                       |

Gateway meneruskan `/cart` ke order-service. Tidak ada service baru pada paket ini.

Mutasi keranjang memakai versi optimistis; request dari tab lama ditolak 409. Satu versi keranjang menghasilkan paling banyak satu order, termasuk ketika dua tab mengirim idempotency key berbeda. Alamat yang berbeda untuk checkout yang sama ditolak. Order PENDING tetap durable, menggunakan ID reservasi yang sama pada retry/recovery, dan mengosongkan keranjang asal setelah berhasil. Jika pengguna mengubah keranjang selama proses berjalan, versi yang lebih baru dipertahankan seluruhnya agar perubahan tersebut tidak terhapus; periksa kembali barang yang masih ada sebelum checkout berikutnya. Mengubah keranjang tidak membatalkan order PENDING.

Jika reservasi definitif ditolak, isi keranjang tetap ada dan versinya diperbarui agar pengguna bisa mencoba lagi setelah stok diperbaiki. Retry terhadap versi checkout lama tetap memutar ulang hasil lama. Produk/alamat baru ditambahkan sebagai field JSON opsional sehingga order lama tetap terbaca tanpa menghapus volume atau data.

## Pengujian

```bash
npm run build:packages
npm test
npm run typecheck
npm run lint
docker compose up --build -d --wait
node scripts/e2e.mjs --chaos
node scripts/e2e-shopping.mjs --chaos
```

Script shopping membuat akun/produk uji, memeriksa CRUD keranjang, checkout dengan harga terbaru, konkurensi, ownership/RBAC, revisi stok, alur fulfillment, persistence, produk hilang/stok kurang, dan pemulihan checkout setelah restart. Produk uji dibersihkan; order uji tetap sebagai riwayat. Hasil berada di `.e2e/shopping-results.json`. Script menghormati `Retry-After` jika terkena rate limit ketika dijalankan setelah suite lain. Opsi `--chaos` menghentikan/restart service proyek ini; gunakan lingkungan testing.

Tes component meliputi alur login, checkout ganda/retry, keranjang persisten, hapus produk tidak tersedia, edit admin dengan revision guard, dan pembatasan route admin. Verifikasi browser interaktif masih dibatasi dukungan Firefox Windows pada alat computer-use; hasil component/API tidak menggantikan pemeriksaan visual browser penuh.
