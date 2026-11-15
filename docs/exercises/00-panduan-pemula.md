# Panduan Pemula: Cara Mengerjakan Lab

Panduan ini ditulis untuk Anda yang baru pertama kali mengerjakan lab berbasis
branch Git. Bacalah sekali dari awal sampai akhir sebelum mulai lab m0.1, lalu
kembali ke sini setiap kali bingung.

## 1. Apa yang akan Anda bangun

Sebuah toko online yang dipecah menjadi beberapa layanan kecil (microservice):

```
Browser ──▶ frontend (React)        tampilan untuk pembeli dan admin
Browser ──▶ gateway (Fastify :8080) satu-satunya pintu masuk API
               │
   ┌───────────┼───────────────┐
   ▼           ▼               ▼
auth-service product-service order-service     (Express)
 (:3001)      (:3002)         (:3003)
 akun, login  katalog, stok   pesanan
```

Anda membangunnya bertahap: monorepo dan logger (modul 0), layanan akun (modul 1),
katalog dan pesanan (modul 2), gateway (modul 3), lalu frontend dan Docker (modul
4). Setelah itu ada materi lanjutan (M5–M11) dan dua belas lab fitur keamanan dan
konsistensi data (modul 12).

## 2. Alat yang perlu dipasang

| Alat                 | Versi   | Dipakai mulai | Cara memeriksa      |
| -------------------- | ------- | ------------- | ------------------- |
| Node.js (dan npm)    | 24 LTS  | m0.1          | `node -v` → `v24.x` |
| Git                  | terbaru | m0.1          | `git --version`     |
| VS Code (disarankan) | terbaru | m0.1          | -                   |
| Docker Desktop       | terbaru | m4.3          | `docker version`    |

**Pengguna Windows:** pasang Git for Windows, lalu pakai terminal **Git Bash** untuk
lab ini. Hampir semua perintah juga berjalan di PowerShell, tetapi skrip
`scripts/dev/worktrees.sh` dan beberapa contoh memakai sintaks Bash. Bila sebuah
contoh punya versi PowerShell, versi itu ditulis terpisah.

Node.js 24 wajib: service dijalankan langsung dari berkas `.ts` memakai fitur
_type stripping_ bawaan Node 24. Versi lebih lama akan gagal dengan pesan seperti
`Unknown file extension ".ts"`.

## 3. Menyiapkan repo

```bash
git clone https://github.com/inixrust/ecommerce-microservices.git
cd ecommerce-microservices
git fetch --all            # ambil semua branch lab dari server
git branch -r              # lihat daftarnya: origin/starter/..., origin/solution/...
```

Anda tidak perlu membuat branch lab satu per satu. Perintah `git switch
starter/m0.1-monorepo-bootstrap` otomatis membuat branch lokal yang mengikuti
branch di server.

## 4. Siklus kerja satu lab

Ikuti urutan ini di **setiap** lab. Contoh di bawah memakai lab m1.3.

### Langkah 1 — Pindah ke starter

```bash
git status                                  # pastikan "nothing to commit"
git switch starter/m1.3-auth-jwt-jwks
```

Bila Git menolak karena ada perubahan yang belum disimpan, simpan dulu (lihat
bagian 6) atau buang dengan `git restore .` bila memang tidak diperlukan.

### Langkah 2 — Pasang dependency

```bash
npm ci
```

`npm ci` memasang versi persis yang tercatat di `package-lock.json`. Jalankan setiap
kali pindah branch, karena dependency bisa berbeda antar-lab. Bedanya dengan
`npm install`: `npm ci` tidak pernah mengubah lockfile, jadi hasilnya sama di semua
komputer peserta. (Satu-satunya pengecualian adalah starter m0.1: di sana belum ada
`package.json`, karena Andalah yang membuatnya.)

### Langkah 3 — Build shared package (mulai m0.2)

```bash
npm run build:packages
```

Folder `packages/` berisi library yang dipakai bersama oleh semua service (logger,
HTTP client, storage). Library ini harus dikompilasi dulu ke folder `dist/` sebelum
service bisa memakainya. Tanpa langkah ini muncul error
`Cannot find module '@ecommerce/logger'`. Ulangi setiap kali Anda mengubah isi
`packages/`.

### Langkah 4 — Baca panduan lab dan jalankan tes awal

```bash
code docs/exercises/m1.3-auth-jwt-jwks.md   # atau buka di editor mana pun
npm test
```

Catat hasil tes **sebelum** mengubah apa pun. Di modul 0–4, tes untuk fitur baru
belum ada di starter (Anda menulisnya, atau melihatnya nanti di solution). Di modul
12, tes fitur sudah ada dan **sengaja gagal**; panduan lab menyebutkan nama tes yang
harus berubah menjadi lulus.

### Langkah 5 — Buat branch kerja sendiri

```bash
git switch -c latihan/m1.3
```

Dengan begitu branch `starter/...` tetap bersih dan Anda bisa kembali ke kondisi
awal kapan saja.

### Langkah 6 — Kerjakan langkah-langkah di panduan lab

Kerjakan sedikit demi sedikit. Setelah setiap langkah, jalankan pemeriksaan yang
paling cepat:

```bash
npm run typecheck          # TypeScript: salah ketik nama, tipe tidak cocok
npm test --workspace=services/auth-service   # hanya tes satu service
```

### Langkah 7 — Periksa kriteria lulus

Setiap panduan lab punya bagian **Kriteria lulus**. Lab selesai bila semua butirnya
terpenuhi, biasanya:

```bash
npm run typecheck && npm run lint && npm test
```

### Langkah 8 — Bandingkan dengan solution

```bash
git diff starter/m1.3-auth-jwt-jwks solution/m1.3-auth-jwt-jwks --stat   # berkas apa saja
git diff latihan/m1.3 solution/m1.3-auth-jwt-jwks -- services/auth-service/src
```

Perbedaan dengan solution tidak selalu berarti salah. Yang penting perilakunya
memenuhi kriteria lulus dan tesnya lulus.

### Langkah 9 — Lanjut ke lab berikutnya

```bash
git add -A && git commit -m "latihan m1.3 selesai"
git switch starter/m2.1-product-distributed-auth
npm ci
```

Starter lab berikutnya sudah memuat **kode referensi** lab yang baru Anda kerjakan.
Ini sengaja: kalau hasil Anda sedikit berbeda, lab berikutnya tetap dimulai dari
fondasi yang pasti benar. Pekerjaan Anda sendiri tetap tersimpan di
`latihan/m1.3`.

**Ingin melanjutkan dengan kode buatan sendiri?** Bisa, tetapi tes lab berikutnya
mengasumsikan perilaku kode referensi:

```bash
git switch -c latihan/m2.1 latihan/m1.3
git checkout starter/m2.1-product-distributed-auth -- docs/exercises
```

## 5. Menjalankan tes

| Perintah                                                        | Yang diuji                                             |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| `npm test`                                                      | semua workspace                                        |
| `npm test --workspace=services/auth-service`                    | satu workspace                                         |
| `cd services/auth-service && npx vitest run tests/auth.test.ts` | satu berkas tes                                        |
| `npx vitest run -t "register"` (di folder workspace)            | tes yang namanya memuat kata itu                       |
| `npx vitest` (di folder workspace)                              | mode watch: tes jalan ulang saat Anda menyimpan berkas |

Cara membaca keluaran Vitest:

```
 ✓ tests/auth.test.ts (7 tests) 1630ms        ← semua tes di berkas ini lulus
 × tests/auth.test.ts > login → token ...     ← tes ini gagal
   AssertionError: expected 401 to be 200     ← yang diharapkan vs yang terjadi
 ❯ tests/auth.test.ts:52:24                   ← baris tes yang gagal
 Test Files  1 passed (1)
      Tests  7 passed (7)                     ← ringkasan
```

Bila sebuah workspace belum punya berkas tes, skrip tesnya memakai
`vitest run --passWithNoTests` supaya `npm test` di root tidak gagal. Begitu
workspace itu mendapat tes pertamanya, opsi itu dihapus.

## 6. Menyimpan dan membatalkan pekerjaan

| Ingin…                                | Perintah                                    |
| ------------------------------------- | ------------------------------------------- |
| melihat berkas yang berubah           | `git status`                                |
| melihat isi perubahan                 | `git diff`                                  |
| menyimpan (commit)                    | `git add -A && git commit -m "pesan"`       |
| menyimpan sementara tanpa commit      | `git stash` (kembalikan: `git stash pop`)   |
| membuang perubahan satu berkas        | `git restore path/ke/berkas`                |
| kembali ke kondisi starter sepenuhnya | `git switch starter/<lab> && git restore .` |
| melihat satu berkas versi solution    | `git show solution/<lab>:path/ke/berkas`    |

## 7. Menjalankan service secara lokal

Mulai m1.2 Anda bisa menjalankan service tanpa Docker:

```bash
npm run build:packages
npm run dev --workspace=services/auth-service      # http://localhost:3001
```

Uji dari terminal lain:

```bash
curl http://localhost:3001/health
```

PowerShell: `Invoke-RestMethod http://localhost:3001/health`. Mulai m3.1,
`npm run dev:all` menjalankan keempat service backend sekaligus. Hentikan dengan
`Ctrl+C`.

## 8. Masalah yang sering terjadi

| Gejala                                                          | Penyebab dan solusi                                                                                                              |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot find module '@ecommerce/logger'` (atau paket lain)      | Shared package belum dikompilasi. Jalankan `npm run build:packages`.                                                             |
| `npm ci` gagal: lockfile tidak sinkron                          | Anda mengubah `package.json` tanpa memperbarui lockfile. Jalankan `npm install` lalu commit keduanya.                            |
| `Unknown file extension ".ts"`                                  | Node.js lebih tua dari 24. Periksa `node -v`.                                                                                    |
| `EADDRINUSE: address already in use :::3001`                    | Port dipakai proses lain. Windows: `netstat -ano \| findstr :3001`, lalu `taskkill /PID <pid> /F`. macOS/Linux: `lsof -i :3001`. |
| `git switch` ditolak: "Your local changes would be overwritten" | Simpan (`git commit` atau `git stash`) atau buang (`git restore .`) perubahan dulu.                                              |
| Tes menggantung dan tidak pernah selesai                        | Biasanya server tes tidak ditutup. Pastikan `afterAll` memanggil `server.close()` dan menunggunya.                               |
| `bash: command not found` di Windows                            | Jalankan dari Git Bash, bukan Command Prompt.                                                                                    |
| Docker: `Cannot connect to the Docker daemon`                   | Docker Desktop belum berjalan. Buka aplikasinya dan tunggu sampai statusnya "running".                                           |
| Tes lulus di komputer teman tetapi gagal di Anda                | Jalankan ulang `npm ci` dan `npm run build:packages`; sisa build lama sering menjadi penyebabnya.                                |

Bila tetap buntu: salin pesan error **lengkap** (bukan hanya baris terakhir), catat
lab dan langkah yang sedang dikerjakan, lalu tanyakan ke instruktur.

## 9. Istilah yang sering muncul

| Istilah             | Arti singkat                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| Monorepo, workspace | Satu repo berisi banyak paket; tiap folder di `packages/`, `services/`, `frontend/` adalah satu workspace npm. |
| Middleware          | Fungsi yang dijalankan Express sebelum handler route (log, keamanan, validasi).                                |
| JWT                 | Token bertanda tangan berisi identitas pengguna; diverifikasi tanpa bertanya ke server lain.                   |
| JWKS                | Daftar kunci publik untuk memverifikasi tanda tangan JWT.                                                      |
| RBAC                | Hak akses berdasarkan peran (`user`, `admin`).                                                                 |
| Circuit breaker     | "Sekring": berhenti memanggil layanan yang sedang rusak supaya kegagalan tidak menjalar.                       |
| Gateway             | Satu pintu masuk yang meneruskan request ke layanan yang tepat.                                                |
| Correlation ID      | ID unik satu request yang ikut ke semua layanan, supaya lognya bisa ditelusuri.                                |
| Idempotency key     | Kunci dari klien yang menjamin request yang diulang tidak membuat pesanan ganda.                               |
| Saga                | Rangkaian langkah lintas layanan dengan langkah pembatalan (kompensasi) bila gagal di tengah jalan.            |
