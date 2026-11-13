# Lembar praktikum peserta

Gunakan source terbaru pada salinan kerja masing-masing peserta. Sebagian besar fitur sudah diimplementasikan; tugas utama adalah menelusuri, membuktikan perilaku, dan membuat variasi terarah. Paket ini tidak menyediakan branch starter tambahan. Jangan berpindah ke branch prototype lama di tengah praktikum karena kontrak API dan penyimpanannya berbeda.

Contoh CLI utama menggunakan PowerShell. Pada Git Bash/Linux, gunakan client REST atau bentuk curl di bagian akhir. Semua akun/alamat contoh adalah data latihan lokal. Jangan memakai data pelanggan sungguhan.

## Bukti yang dikumpulkan

Untuk setiap latihan, simpan hasil pengamatan: langkah, ID produk/order yang relevan, status HTTP, state sebelum/sesudah, dan penjelasan singkat. Masking password/token/service token pada screenshot. Berkas laporan dapat berupa Markdown; hasil tes JSON berada di `.e2e/`.

## L0 — Menyiapkan baseline

**Waktu:** 20 menit. **Tujuan:** memastikan semua kelompok memakai kontrak terbaru dan lingkungan terisolasi.

1. Masuk ke folder `ecommerce-microservices`.
2. Untuk instalasi baru, jalankan:

   ```bash
   node scripts/setup.mjs --demo-admin
   docker compose up --build -d --wait
   docker compose ps
   ```

3. Jika `.env` sudah ada, setup tidak mengubahnya. Pastikan admin bootstrap memang dikonfigurasi; jangan mengasumsikan password `admin123` masih berlaku. Instruktur dapat menyediakan akun admin kelas secara terpisah.
4. Buka `http://localhost:3000`. Periksa `http://localhost:3000/api/health`.
5. Catat lima service yang berjalan dan tempat masing-masing menyimpan data. Jangan menggunakan `docker compose down -v`; itu menghapus volume data dan signing key.

**Lulus jika:** kelima container healthy dan health agregat menunjukkan status ok. Jika masih start, tunggu readiness; jangan langsung mengubah source.

### Menyiapkan sesi PowerShell

Jalankan satu kali dan lanjutkan latihan pada terminal yang sama:

```powershell
$apiBase = 'http://127.0.0.1:3000/api'
$labRun = [guid]::NewGuid().ToString('N').Substring(0, 8)
$labEmail = "peserta-$labRun@example.test"
$labPassword = 'Latihan-Only-2026!'

$labCredentials = @{ email = $labEmail; password = $labPassword } | ConvertTo-Json
$null = Invoke-RestMethod -Method Post -Uri "$apiBase/auth/register" `
  -ContentType 'application/json' -Body $labCredentials
$buyerSession = Invoke-RestMethod -Method Post -Uri "$apiBase/auth/login" `
  -ContentType 'application/json' -Body $labCredentials
$buyerHeaders = @{ Authorization = "Bearer $($buyerSession.token)" }

# Ganti username di bawah jika admin bootstrap memakai email berbeda.
$adminCredential = Get-Credential -UserName 'admin@inixindo.local' `
  -Message 'Masukkan password admin lokal; jangan tempelkan ke laporan'
$adminBody = @{
  email = $adminCredential.UserName
  password = $adminCredential.GetNetworkCredential().Password
} | ConvertTo-Json
$adminSession = Invoke-RestMethod -Method Post -Uri "$apiBase/auth/login" `
  -ContentType 'application/json' -Body $adminBody
$adminHeaders = @{ Authorization = "Bearer $($adminSession.token)" }
if ($adminSession.user.role -ne 'admin') { throw 'Akun ini bukan admin' }
```

Password contoh hanya untuk akun peserta disposable. Jangan menampilkannya sebagai kredensial admin default. Jangan mencetak variabel sesi karena memuat JWT. Login pada browser menggunakan akun peserta yang sama jika ingin mengamati perubahan dari CLI.

### Dataset produk

```powershell
$fixtureBody = @{ name = "Mug Praktikum $labRun"; price = 25000; stock = 10 } |
  ConvertTo-Json
$createdProduct = Invoke-RestMethod -Method Post -Uri "$apiBase/products" `
  -Headers $adminHeaders -ContentType 'application/json' -Body $fixtureBody
$productId = $createdProduct.product.id
```

Gunakan ID dari respons. Seed produk memakai ID yang berbeda antar database; ID ilustrasi di referensi API bukan fixture otomatis.

## L1 — Membaca dan membuktikan hardening

**Waktu:** 35 menit. **Konsep:** persistensi, race condition, parser, dan batas hashing.

1. Baca `users.ts`, `packages/storage/src/index.ts`, dan schema credentials pada auth-service.
2. Jelaskan lokasi `await bcrypt.hash()` dan mengapa insert email masih perlu constraint unik setelah await.
3. Coba register dengan password 73 karakter ASCII, lalu karakter multibyte yang total UTF-8-nya lebih dari 72 byte. Keduanya harus ditolak 400. Gunakan alamat uji baru, bukan akun admin.
4. Kirim body JSON rusak dan catat respons:

   ```powershell
   try {
     Invoke-RestMethod -Method Post -Uri "$apiBase/auth/login" `
       -ContentType 'application/json' -Body '{'
   } catch { [int]$_.Exception.Response.StatusCode }
   ```

5. Periksa tes `auth.test.ts` untuk registrasi konkuren dan JSON rusak; jangan menghapus seluruh database agar pengujian ini dapat diulang.

**Hasil:** parser memberi 400, bukan 500; validasi batas byte berlaku; constraint database menjadi pertahanan terakhir untuk email unik.

**Pengumpulan:** tabel tiga input invalid beserta status dan alasan penolakan. Untuk eksperimen race asli gunakan tes terisolasi yang disediakan, bukan spam register pada server kelas bersama.

## L2 — CRUD keranjang dan quote

**Waktu:** 40 menit. **Konsep:** state dasar versus data turunan.

```powershell
$cartBefore = (Invoke-RestMethod "$apiBase/cart" -Headers $buyerHeaders).cart
# Versi keranjang dikirim sebagai header If-Match (nilai ETag, termasuk tanda kutip).
$ifMatch = @{ 'If-Match' = "`"$($cartBefore.version)`"" }
$setItemBody = @{ quantity = 2 } | ConvertTo-Json
$cartMutation = Invoke-RestMethod -Method Put -Uri "$apiBase/cart/items/$productId" `
  -Headers ($buyerHeaders + $ifMatch) -ContentType 'application/json' -Body $setItemBody
$cartQuote = (Invoke-RestMethod "$apiBase/cart" -Headers $buyerHeaders).cart
$cartQuote | Select-Object version, quantity, total, canCheckout
```

1. Bandingkan field pada `$cartMutation.cart` dan `$cartQuote`.
2. Pastikan jumlah dua dan total Rp50.000 pada dataset awal.
3. Baca detail produk; stok harus masih sepuluh. Keranjang belum mereservasi stok.
4. Dari UI ubah jumlah menjadi tiga, lalu muat quote lagi. Total harus Rp75.000 jika harga belum diubah.
5. Hapus item dari UI dan amati state kosong. Tambahkan kembali dua unit untuk latihan berikutnya.

**Lulus jika:** jumlah absolut, total quote, badge jumlah unit, dan versi baru sesuai. Token dihapus saat logout; setelah login lagi keranjang pengguna tetap tersedia.

## L3 — Konflik dua tab

**Waktu:** 30 menit. **Konsep:** optimistic concurrency.

```powershell
$snapshotA = (Invoke-RestMethod "$apiBase/cart" -Headers $buyerHeaders).cart
$snapshotB = $snapshotA
$etagA = @{ 'If-Match' = "`"$($snapshotA.version)`"" }
$etagB = @{ 'If-Match' = "`"$($snapshotB.version)`"" }
$null = Invoke-RestMethod -Method Put -Uri "$apiBase/cart/items/$productId" `
  -Headers ($buyerHeaders + $etagA) -ContentType 'application/json' `
  -Body (@{ quantity = 3 } | ConvertTo-Json)

try {
  Invoke-RestMethod -Method Put -Uri "$apiBase/cart/items/$productId" `
    -Headers ($buyerHeaders + $etagB) -ContentType 'application/json' `
    -Body (@{ quantity = 4 } | ConvertTo-Json)
} catch { [int]$_.Exception.Response.StatusCode }
```

**Hasil:** request A berhasil; B ditolak 412 (`Precondition Failed`). Ulangi B tanpa header `If-Match` dan amati 428 (`Precondition Required`). GET ulang menunjukkan jumlah tiga, bukan empat. Jelaskan bahwa mengambil snapshot sama dengan dua variabel sudah cukup untuk membuktikan precondition versi, tanpa mengandalkan kecepatan klik dua browser.

**Tugas variasi:** sesuaikan jumlah kembali menjadi dua memakai versi terbaru. Jangan menonaktifkan pemeriksaan version agar B “berhasil”.

## L4 — Checkout dan snapshot transaksi

**Waktu:** 50 menit. **Konsep:** satu keputusan belanja, satu alokasi stok.

Ambil quote terbaru dengan dua unit produk awal:

```powershell
$checkoutSnapshot = (Invoke-RestMethod "$apiBase/cart" -Headers $buyerHeaders).cart
$shippingFixture = @{
  recipient = "Peserta $labRun"
  phone = '081234567890'
  street = 'Jalan Latihan Nomor 123'
  city = 'Bandung'
  province = 'Jawa Barat'
  postalCode = '40123'
  notes = 'Hubungi penerima saat tiba'
}
$checkoutBody = @{
  version = $checkoutSnapshot.version
  shippingAddress = $shippingFixture
} | ConvertTo-Json -Depth 6
$checkoutKey = [guid]::NewGuid().ToString()
$checkoutHeaders = @{
  Authorization = $buyerHeaders.Authorization
  'Idempotency-Key' = $checkoutKey
}
$checkoutResult = Invoke-RestMethod -Method Post -Uri "$apiBase/cart/checkout" `
  -Headers $checkoutHeaders -ContentType 'application/json' -Body $checkoutBody
$orderId = $checkoutResult.order.id
$checkoutResult.order | Select-Object id, status, fulfillmentStatus, total
```

1. Pastikan status CONFIRMED, fulfillment NEW, total Rp50.000, dan stok tersedia menjadi delapan jika dataset belum dipakai transaksi lain.
2. Keranjang asal harus kosong bila versinya tidak berubah selama checkout.
3. Ulangi request dengan `$checkoutHeaders` dan `$checkoutBody` yang sama. ID harus sama dan stok tetap delapan.
4. Ganti hanya key dengan UUID lain, tetap gunakan body/versi lama. ID juga harus sama. Simpan key alternatif untuk pengamatan larangan reuse pada checkout berikutnya.
5. Ganti alamat pada body versi lama; server harus menolak konflik 409.
6. Ubah harga katalog menggunakan admin dan revisi terbaru, kemudian GET detail order. Total order lama tetap Rp50.000.

**Pengumpulan:** ID dari dua replay, stok sebelum/sesudah, dan penjelasan perbedaan version, key, dan reservation ID. Jangan menyimpulkan seluruh JSON replay selalu sama setelah admin mengubah fulfillment.

## L5 — Stok kurang, produk hilang, dan percobaan baru

**Waktu:** 35 menit. **Konsep:** penolakan definitif berbeda dengan hasil belum pasti.

1. Buat produk latihan baru dengan stok satu. Simpan ID terpisah agar dataset L4 tidak berubah.
2. Set keranjang berisi dua unit. GET harus memberi `canCheckout: false`; UI menonaktifkan konfirmasi.
3. Melalui API kirim checkout snapshot itu. Backend tetap menolak 409 walaupun pembatasan UI dilewati.
4. Periksa keranjang: item tetap ada dan versinya diperbarui setelah order definitif FAILED. Stok tetap satu.
5. Restock menjadi dua melalui admin dengan revisi terkini. GET quote/versi baru, buat key baru, dan coba lagi. Checkout sekarang dapat berhasil. Replay versi lama tetap merepresentasikan attempt gagal.
6. Pada produk disposable lain, tambahkan ke cart lalu hapus dari katalog. GET cart menandai unavailable; pelanggan masih bisa menghapus item itu.

**Lulus jika:** tidak terjadi stok negatif, penolakan tidak mengosongkan isi, dan percobaan baru memakai state terbaru. Jangan memakai key baru dengan versi checkout lama lalu menganggap itu operasi baru.

## L6 — Riwayat, ownership, dan alur admin

**Waktu:** 50 menit. **Konsep:** hak akses dan dua sumbu status.

1. Login akun peserta A, buka Pesanan saya, filter CONFIRMED, dan buka detail order L4.
2. Buat akun peserta B. Dengan token B, akses ID order A melalui API. Hasil harus 404; daftar B tidak berisi order A.
3. Dengan token A, akses `/orders/admin` atau PATCH fulfillment. Hasil harus 403.
4. Login admin di browser lain/profil terpisah. Cari berdasarkan ID atau nama penerima.
5. Coba langsung menandai NEW menjadi COMPLETED melalui API: 409.
6. Jalankan transisi yang sah:

   ```powershell
   $fulfillmentBody = @{ status = 'PROCESSING' } | ConvertTo-Json
   $null = Invoke-RestMethod -Method Patch `
     -Uri "$apiBase/orders/admin/$orderId/fulfillment" -Headers $adminHeaders `
     -ContentType 'application/json' -Body $fulfillmentBody
   ```

7. Ulangi PROCESSING; tetap berhasil. Lanjutkan COMPLETED; kemudian coba mundur ke PROCESSING: 409.
8. Muat ulang detail sebagai pelanggan A. Fulfillment harus sesuai perubahan admin, sedangkan status order tetap CONFIRMED.

**Pengumpulan:** matriks user A/user B/admin versus endpoint. Jelaskan mengapa 404 pada order orang lain berbeda tujuan dengan 403 pada endpoint admin.

## L7 — Form stok lama dan revision guard

**Waktu:** 30 menit. **Konsep:** mencegah lost update stok melalui admin.

1. Buat produk baru stok lima; buka form Edit di dashboard admin dan catat revisinya melalui API.
2. Dari pelanggan, checkout dua unit produk itu sehingga stok tersedia menjadi tiga.
3. Simpan form admin lama dengan expectedRevision lama. Server harus menolak 409 PRODUCT_CHANGED; stok tidak boleh kembali ke lima.
4. Muat ulang data produk dan buka ulang form Edit agar revisi terbaru ikut dikirim. Lakukan perubahan yang memang diinginkan.

**Catatan:** memuat ulang daftar saja tidak berarti formulir lama telah memperoleh revisi baru. Tutup dan buka ulang form berdasarkan data terbaru. API lama masih mengizinkan update tanpa expectedRevision; bandingkan sebagai diskusi, bukan cara melewati pengaman pada tugas akhir.

## L8 — Header, footer, dan navigasi aksesibel

**Waktu:** 40 menit. **Konsep:** layout, fokus, dan navigasi sesuai role.

1. Buka DevTools browser dan uji lebar 320, 768, serta 1280 px. Di bawah xl gunakan menu lipat; pada xl menu desktop tampil.
2. Periksa tidak ada scroll horizontal yang disebabkan header/footer. Cari sumber ukuran elemen bila ada, bukan langsung menyembunyikan overflow body.
3. Buka menu mobile, pilih tautan, lalu pastikan menu menutup. Tekan Escape dari dalam menu dan periksa fokus kembali ke toggle.
4. Gunakan Tab dari awal halaman untuk menemukan Langsung ke konten. Aktifkan dan periksa target main-content.
5. Bandingkan navigasi pelanggan dengan admin. Footer tidak menyediakan bypass akses backend.
6. Tinjau source pemakaian object-contain, dimensi logo, aria-expanded, aria-controls, useId, dan penutupan menu pada perubahan pathname.

**Pengumpulan:** tiga screenshot viewport, urutan fokus yang diamati, dan satu penjelasan mengapa banner footer lama membuat layout melebar. Pengujian visual ini dilakukan peserta di browser yang mendukung; baseline tes komponen bukan bukti bahwa seluruh viewport telah diperiksa otomatis.

## L9 — Recovery, tes otomatis, dan laporan akhir

**Waktu:** 70 menit. **Konsep:** menguji invariant saat jaringan/proses gagal.

1. Pada lingkungan uji, isi cart dengan produk berstok cukup dan simpan versi, body, serta key.
2. Hentikan product-service, kirim checkout, dan amati 503; jangan menyatakan stok pasti belum teralokasi hanya dari kode tersebut.
3. Hidupkan service kembali, tunggu health ok, lalu periksa riwayat/detail. Ulangi request **lama** jika hasil belum jelas. Worker dapat lebih dulu menyelesaikan order itu.
4. Untuk skenario restart setelah pending, gunakan suite shopping yang menyimpan urutan dan pemeriksaan stok:

   ```bash
   node scripts/e2e-shopping.mjs --chaos
   ```

5. Jalankan tes workspace setelah dependency host terpasang dan shared package dibangun:

   ```bash
   npm ci
   npm run build:packages
   npm test
   npm run typecheck
   npm run lint
   node scripts/e2e.mjs --chaos
   node scripts/e2e-shopping.mjs --chaos
   ```

6. Bandingkan `.e2e/results.json` dan `.e2e/shopping-results.json`. Opsi chaos menghentikan/restart service proyek ini; jangan jalankan pada sistem yang sedang dipakai pelanggan. Suite shopping mengikuti Retry-After bila kuota habis.
7. Ambil backup konsisten untuk salah satu service:

   ```bash
   docker compose exec order-service node /app/scripts/backup.ts order /app/data/backups
   ```

8. Jelaskan mengapa backup pada volume yang sama masih perlu disalin ke lokasi di luar host.

**Lulus jika:** satu snapshot menghasilkan satu order, pengulangan receipt tidak mengurangi stok lagi, restart tidak menghilangkan data, dan role/ownership tetap diberlakukan setelah pemulihan.

## Bentuk curl untuk client selain PowerShell

Contoh berikut menggunakan Bash, bukan alias curl milik Windows PowerShell. Ganti placeholder secara lokal dan jangan commit token yang telah diisi.

```bash
API_BASE='http://127.0.0.1:3000/api'
BUYER_TOKEN='<TOKEN_HASIL_LOGIN>'
PRODUCT_ID='<UUID_PRODUK_AKTUAL>'
CART_VERSION='<UUID_VERSI_AKTUAL>'

curl -sS "$API_BASE/cart" -H "Authorization: Bearer $BUYER_TOKEN"
curl -sS -X PUT "$API_BASE/cart/items/$PRODUCT_ID" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{\"quantity\":2,\"version\":\"$CART_VERSION\"}"
```

Gunakan GET ulang untuk quote dan version terbaru sebelum checkout. Referensi seluruh payload tersedia pada [referensi API](03-referensi-api.md).

## Format laporan peserta

```text
Nama/kelompok:
Revisi source yang dipakai:
Tanggal dan lingkungan:
Dataset disposable:

Untuk tiap L0-L9:
- Tujuan dan langkah yang dilakukan
- Bukti status HTTP / state / hasil tes
- Hasil dibandingkan ekspektasi
- Penjelasan invariant yang dipertahankan
- Kendala, perbaikan, dan batas pengujian

Kesimpulan: fitur yang tersedia versus pengembangan lanjut
```

Sesudah kelas, hapus produk disposable melalui admin bila tidak diperlukan. Order uji tetap menjadi riwayat; aplikasi belum menyediakan penghapusan akun/order. Jangan membersihkan seluruh volume hanya untuk menghilangkan data praktikum pada lingkungan yang berisi data lain.
