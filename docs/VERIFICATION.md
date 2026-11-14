# Hasil verifikasi perbaikan audit

Tanggal: 13 November 2026. Lingkungan: Windows, Node.js 24, Docker Desktop dengan Linux containers.

## Hasil

| Pemeriksaan                                          | Hasil                                   |
| ---------------------------------------------------- | --------------------------------------- |
| Unit, regresi, integrasi service, component frontend | 85 tes lulus                            |
| TypeScript seluruh workspace                         | Lulus                                   |
| ESLint, termasuk frontend                            | Lulus                                   |
| Audit dependency npm online                          | 0 advisori terdeteksi                   |
| Build kelima image Docker                            | Lulus                                   |
| Healthcheck kelima container                         | Healthy                                 |
| E2E nyata melalui nginx dan gateway                  | 18/18 audit + 11/11 fitur belanja lulus |
| E2E browser (Chromium via Playwright)                | 16/16 langkah lulus                     |
| TLS opsional dan mounted secret files                | Lulus                                   |

E2E mencakup register/login/profile, normalisasi email dan registrasi konkuren, JSON rusak, batas byte password, RBAC, harga integer, validasi UUID, kewajiban idempotency key, konflik payload, delapan request konkuren dengan key sama, dua belas order konkuren yang memperebutkan sembilan stok, ownership order, 305 polling health, backup SQLite online, persistensi setelah restart, outage/pemulihan product-service, CRUD produk, dan redaksi secret pada log container.

Pengujian TLS memakai sertifikat lokal untuk `localhost`/`127.0.0.1` dengan CA eksplisit pada klien; verifikasi sertifikat dan hostname/IP tetap aktif. Frontend HTTPS, CSP, HSTS, login dengan password file, dan reservasi stok dengan service-token file berhasil. Port uji 3443 dipakai agar tidak bentrok dengan listener HTTPS lain. Stack kemudian dikembalikan ke HTTP loopback port 3000 dan gateway 8080.

Hasil terstruktur lokal berada di `.e2e/results.json` dan `.e2e/tls-results.json`. Build log berada di `.e2e/build.log`. Folder ini diabaikan Git dan Docker build context. Kredensial bootstrap acak berada di `.env`; tidak dicetak ke laporan.

## Batas verifikasi

Alur browser diuji di Chromium melalui Playwright terhadap stack Docker nyata: redirect anonim, registrasi, pencarian katalog, keranjang, checkout beralamat, riwayat pesanan, penolakan akses admin bagi pelanggan, navigasi seluler 390 px tanpa overflow, logout, password salah, serta alur admin (CRUD produk dan fulfillment). Tidak ada error konsol atau pelanggaran CSP selain 401 yang sengaja dipicu. Uji browser ini dijalankan manual pada sesi audit, belum menjadi bagian CI; Firefox/Safari dan pemeriksaan visual piksel tidak dicakup. Pemindaian DAST HawkScan tidak dijalankan karena CLI `hawk` dan kredensial StackHawk belum tersedia di mesin ini. Workflow CI sudah dibuat tetapi belum dijalankan pada hosting GitHub.

Deployment saat ini memakai SQLite lokal dengan satu replica per service. Pengujian ini tidak membuktikan kapasitas beban production, ketahanan multi-host, ataupun ketiadaan seluruh kerentanan OS image. Konfigurasi produksi lanjutan dijelaskan pada [HARDENING.md](HARDENING.md) dan [PRODUCTION-CHECKLIST.md](PRODUCTION-CHECKLIST.md).

## Paket fitur belanja

Paket keranjang, checkout beralamat, riwayat/detail pesanan, dan dashboard admin ditambahkan serta dibangun ulang di Docker. Suite shopping memeriksa 11 skenario: keranjang persisten dan versi optimistis; validasi alamat; satu checkout untuk key paralel berbeda; harga/alamat yang dibekukan; ownership dan RBAC; revision guard stok; status fulfillment berurutan; persistence setelah restart; penolakan stok kurang; produk yang dihapus; serta recovery checkout PENDING dengan pengurangan stok sekali. Seluruh skenario lulus melalui nginx/gateway. Key alternatif pada checkout juga diuji agar tidak dapat dipakai kembali untuk keranjang atau order lain.

Total tes unit/component/integrasi workspace saat itu 64 (kini 85, lihat audit lanjutan). Laporan terstruktur fitur berada di `.e2e/shopping-results.json`; dokumentasi penggunaan ada di [SHOPPING-FEATURES.md](SHOPPING-FEATURES.md). Pemeriksaan browser visual tetap memiliki batas yang disebutkan di atas.

Pemeriksaan gabungan juga menguji habisnya kuota gateway: error rate limit kini konsisten sebagai HTTP 429, termasuk pada route proxy. Suite shopping mengikuti Retry-After saat kuota habis.

## Audit lanjutan (13 November 2026)

Peninjauan ulang kode menemukan dan memperbaiki cacat berikut; masing-masing direproduksi lebih dahulu pada stack yang berjalan, lalu dikunci dengan tes regresi.

| Temuan                                                                                                   | Bukti sebelum perbaikan                                 | Tes regresi                                             |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| Pembacaan katalog untuk keranjang semua pengguna memakai satu kuota rate-limit per-IP di product-service | 305 pembacaan dari order-service → `GET /cart` 502      | `rate-limit.test.ts`, E2E "cart catalog reads"          |
| Token palsu ber-`kid` acak menghabiskan kuota fetch JWKS sehingga pengguna sah ditolak                   | 10 token palsu tanpa login → pengguna sah 503           | `signing-keys.test.ts`, `product.test.ts`, E2E "forged" |
| Gateway menjawab 500 saat service di belakangnya tidak terjangkau                                        | `/auth/me` 500 ketika auth-service sedang restart       | `gateway.test.ts`, E2E outage                           |
| 404 gateway memakai format error bawaan Fastify, berbeda dari service lain                               | `{"message":"Route GET:/… not found","statusCode":404}` | `gateway.test.ts`, E2E "unknown routes"                 |
| Recovery memakai snapshot order yang basi dan dapat menimpa order yang sudah diselesaikan                | Reservasi ulang untuk order yang sudah CONFIRMED        | `idempotency.test.ts`                                   |
| Nama produk berisi spasi saja diterima                                                                   | `POST /products` nama `"   "` → 201                     | `product.test.ts`, E2E RBAC                             |
| Seluruh tes frontend gagal bila huruf drive direktori kerja kecil (`c:\`, terminal VS Code)              | 8/8 gagal: `Invalid Chai property: toBeInTheDocument`   | Suite frontend dijalankan pada `C:` dan `c:`            |
| nginx mengunci IP gateway sejak start                                                                    | —                                                       | IP gateway dipindah manual → pulih < 2 dtk; E2E gateway |
| `healthy()` pada E2E dapat terpenuhi oleh cache health 1 detik dari sebelum restart                      | 1 dari 3 eksekusi gagal pada pemeriksaan restart        | Jeda 1,2 dtk sebelum polling                            |

Overlay TLS diverifikasi ulang dengan sertifikat uji baru karena `site.conf` berubah: `scripts/verify-tls.mjs` lulus, lalu stack dikembalikan ke HTTP loopback.

## Rekomendasi desain dan OWASP (14 November 2026)

| Pemeriksaan                                            | Hasil                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| Unit, regresi, integrasi service, component frontend   | 116 tes lulus                                                  |
| TypeScript, ESLint, Prettier                           | Lulus, tanpa peringatan                                        |
| `npm audit --audit-level=moderate`                     | 0 kerentanan                                                   |
| E2E audit melalui nginx dan gateway (`--chaos`)        | 24/24                                                          |
| E2E fitur belanja (`--chaos`)                          | 11/11, sekaligus menguji jalur `version` body yang deprecated  |
| E2E browser Chromium (Playwright)                      | 7/7 langkah sesi, If-Match, dan pembatalan                     |
| Migrasi database nyata v1 → v2                         | Ketiga volume termigrasi, masing-masing dengan backup `pre-v2` |
| Blok PowerShell M11 dan L2/L3 (Windows PowerShell 5.1) | Dijalankan terhadap stack; hasil sesuai dokumen                |

Fitur yang diverifikasi: `If-Match`/`ETag` keranjang (412/428), pembatalan order dengan pelepasan stok tepat sekali termasuk saat product-service mati dan saat reservasi kalah balapan dengan pembatalan (tombstone), retensi Idempotency-Key, access token 15 menit dengan refresh token berotasi (deteksi pemakaian ulang, logout, CSRF), backoff login per akun, serta root filesystem read-only.

Mutation test pada dua penjaga utama: menghapus tombstone membuat tes balapan gagal (tertangkap). Menghapus pemeriksaan status sebelum menulis `CANCELLED` tidak tertangkap tes, karena pelepasan di product-service sudah idempotent; pemeriksaan itu lapisan pertahanan kedua.

Belum dijalankan: pemindaian DAST (HawkScan), karena CLI `hawk` dan kredensial StackHawk belum tersedia di mesin ini. Pemetaan OWASP ada di [OWASP-API-SECURITY.md](OWASP-API-SECURITY.md).

## Storage relasional, batas tahan stok, OpenAPI dan versi API (14 November 2026)

| Pemeriksaan                                             | Hasil                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| Unit, regresi, integrasi service, component frontend    | 145 tes lulus (sebelumnya 116)                                             |
| TypeScript, ESLint, `npm run openapi:check`             | Lulus                                                                      |
| E2E audit melalui nginx dan gateway (`--chaos`)         | 26/26, termasuk validasi respons nyata terhadap skema OpenAPI              |
| E2E fitur belanja (`--chaos`)                           | 11/11 lewat jalur tanpa versi (`/api/...`): uji kompatibilitas mundur      |
| Migrasi database nyata v2 → v3 + migrasi service        | 203 order dan 6 produk pindah ke tabel; backup `pre-v3` di tiap volume     |
| Kesetaraan data hasil migrasi                           | Jumlah, total Rp2.589.950, dan ID/status/fulfillment identik dengan backup |
| Browser Chromium (Playwright)                           | Semua request ke `/api/v1`, cookie `Path=/api/v1/auth`, widget health OK   |
| Blok PowerShell inventaris M11 (Windows PowerShell 5.1) | Hasil sesuai dokumen                                                       |

Mutation test: tujuh penjaga dirusak satu per satu dan setiap kali tes yang menjaganya gagal (tertangkap): pemeriksaan batas tahan dihapus, cursor memakai `<=`, indeks riwayat dihapus, endpoint pembatalan tidak didokumentasikan, alias lama tanpa header `Deprecation`, constraint stok negatif dihapus, dan migrasi tak dikenal diterima.

Branch latihan m12.1–m12.6: di setiap `starter/m12.x` typecheck dan lint lulus, dan yang gagal hanya tes fitur yang dicabut (m12.1: 3, m12.2: 6 + 3, m12.3: 5, m12.4: 3, m12.5: 3, m12.6: 4 + 1). Setiap `solution/m12.x` lulus seluruh tes workspace terkait dan isinya identik dengan `feature/materi-lanjutan`.

Bug yang ditemukan saat verifikasi browser dan diperbaiki: widget health memanggil `/api/v1/health`, yang belum ada. Gateway kini juga melayani health di `/v1`, dan E2E kontrak memeriksanya.

Belum dijalankan: linter OpenAPI eksternal (`npx @redocly/cli lint`), karena mengunduh paket dari luar tidak diizinkan di sesi ini. Pemeriksaan struktural (semua `$ref` ter-resolve, parameter path lengkap, `operationId` unik) ada di `versioning.test.ts`. DAST (HawkScan) juga belum dijalankan.
