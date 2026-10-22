# Product Requirement Document (PRD) — Teknis & Komprehensif

## CatatAja Web Dashboard Admin & System Architecture
**Produk:** CatatAja (https://catataja.id/)  
**Dokumen:** PRD Teknis Web Dashboard Admin & Arsitektur Sistem  
**Versi:** 1.0  
**Status:** Siap Implementasi  
**Target Pembaca:** Developer, Tech Lead, AI Coding Assistant (Cursor/Copilot)  
**Basis Teknologi:** Node.js (ESM) · Baileys (WhatsApp Multi-Session) · Telegraf/Telegram (opsional) · File-Based JSON Storage · Mazer Admin Dashboard (Bootstrap 5)

---

## 1. Executive Summary & Architecture Overview

### 1.1 Latar Belakang
CatatAja adalah layanan pencatatan keuangan berbasis AI yang diakses melalui WhatsApp dan Telegram. Pengguna mencatat transaksi dengan teks natural, foto struk (OCR), dan voice note. Untuk mengoperasikan platform secara efisien dibutuhkan **Web Dashboard Admin** terpusat untuk memantau KPI, mengelola pengguna & tier, men-troubleshoot parsing AI, mengelola kontak support, serta mengelola **instansi bot mandiri milik user Sultan**.

### 1.2 Tujuan
1. Menyediakan antarmuka visual (Mazer) untuk monitoring dan operasional.
2. Menegakkan **Business Rules & Quota Engine** berbasis tier (Free, Basic, Premium, Sultan).
3. Mendukung **multi-session Baileys** terisolasi untuk user Sultan (custom bot instance).
4. Menyediakan mekanisme **backup & restore** data JSON.
5. Menjaga **integritas data** pada penyimpanan file-based (atomic write + locking).

### 1.3 Arsitektur Tingkat Tinggi
```
┌──────────────────────────────────────────────────────────────┐
│                      CatatAja Platform                       │
├──────────────┬──────────────┬──────────────┬────────────────┤
│  WhatsApp    │  Telegram    │  Web Admin   │  Landing Page  │
│  (Baileys)   │  (Bot API)   │  (Mazer UI)  │  catataja.id   │
└──────┬───────┴──────┬───────┴──────┬───────┴────────┬───────┘
       │              │              │                │
       └──────────────┴──────────────┴────────────────┘
                             │
                    ┌────────┴────────┐
                    │  Node.js Core   │
                    │  (Single Proc.) │
                    ├─────────────────┤
                    │ Quota Engine    │
                    │ Tier Manager    │
                    │ Baileys Mgr     │
                    │ Backup Service  │
                    │ Auth (JWT)      │
                    └────────┬────────┘
                             │
                    ┌────────┴────────┐
                    │  File-Based DB  │
                    │  /database/*.json│
                    │  /sessions/     │
                    └─────────────────┘
```

**Prinsip desain:**
- **Monolith satu proses Node.js** (bot + web dashboard) untuk MVP; concurrency ditangani antrean tulis per-koleksi.
- **Penyimpanan file JSON** dengan atomic write + mutex in-process.
- **Baileys multi-session** terisolasi per bot instance Sultan.
- **Mazer** sebagai template UI (Bootstrap 5).

### 1.4 Aktor
- **Owner**: akses penuh (harga/paket, admin users, konfigurasi sistem, domain).
- **Admin/CS**: operasional (user, transaksi, kontak support, troubleshooting).
- **User Bot** (Free/Basic/Premium/Sultan): pengguna layanan.
- **Sultan Bot Instance**: bot mandiri milik user Sultan.

---

## 2. Data Schema Definition

### 2.1 Struktur Folder
```
/database
  ├── users.json
  ├── transactions.json
  ├── system_contacts.json
  └── backups/
       └── <phone>_<timestamp>.json
/sessions
  ├── baileys_auth_main/
  └── baileys_auth_<nama_bot_sultan>/
/logs (opsional)
```

### 2.2 `users.json`
```json
[
  {
    "user_id": "uuid-v4",
    "phone": "6281234567890",
    "name": "Nama User",
    "platform": "whatsapp",
    "tier": "free",
    "text_quota_used": 0,
    "media_quota_used": 0,
    "last_media_reset_daily": "2026-10-23",
    "quota_reset_date": "2026-10-01",
    "tier_expired_at": "2026-11-23T00:00:00.000Z",
    "sultan_bot_limit": 1,
    "active_bot_instances": [
      {
        "bot_id": "uuid-v4",
        "name": "bot_toko_budi",
        "slug": "bot_toko_budi",
        "session_dir": "baileys_auth_bot_toko_budi",
        "phone": "6289999999999",
        "status": "connected",
        "created_at": "2026-10-23T10:00:00.000Z",
        "updated_at": "2026-10-23T10:05:00.000Z"
      }
    ],
    "created_at": "2026-10-01T00:00:00.000Z",
    "updated_at": "2026-10-23T10:00:00.000Z"
  }
]
```

**Field description:**
| Field | Tipe | Deskripsi |
|-------|------|-----------|
| `user_id` | UUID | Primary key internal |
| `phone` | string | Nomor E.164 tanpa `+` (key bisnis) |
| `tier` | enum | `free \| basic \| premium \| sultan` |
| `text_quota_used` | number | Jumlah input teks terpakai bulan berjalan |
| `media_quota_used` | number | Jumlah OCR/VN terpakai bulan berjalan (Premium) |
| `last_media_reset_daily` | date | Reset harian limit media (Basic) |
| `quota_reset_date` | date | Tanggal reset kuota bulanan (`YYYY-MM-01`) |
| `tier_expired_at` | ISO datetime | Masa aktif tier berbayar |
| `sultan_bot_limit` | number | Limit instansi bot Sultan |
| `active_bot_instances` | array | Daftar bot mandiri milik user |

### 2.3 `transactions.json`
```json
[
  {
    "id": "uuid-v4",
    "user_phone": "6281234567890",
    "type": "expense",
    "amount": 25000,
    "category": "Makanan & Minuman",
    "wallet": "QRIS",
    "description": "Beli kopi",
    "source": "text",
    "date": "2026-10-23T10:30:00.000Z",
    "created_at": "2026-10-23T10:30:01.000Z"
  }
]
```

### 2.4 `system_contacts.json`
```json
[
  {
    "key": "whatsapp_admin",
    "label": "WhatsApp Admin/CS",
    "value": "6281234567890",
    "is_active": true,
    "sort_order": 1
  },
  {
    "key": "telegram",
    "label": "Telegram",
    "value": "",
    "is_active": false,
    "sort_order": 2
  }
]
```

### 2.5 `backups/<phone>_<timestamp>.json`
```json
{
  "meta": {
    "phone": "6281234567890",
    "exported_at": "2026-10-23T10:00:00.000Z",
    "period": "2026-10"
  },
  "user": { },
  "transactions": [ ],
  "wallets": [ ],
  "budgets": [ ],
  "categories": [ ]
}
```

---

## 3. Business Rules & Quota Engine Algorithm

### 3.1 Spesifikasi Tier
| Tier | Harga | Teks | Media (OCR/VN) | Backup | Custom Bot |
|------|-------|------|----------------|--------|------------|
| Free | Rp 0 | 50/bulan | 0 | ❌ | ❌ |
| Basic | Rp 15.000 | 100/bulan (gabungan) | 1/hari | ❌ | ❌ |
| Premium | Rp 50.000 | Unlimited | 100/bulan | ✅ JSON | ❌ |
| Sultan | Rp 150.000 | Unlimited | Unlimited | ✅ JSON | ✅ (limit admin) |

### 3.2 Aturan Reset
- **Bulanan**: jika `quota_reset_date` (YYYY-MM-01) < bulan berjalan, reset `text_quota_used=0`, `media_quota_used=0`, set `quota_reset_date` ke bulan berjalan.
- **Harian (Basic)**: jika `last_media_reset_daily` < hari ini, reset `media_quota_used=0` (khusus Basic, media dihitung per hari) dan update tanggal.
- **Tier expired**: jika `tier_expired_at` < now dan tier berbayar, downgrade ke `free` dan catat audit.

### 3.3 Pseudocode Quota Engine
```text
function checkQuota(user, inputType): { allowed: boolean, reason?: string }
  // inputType: 'text' | 'media' (ocr/voice)
  ensureTierNotExpired(user)
  resetMonthlyIfNeeded(user)
  resetDailyIfNeeded(user, inputType)

  switch user.tier:
    case 'free':
      if inputType == 'media': return deny('Media tidak tersedia di tier Free')
      if user.text_quota_used >= 50: return deny('Kuota teks Free habis (50/bulan)')
      user.text_quota_used++
      return allow()

    case 'basic':
      total = user.text_quota_used + user.media_quota_used
      if total >= 100: return deny('Kuota Basic habis (100 transaksi/bulan)')
      if inputType == 'media' and user.media_quota_used_today >= 1:
          return deny('Limit media Basic: 1/hari')
      increment counters
      return allow()

    case 'premium':
      if inputType == 'media':
        if user.media_quota_used >= 100: return deny('Kuota media Premium habis (100/bulan)')
        user.media_quota_used++
      else:
        // teks unlimited
      return allow()

    case 'sultan':
      // unlimited all
      return allow()

  default:
    return deny('Tier tidak dikenali')
```

### 3.4 Bot Instance Limit (Sultan)
```text
function canCreateBotInstance(user):
  if user.tier != 'sultan': return deny('Fitur khusus Sultan')
  if user.active_bot_instances.length >= user.sultan_bot_limit:
     return deny(`Limit bot tercapai (${user.sultan_bot_limit})`)
  return allow()
```

### 3.5 Flow Upgrade/Downgrade
- **Payment verified (QRIS webhook)**: set `tier`, `tier_expired_at = now + 30 hari`, reset quota, audit log.
- **Admin command** `/setlevel <phone> <tier>` / `/setbotlimit <phone> <limit>`: validasi owner/admin, update, audit.
- **Web Dashboard Modal**: form edit user, validasi role, update, audit.
- **Downgrade Sultan → lain**: bot instances milik user **tidak** otomatis dihapus, tapi ditandai `suspended` dan tidak dapat pairing baru; admin dapat hapus manual.

---

## 4. Sultan Multi-Session Baileys Manager Specification

### 4.1 Struktur Sesi
```
/sessions
  ├── baileys_auth_main/                 # Bot utama CatatAja
  └── baileys_auth_<slug>/               # Bot mandiri Sultan
```
- `slug` = nama bot dinormalisasi: lowercase, `[a-z0-9_]+`, unik global.
- Satu folder per instance; tidak boleh saling berbagi kredensial.

### 4.2 Modul `SultanBotManager`
Tanggung jawab:
- `createInstance(ownerPhone, name)` → validasi limit → generate slug → buat folder → init Baileys socket → status `pairing`.
- `getInstance(botId)` → return socket/state.
- `requestPairingCode(botId)` → minta kode pairing (reuse pola `waitForSocketOpen`).
- `stopInstance(botId)` → end socket, status `stopped`.
- `deleteInstance(botId)` → stop + hapus folder (dengan konfirmasi) + update user.
- `listInstances(ownerPhone?)` → filter by owner.

### 4.3 Lifecycle Instance
```
requested → provisioning → pairing → connected → (disconnected → reconnecting) → stopped/deleted
```
- **Pairing**: QR atau pairing code, dirender di Web Dashboard (owner/admin) atau dikirim ke user Sultan via bot utama.
- **Reconnect**: exponential backoff, max 5 percobaan, lalu status `error`.
- **Health check**: heartbeat setiap 60 detik; update `status`, `last_seen`.

### 4.4 Isolasi & Keamanan
- Path traversal prevention: validasi slug sebelum akses folder.
- Satu socket per instance; event handler terisolasi.
- Logging per instance: prefix `[BOT:<slug>]`.
- Rate limit pairing request: max 1/60 detik per instance.

### 4.5 Web Dashboard Endpoints (Bot Instance)
| Method | Endpoint | Deskripsi | Role |
|--------|----------|-----------|------|
| GET | `/api/bot-instances` | List instance (filter owner) | Auth |
| POST | `/api/bot-instances` | Buat instance | Sultan (via owner/admin approval) |
| GET | `/api/bot-instances/:id` | Detail + status | Auth |
| POST | `/api/bot-instances/:id/pairing-code` | Minta kode pairing | Owner/Admin/Sultan-owner |
| POST | `/api/bot-instances/:id/restart` | Restart | Owner/Admin |
| DELETE | `/api/bot-instances/:id` | Hapus instance | Owner/Admin |

---

## 5. Web Admin UI/UX Requirements (Mazer)

### 5.1 Layout & Navigasi
- Sidebar Mazer dengan menu:
  - Dashboard
  - User Management
  - Transactions
  - Categories
  - Bot Instances (Sultan)
  - Contacts & Support
  - Reports & Backup
  - System Monitor
  - Settings (Domain, dsb.)
  - Admin Users (Owner only)
  - Audit Logs (Owner only)

### 5.2 Dashboard (Stat Cards)
- Total User (per tier: Free/Basic/Premium/Sultan)
- User Aktif Hari Ini
- Total Transaksi Bulan Ini
- Total Pemasukan/Pengeluaran
- Donut chart distribusi tier
- Line chart pertumbuhan user
- Bar chart volume pesan (teks/OCR/VN)

### 5.3 User Management (DataTables)
Kolom:
- ID, Phone, Name, Tier, Expired, Text Quota, Media Quota, Bot Limit, Bot Instances, Actions.

Modal **Edit User**:
- Dropdown Tier
- Date picker `tier_expired_at`
- Input kuota (adjust manual)
- Input `sultan_bot_limit`
- Toggle aktif/nonaktif
- Alasan perubahan (audit)

### 5.4 Bot Instances (DataTables)
Kolom:
- Bot Name, Owner, Phone, Status, Session Dir, Last Seen, Actions (Pairing, Restart, Delete).

### 5.5 Contacts & Support (CRUD)
Form edit kontak CS (WA, Telegram, Email, Jam Operasional, FAQ link) yang tampil dinamis di landing page via `/api/public/contacts`.

### 5.6 Backup & Restore (UI)
- Tombol **Download Backup (JSON)** per user / global.
- Upload file JSON untuk restore (Owner only) dengan validasi skema.

### 5.7 RBAC di UI
- Menu/aksi Owner-only disembunyikan untuk Admin (admin users, audit logs, settings inti, harga/paket).

---

## 6. Backup & Restore Mechanism Specification

### 6.1 Perintah Bot `/backup`
- Generate file JSON berisi data user (transaksi, wallet, budget, kategori).
- Kirim sebagai dokumen lampiran via Baileys.
- Penamaan: `backup_<phone>_<YYYYMMDD-HHMMSS>.json`.
- Tier gating: hanya Premium & Sultan.

### 6.2 Web Dashboard
- Endpoint `GET /api/reports/export?format=json|xlsx|pdf&month=...&phone=...`.
- Download langsung; audit log `export`.

### 6.3 Restore
- Endpoint `POST /api/restore` (Owner only) menerima file JSON.
- Validasi skema; buat backup otomatis sebelum restore (safety).
- Transaksi di-merge atau replace (opsi `mode=replace|merge`).

### 6.4 Retensi
- File backup di `/database/backups/` dipangkas otomatis > 7 hari (cron harian) kecuali `KEEP_BACKUP_FILE=true`.

---

## 7. Security, File Locking, & Concurrency Control

### 7.1 Atomic File Write
Semua penulisan JSON menggunakan pola:
1. Tulis ke file temp: `<file>.<pid>.<timestamp>.tmp`
2. `fsync` (opsional)
3. `rename` temp → target (atomic di POSIX)
4. Jika gagal, hapus temp.

### 7.2 In-Process Locking (Mutex per Koleksi)
- Setiap koleksi (`users`, `transactions`, ...) memiliki antrean (queue) serial.
- `withCollection(name, mutator)` membaca, mutasi, lalu menulis secara atomik dalam satu lock.
- Mencegah race condition antar request dalam satu proses.

### 7.3 Multi-Process Consideration
- MVP: satu proses Node (bot + web). Aman dengan mutex in-process.
- Jika dipisah (bot & web proses terpisah), gunakan file lock (`proper-lockfile`) atau migrasi ke SQLite (WAL) / PostgreSQL.

### 7.4 Validasi & Keamanan Input
- Validasi payload dengan Zod (schema per endpoint).
- Sanitasi path (slug, filename) untuk mencegah traversal.
- RBAC middleware (`authMiddleware`, `requireRole`).
- JWT access token 15–30 menit + refresh token 7 hari di httpOnly cookie.
- Password bcrypt cost ≥ 12.
- Rate limiting (login & API).
- Helmet, CORS berbasis domain tersimpan.
- Audit log setiap aksi mutasi.

### 7.5 Concurrency Bot Instances
- Setiap instance Sultan memiliki socket terpisah; tidak berbagi state.
- Pairing code request di-serialize per instance.
- Reconnect dengan backoff; batas percobaan.

### 7.6 Backup Sebelum Operasi Destruktif
- Reset data user, restore, delete instance → buat backup otomatis terlebih dahulu.

---

## Lampiran A — API Contract (Ringkas)
| Method | Endpoint | Deskripsi | Role |
|--------|----------|-----------|------|
| POST | `/api/auth/login` | Login admin | Public |
| GET | `/api/dashboard/summary` | KPI | Auth |
| GET/POST/PUT/DELETE | `/api/transactions` | CRUD transaksi | Auth |
| GET/POST/PUT/DELETE | `/api/categories` | CRUD kategori | Auth (delete Owner) |
| GET | `/api/users` | List user bot | Auth |
| PUT | `/api/users/:phone` | Edit tier/kuota/bot limit | Owner/Admin |
| DELETE | `/api/users/:phone/data` | Reset data | Owner |
| GET/POST/PUT/DELETE | `/api/bot-instances` | Manajemen bot Sultan | Auth/Owner |
| GET/PUT | `/api/contacts` | Kontak support | Auth |
| GET | `/api/public/contacts` | Kontak publik | Public |
| GET | `/api/settings` | Baca settings (domain) | Auth |
| PUT | `/api/settings` | Atur domain | Owner |
| GET | `/api/audit-logs` | Audit | Owner |

## Lampiran B — Non-Functional Requirements
- **Performance**: caching statistik 60 detik; invalidate saat transaksi berubah.
- **Observability**: log terstruktur, audit log, status bot & Gemini rotation.
- **Scalability**: file-based cocok MVP (ratusan user). Migrasi ke SQLite/Postgres untuk skala besar.
- **Reliability**: atomic writes, backup otomatis, reconnect bot.

---

**Akhir Dokumen.**