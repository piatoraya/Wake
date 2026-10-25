# Product Requirement Document (PRD)

## Web Dashboard Admin — Bot Pencatat Keuangan (WhatsApp)

**Proyek:** `wa-bot-pencatat-keuangan` (Wake)
**Versi Dokumen:** 1.0
**Status:** Draft siap implementasi
**Template UI:** Mazer Admin Dashboard (Bootstrap 5) — https://github.com/zuramai/mazer
**Target Pengguna:** Owner (akses penuh) & Admin Operasional (akses terbatas)

---

## 1. Project Overview & Objective

### 1.1 Latar Belakang

Bot WhatsApp pencatat keuangan saat ini menyimpan seluruh data (pengguna, transaksi, wallet, budget) dalam file JSON lokal yang ditulis secara atomik dengan antrean per-koleksi. Data ini kaya (pemasukan/pengeluaran, kategori, wallet, sumber input text/voice/receipt, item struk, jam transaksi), tetapi **tidak ada antarmuka visual** untuk memantau, mengelola, dan menganalisisnya. Owner/Admin harus mengandalkan perintah chat (`!rekap`, `!backup`) yang terbatas dan tidak interaktif.

### 1.2 Tujuan Utama

1. Menyediakan **Web Dashboard Admin** berbasis template **Mazer** untuk memantau KPI keuangan secara visual (grafik, kartu metrik, tabel).
2. Memungkinkan **manajemen data transaksi** (tambah/edit/hapus) tanpa harus lewat chat WhatsApp.
3. Memberikan **kontrol kategori, pengguna, dan laporan** (ekspor PDF/Excel/CSV) untuk Owner.
4. Menyediakan **monitoring status bot** (online/offline, log error, rotasi API key Gemini).
5. Menjaga **integritas data** dengan RBAC, audit log, dan validasi input.

### 1.3 KPI/Metrik Utama di Dashboard Utama

Harus langsung terlihat (above the fold) saat halaman dashboard dibuka:

| # | Metrik | Sumber | Tampilan |
|---|--------|--------|----------|
| 1 | Total Pemasukan (bulan berjalan) | `getStats` | Stat Card (hijau) |
| 2 | Total Pengeluaran (bulan berjalan) | `getStats` | Stat Card (merah) |
| 3 | Saldo Bersih / Net Profit | `getStats.net` | Stat Card (biru) |
| 4 | Total Transaksi Bulan Ini | `getStats.count` | Stat Card (ungu) |
| 5 | Jumlah Pengguna Aktif | `listUsers` | Stat Card |
| 6 | Saldo per Wallet (Cash, BCA, QRIS, GoPay) | `getWalletBalances` | Widget mini |
| 7 | Top 5 Kategori Pengeluaran | `getCategoryExpenses` | Donut chart |
| 8 | Tren Arus Kas Harian/Bulanan | `listTransactions` agregasi | Line/Bar chart |
| 9 | Progress Budget per Kategori | `getBudgets` + expenses | Progress bar |
| 10 | Alert Budget ≥ 80% | rule engine | Badge/alert |

---

## 2. UI System & Design Integration (Mazer Adaptation)

### 2.1 Struktur Template Mazer yang Digunakan

- **Layout:** Sidebar + Navbar + Content area + Footer.
- **Sidebar Navigation:** menu bertingkat dengan ikon (Bootstrap Icons yang dibawa Mazer).
- **Navbar:** brand, global search, notifikasi, **Dark Mode toggle bawaan Mazer**, profil dropdown.
- **Cards:** `.card` dengan header, body, footer; metric widgets di atas dashboard.
- **Charts:** ApexCharts (bundle Mazer) untuk line/bar/donut.
- **Tables:** Simple-DataTables (bawaan Mazer) atau jQuery DataTables untuk sorting/pagination/search.
- **Modals:** Bootstrap 5 Modal untuk form CRUD.
- **Forms:** floating labels, validasi Bootstrap.
- **Toast/Alert:** untuk feedback aksi.
- **Dark Mode:** Mazer menyimpan preferensi di `localStorage` (`theme`), toggle di navbar. Pastikan custom CSS mendukung `data-bs-theme="dark"`.

### 2.2 Pemetaan Komponen UI

| Kebutuhan | Komponen Mazer |
|-----------|----------------|
| Ringkasan Pemasukan/Pengeluaran/Saldo | Stat Cards (`.card` + ikon + angka besar) |
| Grafik Tren Arus Kas | ApexCharts Line/Bar |
| Breakdown Kategori | ApexCharts Donut/Pie |
| Tabel Transaksi & User | Simple-DataTables |
| Form Tambah/Edit/Hapus | Bootstrap Modal + Form |
| Filter Tanggal/Jenis/Kategori | Form select + date range picker |
| Status Bot (Online/Offline) | Badge + ikon di navbar/sidebar footer |
| Log Error | List group / table di halaman System |
| Dark Mode | Toggle bawaan Mazer (navbar) |

### 2.3 Konvensi Styling

- Gunakan **variabel CSS Mazer** (`--bs-primary`, dll.) agar konsisten dengan dark mode.
- Format rupiah: `Rp 25.000` (sesuai `formatRupiah` bot).
- Tanggal: format Indonesia (`18 Oktober 2026`), jam lokal zona user.
- Warna semantik: pemasukan hijau, pengeluaran merah, net biru, warning kuning.

---

## 3. Core Features & Requirements

### 3.1 Dashboard Analytics Overview

**F-01 Summary Cards**
- 4 kartu utama: Total Pemasukan, Total Pengeluaran, Net Profit/Saldo, Total Transaksi Bulan Ini.
- Filter periode: bulan berjalan (default), pilih bulan/tahun, atau "Semua waktu".
- Trend indicator (naik/turun vs bulan lalu) opsional (v1.1).

**F-02 Cash Flow Chart**
- Grafik garis/batang perbandingan Pemasukan vs Pengeluaran.
- Granularitas: harian (default bulan berjalan) atau bulanan (12 bulan terakhir).
- Tooltip dengan nilai rupiah.

**F-03 Category Distribution**
- Donut chart pengeluaran per kategori (top 8 + "Lainnya").
- Klik kategori -> filter tabel transaksi.

**F-04 Widget Tambahan**
- Saldo per wallet (progress/badge).
- Progress budget per kategori dengan alert ≥ 80%.
- Transaksi terbaru (5 item).

### 3.2 Transaction Management

**F-05 Datatable Transaksi**
- Kolom: Tanggal, Pengguna, Jenis, Kategori, Wallet, Deskripsi, Jumlah, Sumber (text/voice/receipt), Aksi.
- Filter: range tanggal, jenis (income/expense), kategori, wallet, pengguna, sumber.
- Search global, sort, pagination (server-side untuk dataset besar).
- Export hasil filter ke CSV/Excel/PDF.

**F-06 Modal Form CRUD**
- Tambah transaksi manual (Owner & Admin).
- Edit transaksi (Owner & Admin) — field: tanggal, jenis, kategori, wallet, deskripsi, jumlah, items (opsional).
- Hapus transaksi (Owner: langsung; Admin: dengan konfirmasi + alasan).
- Validasi: jumlah > 0, kategori valid, wallet valid, tanggal valid.

**F-07 Bulk Actions (v1.1)**
- Pilih banyak transaksi untuk hapus/ubah kategori (Owner only).

### 3.3 Category Management

**F-08 CRUD Kategori & Sub-kategori**
- Field: nama, tipe (income/expense/both), parent (sub-kategori), ikon, warna, status aktif.
- Validasi: tidak boleh hapus kategori yang masih dipakai transaksi (atau reassign).
- Kategori default (seed) tidak boleh dihapus, hanya dinonaktifkan.

### 3.4 User Management

**F-09 Daftar Pengguna Bot**
- Kolom: Nomor (masked), Nama, Zona Waktu, Tgl Daftar, Total Transaksi, Total Pemasukan, Total Pengeluaran.
- Detail pengguna: daftar transaksi, wallet, budget.
- Aksi: reset data pengguna (Owner only, dengan konfirmasi), ubah zona waktu.
- Pencarian by nomor/nama.

### 3.5 Financial Reporting & Export

**F-10 Laporan**
- Laporan bulanan: ringkasan + breakdown kategori + per wallet.
- Laporan tahunan: tren 12 bulan.
- Filter custom range tanggal.
- Ekspor: PDF (ringkasan + tabel), Excel (multi-sheet: Transaksi, Ringkasan, Kategori, Wallet), CSV (transaksi mentah).

### 3.6 Bot Status & System Monitor

**F-11 Status Koneksi Bot**
- Indikator Online/Offline/Reconnecting di navbar.
- Info: nomor bot, metode koneksi (pairing/qr), versi WA, uptime.
- Tombol: reconnect (Owner only), logout/pairing ulang (Owner only).

**F-12 Log Aktivitas & Error**
- Tabel log: timestamp, level (info/warn/error), modul, pesan.
- Filter level & tanggal.
- Download log file.

**F-13 Monitoring Rotasi Gemini**
- Tampilkan status API key (masked), model, pasangan cooldown, key invalid.
- Aksi: reload config (kirim `!reload` equivalent), reset cooldown (Owner only).

### 3.7 Contact & Support Settings (Fitur Baru)

**F-14 Form Pengaturan Kontak (Dashboard)**
- Form (Mazer Modal/Form) untuk mengelola:
  - Nomor WhatsApp CS/Admin (format internasional, tanpa `+`)
  - Email / Link Support
  - Email Support
  - Link FAQ / Bantuan
  - Jam Operasional (teks bebas, mis. "Senin–Jumat 09:00–17:00 WIB")
- Field: `key`, `label`, `value`, `is_active`, `updated_at`, `updated_by`.
- Validasi: format email, URL, nomor WA; sanitasi input (hindari XSS).
- Simpan ke koleksi `system_contacts` / `settings` (array) agar mudah diekspor & diaudit.

**F-15 Integrasi Dinamis dengan Landing Page**
- Endpoint publik (tanpa auth) `GET /api/public/contacts` mengembalikan kontak aktif.
- Landing Page mengonsumsi endpoint ini untuk menampilkan info kontak secara dinamis.
- Caching (in-memory/Redis) dengan TTL 5 menit agar landing page fast-loading; invalidate saat kontak diperbarui.

**F-16 Hak Akses**
- Owner & Admin Operasional dapat memperbarui (Edit/Save) data kontak.
- Semua perubahan dicatat di audit log (siapa, kapan, sebelum/sesudah).

### 3.8 Settings (Owner Only)

- Konfigurasi bot (prefix, timezone default, backup dir) — read-only view + edit dengan restart.
- Manajemen admin users (CRUD, role, reset password).
- Backup manual trigger (kirim Excel ke semua user).

---

## 4. User Roles & Access Control (RBAC)

### 4.1 Role: Owner

- Akses penuh ke semua fitur.
- Statistik keuangan semua pengguna + global.
- Manajemen user bot (reset data).
- Manajemen admin users.
- Ekspor data.
- Konfigurasi bot & system monitor (reconnect, logout, reset cooldown).
- Hapus transaksi tanpa konfirmasi tambahan (tetap audit log).

### 4.2 Role: Admin Operasional

- Dashboard analytics (read-only, semua pengguna atau scoped? default: semua pengguna ringkasan).
- CRUD transaksi (tambah/edit/hapus dengan konfirmasi).
- Verifikasi/kelola kategori.
- Lihat laporan dasar (ekspor CSV/Excel transaksi; PDF laporan Owner only).
- **Tidak boleh:** reset data pengguna, kelola admin users, konfigurasi bot, hapus massal, reset cooldown.

### 4.3 Matriks Izin (Ringkas)

| Fitur | Owner | Admin |
|-------|:-----:|:-----:|
| Lihat Dashboard & Chart | ✅ | ✅ |
| Lihat Tabel Transaksi | ✅ | ✅ |
| Tambah Transaksi | ✅ | ✅ |
| Edit Transaksi | ✅ | ✅ |
| Hapus Transaksi (single) | ✅ | ✅ (konfirmasi) |
| Bulk Delete/Update | ✅ | ❌ |
| CRUD Kategori | ✅ | ✅ (verifikasi) |
| Lihat User Management | ✅ | ✅ (read-only) |
| Reset Data Pengguna | ✅ | ❌ |
| Ekspor CSV/Excel | ✅ | ✅ |
| Ekspor PDF Laporan | ✅ | ❌ |
| Edit Kontak & Support Settings | ✅ | ✅ |
| Bot Status & Log | ✅ | ✅ (read-only) |
| Reconnect/Logout Bot | ✅ | ❌ |
| Manajemen Admin Users | ✅ | ❌ |
| Settings/Konfigurasi | ✅ | ❌ |

---

## 5. Data Structure & Integration Strategy

### 5.1 Skema Data (Tabel/Koleksi Utama)

**users** (dari `users.json`)
- `phone` (PK, string), `name`, `created_at` (ISO), `timezone` (IANA).

**transactions** (dari `transactions.json`)
- `id` (UUID PK), `user_phone` (FK users.phone), `type` (income/expense), `amount` (int), `category`, `wallet`, `description`, `date` (ISO), `created_at`, `items` (JSON array, opsional), `source` (text/voice/receipt).

**wallets** (dari `wallets.json`)
- `user_phone` (FK), `name`, `initial_balance` (int), `created_at`. PK komposit (user_phone, name).

**budgets** (dari `budgets.json`)
- `id` (UUID PK), `user_phone` (FK), `category`, `limit` (int), `created_at`.

**categories** (baru — `categories.json`)
- `id` (UUID PK), `name`, `type` (income/expense/both), `parent_id` (FK self, nullable), `icon`, `color`, `is_active` (bool), `is_default` (bool), `created_at`, `updated_at`.

**system_contacts** (baru — `contacts.json`)
- `id` (UUID PK), `key` (unique, mis. `whatsapp_admin`, `email_support`, `faq_link`, `operational_hours`), `label`, `value`, `is_active` (bool), `updated_at`, `updated_by` (FK admin_users.id).

**admin_users** (baru — `admin_users.json` atau DB)
- `id` (UUID PK), `username` (unique), `password_hash` (bcrypt), `role` (owner/admin), `name`, `email`, `is_active`, `last_login`, `created_at`.

**audit_logs** (baru)
- `id` (UUID PK), `admin_id` (FK admin_users.id), `action` (create/update/delete/login/export), `entity` (transaction/category/user/...), `entity_id`, `before` (JSON), `after` (JSON), `ip`, `user_agent`, `created_at`.

### 5.2 Strategi Sinkronisasi Bot ↔ Dashboard

**Masalah:** bot dan web jika berbeda proses tidak berbagi antrean tulis in-memory (`writeQueues`), sehingga race condition.

**Rekomendasi (bertahap):**

1. **MVP (Monolith, satu proses Node):**
   - Tambahkan Express server di proses bot yang sama (`src/web/server.js`).
   - Static assets Mazer disajikan dari `public/` (atau `src/web/public/`).
   - Endpoint REST memanggil modul `database.js` yang sama → antrean tulis tetap aman.
   - Auth JWT disimpan di memory/DB; session cookie httpOnly.

2. **v1.1 (Shared DB):**
   - Migrasi koleksi JSON ke **SQLite** (better-sqlite3) dengan WAL mode, atau PostgreSQL.
   - Bot & web bisa proses terpisah; concurrency ditangani DB.
   - Sediakan migration script dari JSON → DB.

3. **Sinkronisasi real-time (opsional):**
   - Server-Sent Events (SSE) atau WebSocket untuk push transaksi baru ke dashboard.
   - Atau polling ringan (15–30 detik) untuk MVP.

**API Contract (ringkas):**

| Method | Endpoint | Deskripsi | Role |
|--------|----------|-----------|------|
| POST | `/api/auth/login` | Login admin | Public |
| POST | `/api/auth/refresh` | Refresh token | Auth |
| GET | `/api/dashboard/summary?month=YYYY-MM` | KPI | Auth |
| GET | `/api/dashboard/cashflow?granularity=daily\|monthly` | Chart data | Auth |
| GET | `/api/dashboard/categories?month=...` | Donut data | Auth |
| GET | `/api/transactions` | List + filter + pagination | Auth |
| POST | `/api/transactions` | Tambah | Auth |
| PUT | `/api/transactions/:id` | Edit | Auth |
| DELETE | `/api/transactions/:id` | Hapus | Auth |
| GET/POST/PUT/DELETE | `/api/categories` | CRUD kategori | Auth (delete Owner) |
| GET | `/api/users` | List pengguna bot | Auth |
| GET | `/api/users/:phone` | Detail | Auth |
| DELETE | `/api/users/:phone/data` | Reset data | Owner |
| GET | `/api/wallets/:phone` | Saldo wallet | Auth |
| GET | `/api/budgets/:phone` | Budget | Auth |
| GET | `/api/reports/monthly?month=...&format=pdf\|xlsx\|csv` | Ekspor | Auth (pdf Owner) |
| GET | `/api/bot/status` | Status koneksi | Auth |
| POST | `/api/bot/reconnect` | Reconnect | Owner |
| GET | `/api/bot/gemini-status` | Rotasi API key/model | Auth |
| GET | `/api/contacts` | List kontak support | Auth |
| PUT | `/api/contacts/:key` | Update kontak support | Auth (Owner/Admin) |
| GET | `/api/public/contacts` | Kontak aktif (publik, untuk landing page) | Public |
| GET | `/api/logs?level=...` | Log | Auth (download Owner) |
| GET/POST/PUT/DELETE | `/api/admin-users` | Manajemen admin | Owner |
| GET | `/api/audit-logs` | Audit | Owner |

**Format respons standar:**
```json
{ "success": true, "data": {...}, "meta": { "page": 1, "limit": 25, "total": 120 } }
```
Error:
```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }
```

---

## 6. Non-Functional Requirements

### 6.1 Keamanan

- **Authentication:** JWT access token (15–30 menit) + refresh token (7 hari) di httpOnly cookie; password di-hash bcrypt (cost ≥ 12).
- **RBAC:** middleware cek role per endpoint; Owner-only routes dilindungi.
- **Sanitasi Input:** validasi dengan Zod/Joi; escape output (hindari XSS); parameterized query bila migrasi DB.
- **Rate Limiting:** login (5/15 menit per IP), API umum (100/15 menit).
- **Headers:** Helmet (CSP, HSTS, X-Frame-Options).
- **CORS:** whitelist origin dashboard.
- **Audit Log:** semua aksi mutasi dicatat (siapa, kapan, sebelum/sesudah).
- **Secrets:** jangan commit `.env`; token/secret di env; masked API key di UI.
- **Session:** logout invalidasi refresh token; auto-logout setelah idle (30 menit).

### 6.2 Performa

- **Pagination server-side** datatable (default 25, max 100).
- **Caching statistik** (node-cache 60 detik) untuk summary/dashboard; invalidate saat transaksi berubah.
- **Indeks** pada `user_phone`, `date`, `type`, `category` (saat migrasi DB).
- **Lazy load** chart data (fetch paralel).
- **Compression** (gzip) response.
- Target: halaman dashboard < 2 detik (cold), aksi CRUD < 500 ms.

### 6.3 Ketersediaan & Reliability

- Bot & web dalam satu proses untuk MVP; jika bot restart, web ikut restart (acceptable MVP).
- Graceful shutdown: simpan state, tutup koneksi.
- Backup otomatis DB harian (copy file) selain backup Excel.

### 6.4 Usability & Aksesibilitas

- Responsif (mobile/tablet/desktop) — Mazer sudah responsive.
- Dark mode persisten (Mazer bawaan).
- Keyboard navigation & ARIA labels pada modal/form.
- Pesan error Bahasa Indonesia yang jelas.
- Empty state yang informatif.

### 6.5 Observability

- Logging terstruktur (pino) dengan level.
- Health endpoint `/health`.
- Metrik dasar (request count, latency) opsional.

---

## 7. Integrasi Template Mazer — Langkah Implementasi

1. Clone/download Mazer (Bootstrap 5 version) dari repo resmi.
2. Salin `assets/` (css, js, fonts, images) ke `public/assets/` (atau `src/web/public/assets/`).
3. Buat layout base (sidebar + navbar + footer) dengan partials EJS/Handlebars atau komponen framework.
4. Implementasikan dark mode toggle bawaan Mazer (sudah berfungsi via JS).
5. Ganti contoh data Mazer dengan data real dari API.
6. Tambahkan halaman: Dashboard, Transactions, Categories, Users, Reports, System, Settings, Login.
7. Pastikan semua chart (ApexCharts) diinisialisasi ulang saat dark mode berubah (re-render).

---

## 8. Roadmap / Milestone

| Fase | Durasi (est.) | Deliverable |
|------|---------------|-------------|
| Fase 0 — Setup | 3 hari | Project scaffold, Mazer assets, Express server, JWT auth, login page |
| Fase 1 — Dashboard | 5 hari | Summary cards, cashflow chart, category donut, widget wallet/budget |
| Fase 2 — Transaksi | 5 hari | Datatable + filter + modal CRUD + validasi |
| Fase 3 — Kategori & User | 4 hari | CRUD kategori, user management, detail user |
| Fase 4 — Laporan & Export | 4 hari | PDF/Excel/CSV export, laporan bulanan/tahunan |
| Fase 5 — System Monitor | 3 hari | Status bot, log viewer, Gemini status, audit log |
| Fase 6 — Polish & QA | 4 hari | Dark mode, responsive, aksesibilitas, testing, docs |
| Fase 7 — Migrasi DB (opsional) | 5 hari | SQLite migration + indeks |

**Total MVP (Fase 0–5): ~24 hari kerja.**

---

## 9. Risiko & Mitigasi

| Risiko | Dampak | Mitigasi |
|--------|--------|----------|
| Race condition JSON (bot vs web) | Data corrupt | Monolith proses untuk MVP; migrasi DB v1.1 |
| Kuota Gemini habis | Parsing gagal | Rotasi key/model sudah ada; dashboard tampilkan status |
| Bot offline | Data tidak update | Status indicator + reconnect dari dashboard |
| XSS dari deskripsi transaksi | Keamanan | Sanitasi output, CSP |
| Dataset besar | Performa | Server-side pagination + indeks |
| Dark mode chart tidak terbaca | UX | Re-render chart on theme change |

---

## 10. Acceptance Criteria (MVP)

- [ ] Login Owner/Admin berfungsi dengan JWT.
- [ ] Dashboard menampilkan 4 KPI + 2 chart + widget wallet/budget.
- [ ] Tabel transaksi dengan filter tanggal/jenis/kategori + pagination.
- [ ] Modal tambah/edit/hapus transaksi berfungsi dan tervalidasi.
- [ ] CRUD kategori dengan proteksi kategori default.
- [ ] User management menampilkan statistik per pengguna.
- [ ] Ekspor CSV & Excel transaksi berfungsi.
- [ ] Status bot (online/offline) tampil real-time (polling ≤ 30s).
- [ ] Dark mode toggle berfungsi di semua halaman.
- [ ] RBAC teruji (Admin tidak bisa akses Owner-only).
- [ ] Audit log mencatat aksi mutasi.

---

## 11. Lampiran — Mapping Kode Bot → Dashboard

| Fitur Dashboard | Fungsi Bot yang Dipakai |
|-----------------|------------------------|
| Summary KPI | `getStats(phone, month)` |
| Saldo Wallet | `getWalletBalances(phone)` |
| Kategori Pengeluaran | `getCategoryExpenses(phone, month)` |
| List Transaksi | `listTransactions(phone, {month, type})` |
| Tambah Transaksi | `addTransaction(fields)` |
| Budget | `getBudgets(phone)`, `setBudget(phone, category, limit)` |
| Saldo Wallet Awal | `setWalletBalance(phone, name, initialBalance)` |
| User | `listUsers()`, `getUser(phone)`, `getUserTimezone(phone)` |
| Status Rotasi Gemini | `getRotationStatus()` |
| Backup Excel | `sendBackup(...)` (reuse) |

---

*Dokumen ini disusun sebagai panduan utama bagi developer dan AI Coding Assistant (Cursor/Copilot). Setiap fitur dapat dipecah menjadi task sprint sesuai roadmap di Bagian 8.*
