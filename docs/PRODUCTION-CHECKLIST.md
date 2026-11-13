# Production checklist setelah hardening

Perbaikan audit sudah menambahkan database SQLite per service, transaksi reservasi stok, idempotensi order dan pemulihan PENDING, kredensial bootstrap acak opt-in, secret file, TLS opsional, pembatasan jaringan/resource, backup online, serta workflow CI dan tes regresi/E2E.

Detail implementasi, perintah menjalankan, backup/restore, dan konfigurasi TLS tersedia di [HARDENING.md](HARDENING.md). Dokumen latihan dan keputusan prototype lama harus dibaca sebagai materi historis.

Sebelum melayani pelanggan nyata:

- Tetapkan kapasitas dan SLO. Deployment SQLite yang tersedia mendukung satu host dan satu replica per service. Migrasikan ke database server per service jika membutuhkan multi-host atau horizontal scaling.
- Sediakan secret dari platform, certificate chain yang dipercaya, renewal, kebijakan rotasi JWT dengan overlap JWKS/KMS, dan ingress/firewall yang sesuai.
- Jadwalkan backup ke lokasi di luar host, sertakan signing key, dan latih restore serta rekonsiliasi lintas service.
- Tambahkan metrics, alert, tracing seluruh hop, dan image scanning. Audit npm pada sesi perbaikan sudah bersih; hasil ini bukan jaminan seluruh image OS bebas kerentanan.
- Implementasikan pembayaran/pengiriman/refund dengan state machine dan kompensasi, mengikuti pola saga pembatalan yang sudah ada. Workflow saat ini mengalokasikan dan dapat melepas stok, tetapi belum menagih.
- Tambahkan batas stok yang ditahan per pengguna dan anti-otomasi registrasi (OWASP API6), serta spesifikasi OpenAPI dan versi API (OWASP API9). Lihat [OWASP-API-SECURITY.md](OWASP-API-SECURITY.md).
- Konfigurasikan registry, deployment target, approval organisasi, dan jalankan workflow CI di hosting GitHub. Workflow lokal sudah tersedia; publishing/deployment belum dilakukan.
- Lengkapi load test representatif dan browser E2E di runner yang mendukung browser. Tes component dan API E2E lokal sudah dijalankan; akses Firefox interaktif pada mesin ini diblokir oleh alat computer-use.
