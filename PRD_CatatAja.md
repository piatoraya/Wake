# Product Requirement Document (PRD)

## Web Dashboard Admin & Owner — Platform "CatatAja"

**Produk:** CatatAja (https://catataja.id/)
**Dokumen:** PRD Web Dashboard Admin
**Versi:** 1.0
**Status:** Draft siap pengembangan
**Template UI:** Mazer Admin Dashboard (Bootstrap 5) — https://github.com/zuramai/mazer
**Target Pengguna:** Owner (akses penuh) & Admin/CS (akses operasional)

---

## 1. Overview & Business Objectives

### 1.1 Latar Belakang

CatatAja adalah layanan pencatatan keuangan berbasis AI yang diakses melalui WhatsApp dan Telegram. Pengguna dapat mencatat transaksi dengan teks, foto struk (OCR), dan voice note. Platform memiliki model langganan berjenjang (Gratis, Plus, Pro) dengan pembayaran QRIS otomatis via webhook. Untuk mengoperasikan platform secara efisien, dibutuhkan **Web Dashboard Admin & Owner** yang terpusat untuk memantau metrik, mengelola pengguna & langganan, men-troubleshoot parsing AI, dan mengelola konten support yang tampil dinamis di landing page.

### 1.2 Tujuan Operasional

1. Memberikan **visibilitas penuh** atas KPI platform (user, langganan, pendapatan, volume pesan, transaksi).
2. Memungkinkan **manajemen pengguna & langganan** (adjust kuota, ubah paket, cek status pembayaran).
3. Menyediakan **log viewer** untuk memantau parsing AI (teks/OCR/voice) dan troubleshooting transaksi.
4. Mengelola **kontak & support** yang tampil dinamis di landing page CatatAja.
5. Menyediakan **ekspor laporan** (CSV/Excel) untuk analisis bisnis.

### 1.3 Key Metrics / KPI Platform

| # | Metrik | Sumber | Tampilan |
|---|--------|--------|----------|
| 1 | Total User Terdaftar | `users` | Stat Card |
| 2 | User Aktif Hari Ini | `bot_logs` (distinct user_id, last 24h) | Stat Card |
| 3 | Pendapatan Bulan Ini (MRR) | `subscriptions` (status=success) | Stat Card |
| 4 | Total Transaksi Tercatat | `bot_logs` / transactions | Stat Card |
| 5 | Total Pesan Diproses AI | `bot_logs` | Stat Card + Chart |
| 6 | Paid Subscribers (Plus/Pro) | `users.tier_id` | Stat Card |
| 7 | Pertumbuhan User Baru | `users.created_at` agregasi harian/bulanan | Line Chart |
| 8 | Volume Pesan Bot | `bot_logs.created_at` agregasi | Bar Chart |
| 9 | Breakdown Paket (Gratis/Plus/Pro) | `users.tier_id` | Donut Chart |
| 10 | Status Pembayaran QRIS | `subscriptions.payment_status` | Tabel |

---

## 2. User Roles & Access Control (RBAC)

### 2.1 Role: Owner

- Akses penuh ke seluruh fitur dashboard.
- Melihat laporan keuangan platform (MRR/ARR, revenue per paket).
- Mengelola harga & paket (tier, kuota, harga).
- Manajemen admin & CS (CRUD admin users, role, reset password).
- Konfigurasi sistem & kontak support.
- Ekspor seluruh data.

### 2.2 Role: Admin / CS

- Memantau status user (daftar user, paket, sisa kuota, tanggal reset).
- Cek riwayat pesan bot & status parsing AI.
- Troubleshooting transaksi user (lihat detail transaksi, adjust kuota manual, ubah status paket jika ada kendala pembayaran).
- Update informasi kontak support (WhatsApp CS, Telegram, Email, Jam Operasional).
- **Tidak boleh:** mengubah harga/paket, mengelola admin users, melihat laporan keuangan platform (MRR detail), konfigurasi sistem inti.

### 2.3 Matriks Izin (Ringkas)

| Fitur | Owner | Admin/CS |
|-------|:-----:|:--------:|
| Lihat Analytics & KPI | ✅ | ✅ (terbatas) |
| Lihat Daftar User | ✅ | ✅ |
| Edit/Adjust Kuota User | ✅ | ✅ |
| Ubah Status Paket User | ✅ | ✅ (dengan catatan) |
| Lihat Log Pesan AI | ✅ | ✅ |
| Troubleshoot Transaksi User | ✅ | ✅ |
| Lihat Riwayat Pembayaran | ✅ | ✅ (read-only) |
| Edit Kontak & Support | ✅ | ✅ |
| Kelola Harga & Paket | ✅ | ❌ |
| Manajemen Admin Users | ✅ | ❌ |
| Laporan Keuangan Platform (MRR/ARR) | ✅ | ❌ |
| Konfigurasi Sistem Inti | ✅ | ❌ |
| Ekspor Data Laporan | ✅ | ✅ (terbatas) |

---

## 3. Core Features & Functional Requirements

### 3.1 A. Platform Analytics & Overview

**F-01 Summary Cards (Mazer Stat Cards)**
- Total User Terdaftar, User Aktif Hari Ini, Pendapatan Bulan Ini, Total Transaksi Masuk.
- Filter periode: hari ini, 7 hari, 30 hari, bulan berjalan, custom range.

**F-02 Grafik Tren (ApexCharts)**
- Line chart pertumbuhan user baru (harian/bulanan).
- Bar chart volume pesan bot (harian/bulanan) dengan breakdown tipe (teks/OCR/voice).
- Donut chart distribusi paket (Gratis/Plus/Pro).

### 3.2 B. User & Subscription Management

**F-03 Tabel Data User (Simple-DataTables)**
- Kolom: ID, No WhatsApp/Telegram, Email, Status Paket, Sisa Kuota Pesan, Tanggal Reset Kuota (tiap tanggal 1), Tgl Daftar, Aksi.
- Search, sort, filter by paket/status, pagination server-side.

**F-04 Edit/Adjust Manual**
- Modal form untuk menambah kuota pesan manual.
- Ubah status paket user (Gratis/Plus/Pro) dengan alasan (audit).
- Reset kuota manual (mis. kompensasi gangguan).

**F-05 Riwayat Pembayaran (Transaction Logs)**
- Tabel transaksi QRIS: ID, User, Paket, Nominal, Status (Pending/Success/Expired), Referensi QRIS, Tanggal.
- Filter by status/tanggal/paket.
- Detail transaksi (payload webhook) untuk troubleshooting.

### 3.3 C. AI Message & Transaction Monitoring (Log Viewer)

**F-06 Log Viewer Pesan Bot**
- Tabel log: timestamp, user, tipe pesan (teks/OCR/voice), raw content (ringkas), status parsing AI (Sukses/Gagal/Error), pesan error.
- Filter by user, tipe, status, tanggal.
- Detail modal: raw content penuh, respons AI (JSON), transaksi yang dihasilkan.

**F-07 Troubleshooting Transaksi**
- Lihat detail transaksi yang berhasil dicatat oleh user tertentu.
- Koreksi manual transaksi (edit/hapus) bila parsing AI salah, dengan audit log.

### 3.4 D. Dynamic Support & Contact Management

**F-08 Form CRUD Kontak Support**
- Form (Mazer Modal/Form) untuk mengatur:
  - Nomor WhatsApp CS
  - Email Support (`support@catataja.id`)
  - Username Telegram Helpdesk
  - Link FAQ/Bantuan
  - Jam Operasional
- Field: `key`, `label`, `value`, `is_active`, `updated_at`, `updated_by`.

**F-09 Integrasi Dinamis dengan Landing Page**
- Endpoint publik `GET /api/public/contacts` mengembalikan kontak aktif.
- Landing page CatatAja mengonsumsi endpoint ini untuk menampilkan info kontak & footer secara dinamis.
- Caching (in-memory/Redis) TTL 5 menit; invalidate saat kontak diperbarui (fast-loading).

### 3.5 E. Financial & Data Reporting

**F-10 Ekspor Laporan**
- Ekspor data langganan & transaksi platform ke CSV/Excel.
- Filter by periode, paket, status pembayaran.
- Laporan MRR/ARR (Owner only) dengan breakdown per paket.

### 3.6 Settings & System Monitor

**F-11 Status Bot & Log Sistem**
- Status koneksi bot WhatsApp/Telegram (Online/Offline).
- Log error sistem (API, webhook, parsing).
- Konfigurasi webhook pembayaran QRIS (URL, secret).

---

## 4. UI System Integration (Mazer Template Adaptation)

### 4.1 Pemetaan Komponen Mazer

| Kebutuhan | Komponen Mazer |
|-----------|----------------|
| Metrik Platform | Stat Cards (`.card` + ikon + angka) |
| Grafik Tren User/Pesan | ApexCharts Line/Bar |
| Distribusi Paket | ApexCharts Donut |
| Tabel User & Log Transaksi | Simple-DataTables |
| Form Edit Kuota / Kontak | Bootstrap Modal + Form |
| Filter Tanggal/Paket/Status | Form select + date range |
| Status Bot | Badge di navbar/sidebar |
| Dark/Light Mode | Toggle bawaan Mazer (navbar) |

### 4.2 Konvensi Styling

- Gunakan variabel CSS Mazer agar konsisten dengan dark mode.
- Format rupiah: `Rp 29.900`.
- Tanggal: format Indonesia.
- Warna semantik: sukses hijau, gagal merah, pending kuning, info biru.

---

## 5. Data Schema & Architecture (High-Level)

### 5.1 Desain Relasi Tabel Utama

**users**
- `id` (PK), `phone` (WA), `telegram_id`, `email`, `tier_id` (FK subscription_tiers.id), `quota_remaining` (int), `reset_date` (date), `created_at`, `updated_at`.

**subscription_tiers**
- `id` (PK), `name` (Gratis/Plus/Pro), `price` (int), `quota_messages` (int), `features` (JSON), `is_active` (bool).

**subscriptions**
- `id` (PK), `user_id` (FK users.id), `plan_type` (Gratis/Plus/Pro), `amount` (int), `payment_status` (pending/success/expired), `qris_ref` (string), `expired_at` (timestamp), `created_at`.

**bot_logs**
- `id` (PK), `user_id` (FK users.id), `message_type` (text/image/voice), `raw_content` (text), `ai_response` (JSON), `status` (success/failed/error), `error_message` (text), `created_at`.
- Indeks: `user_id`, `created_at`, `status`.

**system_settings**
- `id` (PK), `key` (unique), `value` (text), `label`, `description`, `is_active` (bool), `updated_at`, `updated_by` (FK admin_users.id).
- Digunakan untuk pengaturan kontak & operasional (WhatsApp CS, Email, Telegram, FAQ, Jam Operasional).

**admin_users**
- `id` (PK), `username` (unique), `password_hash`, `role` (owner/admin), `name`, `email`, `is_active`, `last_login`, `created_at`.

**audit_logs**
- `id` (PK), `admin_id` (FK), `action`, `entity`, `entity_id`, `before` (JSON), `after` (JSON), `ip`, `user_agent`, `created_at`.

### 5.2 Strategi API / Webhook

- **Bot → Dashboard:** bot mengirim log pesan & transaksi ke DB/API secara real-time (atau batch) untuk monitoring.
- **Payment Gateway → Dashboard:** webhook QRIS memperbarui `subscriptions.payment_status` dan `users.tier_id`/`quota_remaining` otomatis.
- **Dashboard → Landing Page:** endpoint publik `/api/public/contacts` (dari `system_settings`) untuk data kontak dinamis.
- **Auth:** JWT (access + refresh) dengan RBAC; rate limiting pada login & API.
- **Caching:** Redis/in-memory untuk metrik dashboard & kontak publik (TTL 5 menit), invalidate saat data berubah.

---

## 6. Non-Functional Requirements

### 6.1 Keamanan

- Autentikasi JWT/Session ketat; password di-hash (bcrypt, cost ≥ 12).
- RBAC per endpoint (Owner vs Admin/CS).
- Enkripsi data sensitif user (nomor WA/Telegram, email) at-rest (opsional v1.1).
- Sanitasi input (Zod/Joi), escape output (hindari XSS), parameterized query.
- Rate limiting login (5/15 menit per IP) & API (100/15 menit).
- Audit log untuk semua aksi mutasi (adjust kuota, ubah paket, edit kontak, dll).
- Helmet (CSP, HSTS, X-Frame-Options), CORS whitelist.

### 6.2 Performa

- Pagination server-side untuk tabel user & log (default 25, max 100).
- Indeks pada `user_id`, `created_at`, `status` di `bot_logs`.
- Caching metrik dashboard (TTL 60 detik) & kontak publik (TTL 5 menit).
- Optimasi query agregasi (materialized view / pre-computed stats) untuk MRR & volume pesan.
- Target: dashboard load < 2 detik, aksi CRUD < 500 ms.

### 6.3 Ketersediaan & Reliability

- Graceful shutdown, health endpoint `/health`.
- Backup DB harian.
- Retry mechanism untuk webhook pembayaran.
- Logging terstruktur (pino) dengan level.

### 6.4 Usability

- Responsif (mobile/tablet/desktop) — Mazer sudah responsive.
- Dark/Light mode toggle bawaan Mazer.
- Pesan error Bahasa Indonesia yang jelas.
- Empty state informatif.

---

## 7. Roadmap / Milestone (Saran)

| Fase | Durasi (est.) | Deliverable |
|------|---------------|-------------|
| Fase 0 — Setup | 3 hari | Scaffold, Mazer assets, Express, JWT auth, login |
| Fase 1 — Analytics | 5 hari | Summary cards, growth chart, volume chart, donut |
| Fase 2 — User & Subscription | 5 hari | Tabel user, adjust kuota/paket, riwayat pembayaran |
| Fase 3 — Log Viewer | 4 hari | Log pesan AI, detail, troubleshooting transaksi |
| Fase 4 — Contact Management | 3 hari | CRUD kontak, endpoint publik, cache |
| Fase 5 — Reporting | 3 hari | Ekspor CSV/Excel, laporan MRR/ARR |
| Fase 6 — Polish & QA | 4 hari | Dark mode, responsive, security, testing |

**Total MVP (Fase 0–5): ~24 hari kerja.**

---

## 8. Acceptance Criteria (MVP)

- [ ] Login Owner/Admin berfungsi dengan JWT + RBAC.
- [ ] Dashboard menampilkan 4 KPI + 3 chart.
- [ ] Tabel user dengan filter paket/status + pagination.
- [ ] Adjust kuota & ubah paket user berfungsi + audit log.
- [ ] Riwayat pembayaran QRIS dengan status filter.
- [ ] Log viewer pesan AI dengan filter & detail modal.
- [ ] CRUD kontak support berfungsi; endpoint publik mengembalikan data aktif.
- [ ] Ekspor CSV/Excel transaksi & langganan berfungsi.
- [ ] Status bot (WA/Telegram) tampil real-time.
- [ ] Dark mode toggle berfungsi di semua halaman.

---

*Dokumen ini disusun sebagai pedoman pengembangan Web Dashboard Admin & Owner bagi platform CatatAja, siap digunakan oleh developer dan AI Coding Assistant.*