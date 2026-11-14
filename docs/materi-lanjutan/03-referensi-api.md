# Referensi API untuk modul tambahan

Dokumen ini mengikuti route dan schema source saat paket disusun. Contoh UUID, akun, alamat, token, waktu, dan jumlah adalah data ilustrasi. Ganti ID/versi dengan hasil request aktual; nilai ilustrasi tidak otomatis ada dalam database.

## Konvensi akses

- Base URL melalui nginx: `http://127.0.0.1:3000/api/v1` (versi API saat ini).
- Base URL gateway langsung untuk diagnosis lokal: `http://127.0.0.1:8080/v1`.
- Endpoint di bawah relatif terhadap base URL; jangan menambahkan `/api` atau `/v1` dua kali.
- Spesifikasi mesin (OpenAPI 3.1): `GET /openapi.json` di base URL, sumbernya [`services/gateway/openapi.json`](../../services/gateway/openapi.json). Spesifikasi dibangkitkan dengan `npm run openapi` dan diperiksa CI dengan `npm run openapi:check`; jangan diedit manual. Buka di Swagger Editor, Postman, atau Insomnia untuk mencoba endpoint.
- Body JSON memakai `Content-Type: application/json`. Request DELETE tidak memakai body.
- Endpoint privat memakai `Authorization: Bearer <TOKEN>`.
- Correlation ID opsional pada request harus berupa 1–128 karakter `[A-Za-z0-9_-]`; nilai tidak sesuai diganti gateway.
- Contoh tidak memuat kredensial nyata. Jangan menaruh token atau password admin pada berkas materi.

### Versi API dan jalur lama

Jalur tanpa versi (`/api/products`, `/api/orders`, ...) masih dilayani dengan perilaku yang sama sampai **14 Mei 2027**, tetapi setiap responsnya membawa:

```http
Deprecation: @1794614400
Sunset: Fri, 14 May 2027 00:00:00 GMT
Link: </api/v1/products>; rel="successor-version"
```

`Deprecation` memakai format tanggal RFC 9745 (detik sejak epoch), `Sunset` mengikuti RFC 8594. Klien baru wajib memakai `/api/v1`. Versi yang tidak dikenal, misalnya `/api/v2/...`, dijawab 404. Health agregat tersedia di `/api/v1/health` dan, untuk healthcheck container, di `/api/health`.

## Daftar endpoint

| Metode | Path                            | Akses           |    Sukses | Keterangan                                      |
| ------ | ------------------------------- | --------------- | --------: | ----------------------------------------------- |
| GET    | `/health`                       | Publik          | 200 / 503 | Status agregat; 503 berarti degraded            |
| GET    | `/openapi.json`                 | Publik          |       200 | Spesifikasi OpenAPI 3.1 API ini                 |
| POST   | `/auth/register`                | Publik          |       201 | Role hasil register selalu user                 |
| POST   | `/auth/login`                   | Publik          |       200 | Access token + cookie refresh HttpOnly          |
| POST   | `/auth/refresh`                 | Cookie + header |       200 | Rotasi refresh token, access token baru         |
| POST   | `/auth/logout`                  | Cookie + header |       204 | Mencabut sesi refresh di server                 |
| GET    | `/auth/me`                      | JWT             |       200 | Profil subject token                            |
| GET    | `/auth/.well-known/jwks.json`   | Publik          |       200 | Public key; prefix `/auth` dihapus gateway      |
| GET    | `/products`                     | Publik          |       200 | Katalog, pencarian, pagination, atau lookup ID  |
| GET    | `/products/:id`                 | Publik          |       200 | Detail produk                                   |
| POST   | `/products`                     | Admin           |       201 | Tambah produk                                   |
| PUT    | `/products/:id`                 | Admin           |       200 | Update parsial, opsional expectedRevision       |
| DELETE | `/products/:id`                 | Admin           |       204 | Hapus produk                                    |
| GET    | `/products/admin/summary`       | Admin           |       200 | Ringkasan produk/stok                           |
| GET    | `/cart`                         | JWT             |       200 | Keranjang dengan quote produk                   |
| PUT    | `/cart/items/:id`               | JWT + If-Match  |       200 | Set jumlah absolut                              |
| DELETE | `/cart/items/:id`               | JWT + If-Match  |       200 | Hapus satu produk                               |
| DELETE | `/cart`                         | JWT + If-Match  |       204 | Kosongkan keranjang                             |
| POST   | `/cart/checkout`                | JWT + key       |       201 | Checkout snapshot keranjang                     |
| POST   | `/orders`                       | JWT + key       |       201 | API order lama, tanpa keranjang/alamat          |
| GET    | `/orders`                       | JWT             |       200 | Daftar order milik pengguna, offset atau cursor |
| GET    | `/orders/:id`                   | JWT + ownership |       200 | Detail milik pengguna                           |
| POST   | `/orders/:id/cancel`            | JWT + ownership | 200 / 202 | Batalkan selama fulfillment masih NEW           |
| GET    | `/orders/admin`                 | Admin           |       200 | Daftar seluruh order                            |
| GET    | `/orders/admin/summary`         | Admin           |       200 | Ringkasan order                                 |
| GET    | `/orders/admin/:id`             | Admin           |       200 | Detail order lintas pengguna                    |
| PATCH  | `/orders/admin/:id/fulfillment` | Admin           |       200 | Perubahan proses operasional                    |
| POST   | `/orders/admin/:id/cancel`      | Admin           | 200 / 202 | Batalkan order yang belum COMPLETED             |

Endpoint internal `POST /internal/reservations/:id` berada pada product-service, bukan route publik gateway. Order-service memanggilnya melalui network Docker dengan `x-service-token`. Ia bukan endpoint yang dipanggil langsung dari React. Order-service juga menyertakan token yang sama saat membaca katalog untuk keranjang (`GET /products?ids=`): seluruh pengguna dilayani dari satu alamat IP order-service, sehingga tanpa bukti service-ke-service itu kuota rate-limit per-IP product-service akan dipakai bersama oleh semua keranjang. Gateway membuang header `x-service-token` yang dikirim klien publik, dan route yang tidak dikenal gateway dijawab 404 `NOT_FOUND` dengan bentuk error yang sama.

## Autentikasi

Register dan login memakai bentuk body yang sama:

```json
{ "email": "peserta@example.test", "password": "Latihan-Only-2026!" }
```

Email dinormalisasi dan maksimal 254 karakter. Password minimal 8 karakter dan maksimal 72 byte UTF-8. Field role yang ditambahkan pada register tidak menjadikan akun admin.

Respons login:

```json
{
  "token": "<JWT_DARI_SERVER>",
  "user": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "email": "peserta@example.test",
    "role": "user"
  }
}
```

Minimum panjang password mengikuti panjang string JavaScript pada validator, bukan jumlah grapheme visual. Batas maksimum dihitung sebagai byte UTF-8.

Respons login juga berisi `expiresIn` (detik) dan header `Set-Cookie` untuk refresh token. Respons token selalu `Cache-Control: no-store`.

### Sesi: access token dan refresh token

| Token         | Bentuk                                             | Umur                                        | Disimpan di                |
| ------------- | -------------------------------------------------- | ------------------------------------------- | -------------------------- |
| Access token  | JWT RS256, dikirim sebagai `Authorization: Bearer` | 15 menit (`JWT_EXPIRES_IN_SECONDS`)         | Memory aplikasi React saja |
| Refresh token | Opaque acak; server hanya menyimpan hash SHA-256   | 7 hari sejak rotasi terakhir, maks. 30 hari | Cookie `refresh_token`     |

Atribut cookie: `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`. JavaScript tidak dapat membacanya dan browser hanya mengirimnya ke endpoint auth.

`POST /auth/refresh` dan `POST /auth/logout` memakai cookie tersebut, sehingga keduanya wajib membawa header `X-Requested-With` (nilai bebas). Bila browser mengirim `Origin`, nilainya harus termasuk `REFRESH_ALLOWED_ORIGINS`; selain itu dijawab 403 `CSRF_REJECTED`.

- Refresh berhasil mengembalikan `{token,user,expiresIn}` dan cookie baru. Cookie lama tidak berlaku lagi (rotasi).
- Cookie lama yang dipakai lagi dalam 10 detik setelah rotasi dijawab 409 `REFRESH_RACE` tanpa mencabut sesi, karena itu biasanya tab lain yang me-refresh bersamaan. Klien cukup mengulang sekali.
- Cookie lama yang dipakai lagi setelah itu dianggap dicuri: seluruh sesi dicabut dan dijawab 401 `REFRESH_REUSED`.
- Logout mencabut sesi dan menghapus cookie. Access token yang sudah terbit tetap valid sampai kedaluwarsa, paling lama 15 menit.
- Saat halaman dimuat, frontend memulihkan sesi lewat refresh, lalu memperbarui access token 60 detik sebelum kedaluwarsa.

### Pembatasan login

Selain limit per IP (20/menit untuk login dan register), setiap email mendapat jeda setelah lima kegagalan berturut-turut: 30 detik, lalu dua kali lipat per kegagalan berikutnya sampai 15 menit. Selama jeda, login dijawab 429 `LOGIN_THROTTLED` dengan `Retry-After`, termasuk bila password benar. Email yang tidak terdaftar diperlakukan sama. Penghitung direset setelah login berhasil atau 15 menit tanpa kegagalan.

## Produk

Body create:

```json
{ "name": "Mug Praktikum", "price": 25000, "stock": 10 }
```

| Field            | Aturan                                           |
| ---------------- | ------------------------------------------------ |
| name             | String 1–200 karakter; form admin melakukan trim |
| price            | Integer rupiah, positif, maksimal 1.000.000.000  |
| stock            | Integer 0–1.000.000; default create adalah 0     |
| expectedRevision | Hanya update; integer nonnegatif, opsional       |

Create menghasilkan `{ "product": {...} }`, termasuk ID dan revision. Update memerlukan minimal satu field bisnis; body yang hanya berisi `expectedRevision` tidak cukup.

```http
PUT /products/11111111-1111-4111-8111-111111111111
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{"price":30000,"expectedRevision":1}
```

Jika revisi aktual sudah berubah, respons 409 `PRODUCT_CHANGED`. Client admin sebaiknya selalu mengirim revisi yang dibaca. Field ini opsional pada API untuk kompatibilitas, sehingga PUT tanpa field itu tidak menjalankan pemeriksaan revisi.

Query katalog:

| Parameter | Default dan batas                                                          |
| --------- | -------------------------------------------------------------------------- |
| q         | String pencarian nama, maksimal 100 karakter; tidak peka huruf besar/kecil |
| offset    | 0, integer nonnegatif                                                      |
| limit     | 100, integer 1–100; UI meminta 20                                          |
| ids       | Alternatif lookup: 1–50 UUID dipisah koma, string maksimal 2000 karakter   |

Respons katalog normal adalah `{products,total,offset,limit}`. Mode `ids` menghasilkan `{products}` saja, mengabaikan pencarian/pagination normal, dan menghilangkan ID yang tidak ditemukan dari array hasil.

Ringkasan produk:

```json
{ "totalProducts": 3, "lowStock": 1, "outOfStock": 1 }
```

`lowStock` menghitung produk dengan stok 1–5; `outOfStock` menghitung stok 0.

## Keranjang

`GET /cart` mengembalikan data turunan yang lebih lengkap daripada mutasi:

```json
{
  "cart": {
    "version": "22222222-2222-4222-8222-222222222222",
    "items": [
      {
        "productId": "11111111-1111-4111-8111-111111111111",
        "quantity": 2,
        "name": "Mug Praktikum",
        "unitPrice": 25000,
        "stock": 10,
        "available": true,
        "subtotal": 50000
      }
    ],
    "updatedAt": "2026-11-13T08:00:00.000Z",
    "total": 50000,
    "quantity": 2,
    "canCheckout": true
  }
}
```

Keranjang kosong memiliki `items: []`, total/jumlah 0, dan `canCheckout: false`. Produk yang hilang diberi nama fallback, harga/stok 0, dan available false; penanda tersebut bukan tawaran membeli produk dengan harga nol.

### Concurrency: ETag dan If-Match

`GET /cart` dan setiap mutasi keranjang mengirim header `ETag: "<version>"` dan `Cache-Control: no-store`. Setiap perubahan wajib mengirim balik versi itu sebagai `If-Match`:

```http
PUT /api/v1/cart/items/11111111-1111-4111-8111-111111111111
If-Match: "22222222-2222-4222-8222-222222222222"
Content-Type: application/json

{ "quantity": 2 }
```

| Kondisi                                | Status | Code                  |
| -------------------------------------- | -----: | --------------------- |
| Versi cocok                            |    200 | —                     |
| Versi sudah berubah                    |    412 | CART_CHANGED          |
| Header `If-Match` tidak ada            |    428 | PRECONDITION_REQUIRED |
| Format `If-Match` bukan satu ETag UUID |    400 | INVALID_PRECONDITION  |

`DELETE /cart/items/:id` dan `DELETE /cart` tidak memakai body sama sekali.

Jumlah 1–1000 dan ID produk UUID. Maksimal 50 produk berbeda. `PUT quantity=2` berarti jumlah akhir dua, bukan menambah dua.

**Jalur lama (deprecated).** Selama masa transisi, `version` di body masih diterima bila `If-Match` tidak dikirim. Respons jalur ini membawa header `Deprecation` (format RFC 9745, mis. `@1794614400`), dan konflik tetap dijawab 409 seperti sebelumnya. Jalur ini akan dihapus; klien baru wajib memakai `If-Match`.

PUT dan DELETE item menghasilkan `{cart:{version,items,updatedAt}}` berisi **record dasar**, bukan quote lengkap. Ambil ETag dari respons mutasi untuk perubahan berikutnya, lalu panggil GET untuk subtotal, stok, dan canCheckout. Setiap mutasi menghasilkan versi baru, bahkan ketika jumlah yang diset sama.

## Checkout

Header wajib `Idempotency-Key`: 8–128 karakter `[A-Za-z0-9_-]`. UUID dari klien memenuhi pola ini. Simpan key, version, dan body yang sama saat mengulang hasil yang belum pasti.

Server mengingat key selama 24 jam (`IDEMPOTENCY_RETENTION_HOURS`) setelah order-nya berstatus akhir (CONFIRMED, FAILED, atau CANCELLED). Key milik order yang masih PENDING atau sedang dibatalkan tidak pernah dilupakan. Setelah masa itu, key yang sama diperlakukan sebagai permintaan baru.

```json
{
  "version": "22222222-2222-4222-8222-222222222222",
  "shippingAddress": {
    "recipient": "Peserta Praktikum",
    "phone": "081234567890",
    "street": "Jalan Latihan Nomor 123",
    "city": "Bandung",
    "province": "Jawa Barat",
    "postalCode": "40123",
    "notes": "Hubungi penerima saat tiba"
  }
}
```

| Field alamat    | Validasi setelah trim                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| recipient       | 2–100 karakter                                                                                 |
| phone           | 8–24 karakter dalam himpunan `+`, digit, kurung, spasi, atau `-`; bukan verifikasi nomor aktif |
| street          | 5–300 karakter                                                                                 |
| city / province | Masing-masing 2–100 karakter                                                                   |
| postalCode      | Tepat 5 digit                                                                                  |
| notes           | Maksimal 500 karakter; default string kosong                                                   |

Client tidak mengirim harga atau total yang dipercaya server. Isi order berasal dari snapshot keranjang dan receipt product-service. Satu versi keranjang tidak membuat order tambahan saat dikirim dengan key lain. Key alternatif juga terikat pada versi asal. Alamat berbeda pada checkout yang sama menghasilkan konflik.

Respons sukses dan replay memakai HTTP 201 dengan `{order}`. Yang dijamin sama adalah identitas transaksi dan alokasi stoknya; jangan mengandalkan seluruh JSON akan identik selamanya karena fulfillment dapat berubah kemudian.

## Representasi order

```json
{
  "order": {
    "id": "33333333-3333-4333-8333-333333333333",
    "userId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "items": [
      {
        "productId": "11111111-1111-4111-8111-111111111111",
        "name": "Mug Praktikum",
        "unitPrice": 25000,
        "quantity": 2,
        "subtotal": 50000
      }
    ],
    "total": 50000,
    "status": "CONFIRMED",
    "createdAt": "2026-11-13T08:00:00.000Z",
    "updatedAt": "2026-11-13T08:00:00.000Z",
    "cartVersion": "22222222-2222-4222-8222-222222222222",
    "shippingAddress": {
      "recipient": "Peserta Praktikum",
      "phone": "081234567890",
      "street": "Jalan Latihan Nomor 123",
      "city": "Bandung",
      "province": "Jawa Barat",
      "postalCode": "40123",
      "notes": ""
    },
    "fulfillmentStatus": "NEW"
  }
}
```

Order yang dibatalkan menambahkan `cancelledBy` (`customer` atau `admin`), `cancelReason` (opsional), dan `cancelledAt`.

Order PENDING dapat belum memiliki line item final dan totalnya masih 0. Order FAILED yang ditolak sebelum receipt juga dapat demikian. Total 0 pada kondisi itu bukan transaksi gratis. Order lama dapat tidak memiliki alamat/cartVersion; representasi publik memberi fallback fulfillment NEW dan updatedAt dari createdAt jika field lama belum ada.

API lama `POST /orders` menerima `{items:[{productId,quantity}]}` dengan 1–50 baris dan quantity 1–1000. Ia tetap memerlukan key, menggabungkan produk duplikat, dan menggunakan reservasi yang sama. Ia tidak memotong/mengosongkan keranjang serta tidak menerima alur alamat checkout.

### Batas tahan stok per pelanggan

Checkout dan `POST /orders` menolak order baru bila pelanggan sudah memegang terlalu banyak stok dalam **pesanan aktif** (PENDING atau CONFIRMED yang fulfillment-nya belum COMPLETED):

| Batas                         | Bawaan | Environment order-service     |
| ----------------------------- | -----: | ----------------------------- |
| Pesanan aktif per pelanggan   |      5 | `ORDER_MAX_OPEN_ORDERS`       |
| Unit satu produk, semua aktif |     10 | `ORDER_MAX_UNITS_PER_PRODUCT` |

Penolakan dijawab `409 HOLD_LIMIT_EXCEEDED` tanpa mengurangi stok:

```json
{
  "error": {
    "message": "Maksimal 10 unit per produk dalam pesanan aktif.",
    "code": "HOLD_LIMIT_EXCEEDED",
    "details": { "productId": "…", "limit": 10, "held": 6, "requested": 5 }
  }
}
```

Untuk batas jumlah pesanan, `details` berisi `{ limit, open }`. Retry dengan Idempotency-Key yang sudah menghasilkan order tidak pernah ditolak batas ini. Membatalkan pesanan atau menyelesaikannya (COMPLETED) mengembalikan jatah.

## Daftar, detail, dan admin

`GET /orders` serta `/orders/admin` mendukung:

| Query  | Aturan                                                                              |
| ------ | ----------------------------------------------------------------------------------- |
| offset | Default 0, integer 0–10000; untuk halaman bernomor                                  |
| cursor | Opsional; nilai `nextCursor` dari halaman sebelumnya. Tidak boleh digabung `offset` |
| limit  | Default 20, integer 1–100                                                           |
| status | Opsional PENDING, CONFIRMED, FAILED, CANCELLATION_REQUESTED, atau CANCELLED         |
| q      | Maksimal 100 karakter; substring ID atau penerima, tidak peka huruf besar/kecil     |

Hasil `{orders,total,offset,limit,nextCursor}` diurutkan createdAt terbaru, lalu ID sebagai pembanding berikutnya. `nextCursor` bernilai `null` pada halaman terakhir. Cursor (pagination keyset) tetap stabil ketika order baru masuk di antara dua halaman; offset dapat menampilkan order yang sama dua kali dalam kondisi itu. Cursor yang rusak dijawab 400 `INVALID_CURSOR`. Query pelanggan selalu ditambah filter user ID dari token. Detail order bukan milik pengguna menghasilkan 404.

Ringkasan admin order mempunyai `totalOrders`, `confirmedOrders`, `pendingOrders`, `failedOrders`, `cancelledOrders`, `confirmedValue`, dan `processingOrders`. Nilainya agregat seluruh data pada service, termasuk akun/order praktikum yang belum dibersihkan. confirmedValue bukan laporan pembayaran.

Fulfillment:

```json
{ "status": "PROCESSING" }
```

PATCH hanya menerima PROCESSING atau COMPLETED, hanya untuk order CONFIRMED. NEW → PROCESSING → COMPLETED; pengulangan state yang sama berhasil, lompat/mundur ditolak 409. Respons `{order}`. Beberapa penolakan domain fulfillment memakai kode umum APP_ERROR, bukan kode khusus per transisi.

### Pembatalan

`POST /orders/:id/cancel` (pemilik) dan `POST /orders/admin/:id/cancel` (admin) menerima body opsional `{ "reason": "maks. 200 karakter" }`.

| Pemanggil | Boleh membatalkan                                                  |
| --------- | ------------------------------------------------------------------ |
| Pelanggan | Order miliknya yang PENDING, atau CONFIRMED dengan fulfillment NEW |
| Admin     | Order PENDING atau CONFIRMED yang fulfillment-nya belum COMPLETED  |

Pembatalan adalah saga dengan kompensasi. Niat batal disimpan dulu sebagai `CANCELLATION_REQUESTED`, lalu order-service meminta product-service mengembalikan stok.

- **200** dengan status `CANCELLED`: stok sudah dikembalikan.
- **202** dengan status `CANCELLATION_REQUESTED`: product-service sedang tidak terjangkau. Niat batal sudah tersimpan dan diselesaikan otomatis oleh proses recovery (setiap 10 detik).
- Mengulang pembatalan aman: order yang sudah dibatalkan dijawab 200 tanpa mengembalikan stok dua kali.
- Order FAILED, COMPLETED, atau (bagi pelanggan) yang sudah diproses dijawab 409 `ORDER_NOT_CANCELLABLE`. Order milik orang lain dijawab 404.
- Order yang dibatalkan tidak bisa diproses fulfillment. Checkout yang dibatalkan sebelum terkonfirmasi mengembalikan keranjang ke versi baru dengan item tetap utuh.

## Penanganan error

```json
{ "error": { "message": "Keranjang berubah. Muat ulang dahulu.", "code": "CART_CHANGED" } }
```

Error validasi dapat mempunyai `details` berupa array `{path,message}`. Jangan mendasarkan logika client pada teks message yang mungkin berubah. Tidak setiap 409 mempunyai code yang sama.

| HTTP | Code yang dapat dijumpai                           | Penanganan                                                                        |
| ---: | -------------------------------------------------- | --------------------------------------------------------------------------------- |
|  400 | VALIDATION_ERROR, EMPTY_CART                       | Perbaiki body/header/query; key hilang pada route dipetakan sebagai validasi      |
|  400 | INVALID_JSON / INVALID_REQUEST                     | Benahi JSON; code dapat berbeda sesuai lapisan parser                             |
|  400 | INVALID_PRECONDITION                               | Kirim `If-Match` berisi satu ETag dari respons keranjang terakhir                 |
|  400 | INVALID_CURSOR                                     | Pakai `nextCursor` apa adanya; mulai lagi dari halaman pertama bila hilang        |
|  401 | APP_ERROR, INVALID_CREDENTIALS, INVALID_SESSION    | Login ulang atau perbaiki token; code berbeda menurut asal                        |
|  401 | INVALID_REFRESH, REFRESH_REUSED                    | Sesi berakhir atau dicabut; arahkan pengguna ke halaman login                     |
|  403 | FORBIDDEN                                          | Gunakan role yang sesuai; bukan masalah password biasa                            |
|  403 | CSRF_REJECTED                                      | Endpoint sesi dipanggil tanpa `X-Requested-With` atau dari origin asing           |
|  404 | NOT_FOUND                                          | Resource hilang atau order tidak dimiliki pengguna                                |
|  409 | CART_CHANGED                                       | GET keranjang lagi sebelum memutuskan mutasi                                      |
|  409 | PRODUCT_CHANGED                                    | Muat ulang produk/revisi sebelum menyimpan form admin                             |
|  409 | CHECKOUT_CONFLICT                                  | Alamat berbeda untuk versi checkout yang sudah dipakai                            |
|  409 | IDEMPOTENCY_CONFLICT                               | Key dipakai untuk operasi/versi lain                                              |
|  409 | OUT_OF_STOCK / ORDER_REJECTED                      | Periksa stok dan hasil attempt; percobaan baru memakai versi terbaru              |
|  409 | APP_ERROR                                          | Contohnya urutan fulfillment tidak valid                                          |
|  409 | ORDER_NOT_CANCELLABLE                              | Order sudah ditolak, selesai, atau sudah diproses (pelanggan)                     |
|  409 | HOLD_LIMIT_EXCEEDED                                | Batas tahan per pelanggan; tunggu pesanan selesai, batalkan, atau kurangi jumlah  |
|  409 | REFRESH_RACE                                       | Tab lain baru saja me-refresh sesi; ulangi refresh sekali                         |
|  412 | CART_CHANGED                                       | ETag keranjang sudah usang; GET keranjang lagi lalu ulangi dengan ETag baru       |
|  413 | PAYLOAD_TOO_LARGE                                  | Kurangi payload; JSON service dibatasi sekitar 100 KiB                            |
|  428 | PRECONDITION_REQUIRED                              | Mutasi keranjang wajib membawa `If-Match`                                         |
|  429 | RATE_LIMITED                                       | Ikuti Retry-After; jangan membuat loop request tanpa jeda                         |
|  429 | LOGIN_THROTTLED                                    | Terlalu banyak password salah untuk email ini; tunggu sesuai Retry-After          |
|  502 | UPSTREAM_CONTRACT / UPSTREAM_ERROR / APP_ERROR     | Kontrak/respons downstream tidak sesuai; hasil transaksi mungkin belum final      |
|  503 | UPSTREAM_UNAVAILABLE, OVERLOADED, AUTH_UNAVAILABLE | Tunggu pemulihan dan ulangi identitas operasi yang sama bila hasil belum pasti    |
|  504 | UPSTREAM_TIMEOUT                                   | Service di balik gateway tidak menjawab tepat waktu; ulangi dengan identitas sama |

Gateway bisa memakai GATEWAY_ERROR untuk error yang ditangani di lapisannya. 5xx tidak otomatis berarti stok belum berkurang; periksa detail/riwayat dan ulangi checkout lama dengan identitas yang sama.

## Reservasi internal

Product-service menerima ID reservasi UUID, service token, serta batch item. Quantity internal maksimal 50.000 per baris untuk mengakomodasi hasil penggabungan input lama; batas baris 50. Route publik checkout dan cart tetap memakai batas quantity 1000 per produk.

Product menyimpan receipt dengan fingerprint item, snapshot line, dan total. ID sama dengan fingerprint berbeda ditolak.

`POST /internal/reservations/:id/release` (service token) mengembalikan stok sebuah receipt dalam satu transaksi dan menandainya `RELEASED`. Pemanggilan ulang tidak menambah stok lagi. Bila ID belum punya receipt, product-service mencatat _tombstone_: request reservasi untuk ID itu yang datang terlambat ditolak 409 `RESERVATION_RELEASED`, sehingga order yang sudah dibatalkan tidak pernah mengambil stok. Endpoint internal tidak dipublikasikan melalui gateway. Jangan membagikan service token kepada browser atau peserta sebagai token pelanggan.
