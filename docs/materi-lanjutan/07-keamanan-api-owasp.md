# M11 — Keamanan API dengan OWASP API Security Top 10

**Durasi:** 120 menit (opsional, setelah M10). **Prasyarat:** sesi PowerShell dari [L0 praktikum](02-praktikum.md#menyiapkan-sesi-powershell) sudah berjalan (`$apiBase`, `$buyerHeaders`, `$adminHeaders`, `$labPassword`).

## Tujuan

Setelah modul ini peserta dapat:

1. Menyebutkan sepuluh risiko OWASP API Security Top 10 (2023) dan contohnya pada sistem e-commerce ini.
2. Membuktikan sendiri, lewat request nyata, bahwa sebuah kontrol bekerja, bukan sekadar membaca kodenya.
3. Membedakan risiko yang sudah tertangani dari celah yang masih terbuka, dan mengusulkan perbaikan.

Bukti lengkap per risiko (lokasi kode, nama tes, pemeriksaan E2E) ada di [OWASP-API-SECURITY.md](../OWASP-API-SECURITY.md). Modul ini fokus pada praktik.

## Mengapa daftar khusus API?

OWASP Top 10 untuk aplikasi web berfokus pada halaman yang dirender server. Pada API, klien (browser, aplikasi mobile, skrip) memegang kendali penuh atas request: ia dapat mengganti ID di path, menambah field di body, atau memanggil endpoint tanpa melalui UI. Karena itu otorisasi harus diputuskan di server untuk **setiap objek, setiap field, dan setiap fungsi**. Menu yang disembunyikan di React bukan kontrol keamanan.

| Risiko | Pertanyaan yang harus dijawab server                          | Contoh di sistem ini                             |
| ------ | ------------------------------------------------------------- | ------------------------------------------------ |
| API1   | Apakah objek **ini** milik pemanggil?                         | Order hanya bisa dibaca/dibatalkan pemiliknya    |
| API2   | Apakah pemanggil benar-benar dia, dan sesinya masih sah?      | JWT RS256, refresh token berotasi, backoff login |
| API3   | Field mana yang boleh dibaca dan **diubah** pemanggil?        | `role` dan harga tidak bisa dikirim klien        |
| API4   | Berapa banyak yang boleh diminta, seberapa sering?            | Rate limit, batas halaman, batas body            |
| API5   | Apakah **fungsi** ini boleh dipanggil role tersebut?          | Endpoint admin dan internal                      |
| API6   | Apakah alur bisnis bisa disalahgunakan secara otomatis?       | Menahan seluruh stok tanpa membayar              |
| API7   | Apakah server mengambil URL atas permintaan klien?            | Tidak ada; ID divalidasi UUID                    |
| API8   | Apakah konfigurasinya aman secara default?                    | Header, CORS, error generik, container read-only |
| API9   | Apakah semua endpoint, versi, dan jalur lama diketahui?       | Referensi API, header `Deprecation`              |
| API10  | Apakah respons service lain diperlakukan sebagai input asing? | Validasi kontrak product-service                 |

## S1 — API1: objek milik orang lain (20 menit)

Buat pembeli kedua, lalu coba akses dan batalkan order pembeli pertama.

```powershell
$otherEmail = "lain-$labRun@example.test"
$otherBody = @{ email = $otherEmail; password = $labPassword } | ConvertTo-Json
$null = Invoke-RestMethod -Method Post -Uri "$apiBase/auth/register" `
  -ContentType 'application/json' -Body $otherBody
$otherSession = Invoke-RestMethod -Method Post -Uri "$apiBase/auth/login" `
  -ContentType 'application/json' -Body $otherBody
$otherHeaders = @{ Authorization = "Bearer $($otherSession.token)" }

$product = (Invoke-RestMethod "$apiBase/products?q=Sticker").products[0]
$orderBody = @{ items = @(@{ productId = $product.id; quantity = 1 }) } | ConvertTo-Json -Depth 4
$myOrder = (Invoke-RestMethod -Method Post -Uri "$apiBase/orders" `
    -Headers ($buyerHeaders + @{ 'Idempotency-Key' = [guid]::NewGuid().ToString() }) `
    -ContentType 'application/json' -Body $orderBody).order

foreach ($attempt in @(
    @{ Method = 'Get'; Uri = "$apiBase/orders/$($myOrder.id)" },
    @{ Method = 'Post'; Uri = "$apiBase/orders/$($myOrder.id)/cancel" })) {
  try { Invoke-RestMethod @attempt -Headers $otherHeaders; 'BOCOR!' }
  catch { "$($attempt.Method) -> $([int]$_.Exception.Response.StatusCode)" }
}
```

**Hasil yang diharapkan:** kedua request dijawab `404`. **Diskusi:** mengapa 404, bukan 403? (403 mengonfirmasi bahwa order itu ada.) Temukan baris kode yang membuat keputusan ini.

## S2 — API3: field yang tidak boleh dikirim klien (15 menit)

```powershell
$sneaky = @{ email = "naik-$labRun@example.test"; password = $labPassword; role = 'admin' } |
  ConvertTo-Json
(Invoke-RestMethod -Method Post -Uri "$apiBase/auth/register" `
  -ContentType 'application/json' -Body $sneaky).user.role

$cheap = @{ items = @(@{ productId = $product.id; quantity = 1 }); total = 1 } |
  ConvertTo-Json -Depth 4
(Invoke-RestMethod -Method Post -Uri "$apiBase/orders" `
  -Headers ($buyerHeaders + @{ 'Idempotency-Key' = [guid]::NewGuid().ToString() }) `
  -ContentType 'application/json' -Body $cheap).order.total
```

**Hasil:** role tetap `user`; total sama dengan harga katalog, bukan `1`. **Diskusi:** skema zod membuang field yang tidak dideklarasikan. Apa risikonya bila skema memakai `.passthrough()` lalu objek langsung disimpan?

## S3 — API2: sesi, refresh token, dan tebakan password (25 menit)

1. Login di browser, buka DevTools → Application → Cookies. Catat atribut cookie `refresh_token`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api/auth`.
2. Di Console, jalankan `document.cookie`. Cookie refresh **tidak** muncul: skrip yang disisipkan (XSS) tidak bisa mencurinya.
3. Muat ulang halaman. Anda tetap login, karena sesi dipulihkan lewat cookie. Klik **Keluar**, lalu muat ulang: Anda harus login lagi karena sesi sudah dicabut di server.
4. Decode payload access token (bagian tengah JWT) dan hitung `exp - iat`. Hasilnya 900 detik.
5. Uji backoff per akun memakai akun sekali pakai:

```powershell
$victim = @{ email = "target-$labRun@example.test"; password = $labPassword } | ConvertTo-Json
$null = Invoke-RestMethod -Method Post -Uri "$apiBase/auth/register" `
  -ContentType 'application/json' -Body $victim
$wrong = @{ email = "target-$labRun@example.test"; password = 'salah-salah-salah' } | ConvertTo-Json
foreach ($i in 1..6) {
  try { $null = Invoke-RestMethod -Method Post -Uri "$apiBase/auth/login" `
      -ContentType 'application/json' -Body $wrong }
  catch {
    $r = $_.Exception.Response
    "percobaan $i -> $([int]$r.StatusCode) retry-after=$($r.Headers['Retry-After'])"
  }
}
```

**Hasil:** lima percobaan pertama `401`, percobaan keenam `429` dengan `Retry-After` sekitar 30 detik. Login dengan password **benar** selama jeda juga `429`. **Diskusi:** mengapa backoff bersifat sementara, bukan penguncian permanen? (Penguncian permanen memberi penyerang cara mengunci akun korban.) Mengapa email yang tidak terdaftar juga diperlambat?

## S4 — API4 dan API5: batas sumber daya dan fungsi admin (20 menit)

```powershell
$newProduct = '{"name":"X","price":1000}'
$checks = @(
  @{ Name = 'limit 1000'; Request = @{ Uri = "$apiBase/products?limit=1000" } },
  @{ Name = 'tambah produk (pembeli)'; Request = @{
      Method = 'Post'; Uri = "$apiBase/products"; Headers = $buyerHeaders
      ContentType = 'application/json'; Body = $newProduct } },
  @{ Name = 'daftar order admin (pembeli)'; Request = @{
      Uri = "$apiBase/orders/admin"; Headers = $buyerHeaders } },
  @{ Name = 'route internal via gateway'; Request = @{
      Method = 'Post'; Uri = "$apiBase/internal/reservations/x"
      ContentType = 'application/json'; Body = '{}' } }
)
foreach ($c in $checks) {
  $request = $c.Request
  try { $null = Invoke-RestMethod @request; "$($c.Name) -> 2xx (periksa!)" }
  catch { "$($c.Name) -> $([int]$_.Exception.Response.StatusCode)" }
}
```

**Hasil:** `400`, `403`, `403`, `404`. Jalankan juga 120 request `GET /products` dalam satu menit dan amati `429` beserta `Retry-After`. **Diskusi:** di mana role diperiksa? Mengapa endpoint internal tidak cukup hanya "tidak didokumentasikan"?

## S5 — API8 dan API9: konfigurasi dan inventaris (20 menit)

```powershell
$page = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -UseBasicParsing
$page.Headers['Content-Security-Policy']; $page.Headers['Server']
try { $null = Invoke-WebRequest -Uri "$apiBase/tidak-ada" -UseBasicParsing }
catch { "$([int]$_.Exception.Response.StatusCode) $($_.ErrorDetails.Message)" }
docker compose exec -T order-service sh -c 'touch /app/coba 2>/dev/null || echo READ-ONLY'
```

**Hasil:** CSP terpasang; header `Server` hanya `nginx` tanpa versi; route tak dikenal dijawab `404` dengan bentuk error seragam; perintah terakhir mencetak `READ-ONLY` karena container menolak menulis ke root filesystem.

**Tugas inventaris:** buat daftar semua prefix yang diteruskan gateway (lihat [`services/gateway/src/app.ts`](../../services/gateway/src/app.ts)) dan cocokkan dengan [referensi API](03-referensi-api.md). Kirim `PUT /cart/items/:id` dengan `version` di body (cara lama) dan temukan header `Deprecation: true` pada respons. Apa yang dibutuhkan agar jalur lama ini bisa dihapus dengan aman?

## S6 — API6, API7, API10: diskusi desain (20 menit)

Kerjakan berkelompok, presentasikan 3 menit per kelompok.

1. **API6.** Belum ada pembayaran, jadi order yang terkonfirmasi langsung menahan stok. Rancang batas yang mencegah satu pengguna menahan seluruh stok tanpa mengganggu pembeli wajar. Di service mana batas itu diterapkan, dan apa yang terjadi pada request paralel?
2. **API7.** Fitur baru: admin dapat mengisi "URL gambar produk" yang diunduh server untuk dibuat thumbnail. Sebutkan tiga serangan SSRF yang mungkin terjadi dan kontrolnya.
3. **API10.** Baca validasi di [`product-client.ts`](../../services/order-service/src/product-client.ts). Apa yang terjadi bila product-service yang disusupi mengembalikan `subtotal` lebih kecil dari `unitPrice × quantity`? Tes mana yang membuktikannya?

## Rubrik singkat

| Kriteria                                                                | Bobot |
| ----------------------------------------------------------------------- | ----: |
| S1–S5 dijalankan, status HTTP dan bukti dicatat                         |   40% |
| Setiap hasil dikaitkan ke risiko OWASP dan baris kode yang menanganinya |   30% |
| Usulan desain S6 masuk akal, menyebut trade-off, dan dapat diuji        |   30% |
