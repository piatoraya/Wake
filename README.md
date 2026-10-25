# 📒 WhatsApp Bot Pencatat Keuangan

Bot WhatsApp untuk mencatat keuangan pribadi dengan bahasa natural (teks **dan voice note**), lengkap dengan **laporan rekap**, **backup Excel otomatis**, dan **cronjob terjadwal**.

Dibangun dengan **Node.js (ESM)** + **Baileys (Pairing Code / QR Code)** + **Google Gemini** + **ExcelJS** + **node-cron** + **database JSON lokal (safe write)**.

> 🔐 **Dua metode koneksi WhatsApp, dipilih di terminal sebelum scan/kode:**
> `1) Pairing Code` atau `2) QR Code`.
> Jika `BOT_NUMBER` kosong, bot menanyakan nomor saat dijalankan (khusus Pairing Code).

---

## ✨ Fitur

| Fitur | Deskripsi |
|---|---|
| 🗣️ Catat natural | _"Beli kopi 25rb pakai QRIS"_ → tersimpan otomatis sebagai pengeluaran |
| 🎤 Voice note | Kirim voice note, Gemini yang men-transkripsi + ekstraksi datanya |
| 🧾 Baca struk | Kirim **foto struk** → Gemini baca total, toko, tanggal, metode bayar & item, lalu dicatat 1 transaksi |
| 🧠 AI Parsing | Gemini mengubah pesan → JSON terstruktur (`intent` + `data`) |
| 🔄 Rotasi model | `GEMINI_MODEL=model-a,model-b` — saat model pertama kena 429 (kuota habis), bot otomatis pindah model |
| 🔑 Rotasi API key | `GEMINI_API_KEYS=key1,key2,key3` — tiap key = 1 project = kuota terpisah; saat satu key kena 429/401/403, bot otomatis pindah key |
| 📨 Laporan ke owner | Bot mengirim laporan ke nomor owner saat **semua kuota Gemini habis** atau semua API key tidak valid |
| 📊 Rekap | `!rekap` — pemasukan, pengeluaran, selisih, saldo per wallet, top kategori, progress budget |
| 📥 Backup Excel | `!backup` — bot mengirim file `.xlsx` sebagai lampiran WhatsApp |
| 🕒 Auto Backup | Cronjob mingguan & bulanan mengirim Excel ke semua user |
| 👛 Wallet & Budget | Saldo awal wallet + budget bulanan per kategori, dengan alert otomatis (≥80%) |
| 🔒 Anti corrupt | Tulis atomik (`tmp` + `rename`) + antrean per-file + arsip file korup |
| 🔁 Reconnect | Penanganan `DisconnectReason` (kecuali `loggedOut` → pairing/QR ulang) |
| 🔐 Dua metode koneksi | **Pairing Code** atau **QR Code** — dipilih di terminal sebelum scan/kode ditampilkan |

---

## 📁 Struktur Proyek

```
.
├── package.json
├── .env.example
├── src/
│   ├── index.js                 # Entry point: Baileys + routing intent + cronjob
│   ├── config/
│   │   ├── database.js          # Helper baca/tulis JSON lokal (atomic + queue)
│   │   ├── appConfig.js         # Konfigurasi runtime (footer, tier_enabled)
│   │   └── envCheck.js          # Validasi .env (fail-fast secret & password)
│   ├── services/
│   │   ├── gemini.js            # Integrasi @google/genai (teks, audio & gambar/struk)
│   │   ├── receipt.js           # Logika pembaca struk (wallet, deskripsi, transaksi)
│   │   ├── owner.js             # Laporan otomatis ke owner + anti spam
│   │   ├── quota.js             # Kuota tier free/basic/premium/sultan (atomik)
│   │   ├── sultanBotManager.js  # Kelola instance bot tambahan (tier Sultan)
│   │   ├── excel.js             # JSON → .xlsx (ExcelJS) + grafik PNG (sharp)
│   │   └── backup.js            # Buat & kirim file backup via WhatsApp
│   ├── utils/
│   │   ├── phone.js             # Normalisasi nomor Indonesia + cek owner
│   │   └── datetime.js          # Zona waktu & format tanggal/jam
│   └── web/                     # Dashboard admin (Express + EJS)
│       ├── server.js            # Bootstrap Express: helmet, CORS, CSRF, router
│       ├── auth.js              # Login JWT, bcrypt, requireRole
│       ├── csrf.js              # Proteksi CSRF (double-submit cookie)
│       ├── validate.js          # Skema validasi request (zod)
│       ├── audit.js             # Pencatatan audit log
│       ├── settings.js          # Pengaturan dashboard
│       ├── state.js             # Status bot untuk halaman System
│       └── routes/              # 14 router REST (/api/*)
├── views/                       # 19 template EJS (landing + dashboard)
├── public/assets/               # Aset statis (template, JS helper safe-dom & api-client)
├── data/                        # (otomatis) users/transactions/wallets/budgets .json
├── baileys_auth/                # (otomatis) sesi WhatsApp
├── backups/                     # (otomatis) file .xlsx sementara
└── tests/
    ├── unit/                    # Uji otomatis (node:test) — dijalankan `npm test`
    └── test-*.js                # Skrip uji manual fitur (butuh API key aktif)
```

---

## 🚀 Instalasi

```bash
npm install
cp .env.example .env
# edit .env:
#   - GEMINI_API_KEYS  (boleh 3+ key, pisah koma)
#   - BOT_NUMBER       (bila memakai metode pairing)
#   - JWT_SECRET       (WAJIB, min. 32 karakter — lihat "Validasi konfigurasi")
#   - WEB_OWNER_PASSWORD / WEB_ADMIN_PASSWORD (WAJIB diganti dari default)
npm start
```

Jalankan uji otomatis (tidak butuh API key):

```bash
npm test
```

Saat `npm start`, bot menanyakan metode koneksi lebih dulu:

```
  PILIH METODE KONEKSI WHATSAPP
   1) PAIRING CODE  — tautkan dengan nomor telepon  ← saran
   2) QR CODE       — tautkan dengan memindai
  Pilih metode [1 = Pairing, 2 = QR] (ENTER = pairing):
```

### Pilih Metode Koneksi (Pairing Code / QR Code)

Saat pertama dijalankan dengan sesi kosong, bot **menanyakan metode koneksi lebih dulu** — sebelum kode atau QR ditampilkan:

```
==================================================
  PILIH METODE KONEKSI WHATSAPP
==================================================
   1) PAIRING CODE  — tautkan dengan nomor telepon  ← saran
      Bot menampilkan 8 karakter. Masukkan di WhatsApp >
      Perangkat Tertaut > "Tautkan dengan nomor telepon saja".
      (kode hanya berlaku ±60 detik, dibuat ulang otomatis)

   2) QR CODE       — tautkan dengan memindai
      Bot menampilkan QR di terminal. Pindai lewat WhatsApp >
      Perangkat Tertaut > "Tautkan Perangkat".
      (paling andal; QR dibuat ulang otomatis ±20 detik)
==================================================
  Pilih metode [1 = Pairing, 2 = QR] (ENTER = pairing):
```

Ketik `1` atau `2`, lalu tekan ENTER. Tekan ENTER saja untuk memakai metode default (`CONNECTION_METHOD` di `.env`, default `pairing`).

#### Metode 1 — Pairing Code

1. Buka **WhatsApp** di HP nomor `BOT_NUMBER`
2. **Pengaturan → Perangkat Tertaut → Tautkan Perangkat**
3. Pilih **"Tautkan dengan nomor telepon saja"**
4. Masukkan 8 karakter kode yang tampil (berlaku ±60 detik)

```
==================================================
  PAIRING CODE :  1A2B-3C4D
==================================================
  Nomor bot : 6281234567890
  ⏰ Kode berlaku sampai ±11:35:49 (60 detik)
  Langkah aktivasi:
   1. Buka WhatsApp di HP nomor 6281234567890
   2. Pengaturan > Perangkat Tertaut > Tautkan Perangkat
   3. Pilih "Tautkan dengan nomor telepon saja"
   4. Masukkan kode di atas SEKARANG
   ⚠️  Kode kedaluwarsa = "Gagal menautkan perangkat".
   Bot otomatis membuat kode baru saat kode lama habis.
==================================================
```

Bot menghitung mundur sisa waktu (`⏳ 50 detik tersisa...`) dan **membuat kode baru otomatis** sebelum kode habis. Bisa juga tekan **ENTER** untuk minta kode baru segera — tanpa restart bot.

#### Metode 2 — QR Code

1. Buka **WhatsApp** di HP nomor bot
2. **Pengaturan → Perangkat Tertaut → Tautkan Perangkat**
3. **Pindai QR** yang tampil di terminal

```
==================================================
  QR CODE KONEKSI WHATSAPP
==================================================
  Langkah aktivasi:
   1. Buka WhatsApp di HP nomor bot
   2. Pengaturan > Perangkat Tertaut > Tautkan Perangkat
   3. Pindai QR di bawah ini
  ⏰ QR dibuat ulang otomatis (±20 detik).
--------------------------------------------------
   ▄▄▄▄▄▄▄ █▀▀ ████▀███▄██ ... (QR)
--------------------------------------------------
==================================================
```

QR dibuat ulang otomatis setiap ±20 detik. Bila gagal, tunggu QR berikutnya lalu pindai lagi. Metode ini **paling andal** dan tidak terikat batas 60 detik.

Sesi tersimpan di `baileys_auth/`, jadi pemilihan metode hanya muncul sekali. Setelah sesi ada, bot langsung connect — menu metode, pertanyaan nomor, dan readline terminal otomatis dilewati.

#### Tabel perilaku

| Kondisi | Perilaku |
|---|---|
| Sudah ada sesi di `baileys_auth/` | Langsung connect — menu metode & nomor dilewati |
| Belum ada sesi + terminal TTY | **Menu metode** muncul (1/2), lalu (bila pairing) nomor ditanyakan bila `BOT_NUMBER` kosong |
| Belum ada sesi + non-TTY (systemd/docker) | Pakai `CONNECTION_METHOD` dari `.env` (tidak menggantung) |
| Metode `pairing` tanpa nomor valid | Berhenti dengan pesan jelas → isi `BOT_NUMBER` atau pilih QR |
| Metode `qr` | Nomor tidak wajib — identitas didapat dari hasil pindai |
| `BOT_NUMBER` diisi di `.env` | Langsung dipakai, tanpa pertanyaan nomor |
| `BOT_NUMBER` kosong + TTY (metode pairing) | Ditanyakan (3x kesempatan). `081234567890` → `6281234567890` |

#### Alur koneksi (ringkas)

```
npm start
   │
   ├─ Sesi ada di baileys_auth/?  ── YA ──►  langsung connect
   │
   └─ BELUM ada sesi
         │
         ▼
      PILIH METODE (terminal)   [ENTER = CONNECTION_METHOD di .env]
         │
         ├── 1) PAIRING CODE ──► (nomor dari .env / ditanya) ──► tampilkan kode
         │        ├─ user masukkan kode di HP ──► ✅ Terhubung
         │        └─ kedaluwarsa ──► auto kode baru / tekan ENTER
         │
         └── 2) QR CODE ──────► tampilkan QR (diperbarui ±20 detik)
                  └─ user pindai ──► ✅ Terhubung
```

> **Catatan:** sesi hanya bisa dibuat untuk nomor yang **belum tertaut** dan hanya untuk **perangkat baru**. Jika muncul `Sesi LOGOUT`, hapus folder `baileys_auth/` lalu jalankan ulang.

#### Empat hal penting agar pairing tidak gagal

> Berlaku untuk **metode Pairing Code**. Metode QR tidak terpengaruh masalah kedaluwarsa kode.

1. **Menunggu handshake selesai, bukan hanya WebSocket terbuka.**

   Hasil pengukuran nyata di server ini:

   | Kejadian | Waktu |
   |---|---|
   | `sock.ws.isOpen` menjadi true | +485 ms |
   | Handshake registrasi selesai (`attempting registration...`) | +800 ms |
   | `requestPairingCode()` pada +485 ms | ❌ socket **MATI** (close 428) |
   | `requestPairingCode()` pada +985 ms | ✅ socket **HIDUP** |

   `ws.isOpen` saja **terlalu awal** (~315 ms). Bila pairing diminta saat handshake masih berjalan, WhatsApp menutup koneksi, kode jadi tidak valid, dan saat Anda memasukkannya WhatsApp menampilkan *"pastikan nomor yang anda masukan benar"*. Bot kini menunggu handshake selesai (jeda aman 1200 ms) sebelum meminta kode.

2. **Menangani `isNewLogin` (penyelesaian pairing).**

   Saat Anda **berhasil** memasukkan kode, WhatsApp mengirim `pair-success`, lalu Baileys memancarkan:

   ```js
   // Socket/socket.js — handler "CB:iq,,pair-success"
   logger.info('pairing configured successfully, expect to restart the connection...')
   ev.emit('connection.update', { isNewLogin: true, qr: undefined })
   ```

   Bot **wajib** menyambung ulang saat `isNewLogin: true`. Bila diabaikan, sesi tidak pernah selesai terdaftar. Ini penyebab utama kegagalan sebelumnya.

3. **Sesi sampah dibersihkan otomatis saat start.** Percobaan pairing yang gagal meninggalkan `creds.json` dengan `registered: false` **dan** `pairingCode` sisa. Bot mendeteksi dan menghapusnya **saat startup saja** — tidak saat reconnect, karena itu akan membuang kode yang masih berlaku.

   > **Penting untuk metode QR:** jalur QR **tidak pernah** mengeset `registered` di Baileys (hanya jalur pairing code yang melakukannya). Karena itu sesi QR yang sah dikenali dari `me.id` + `account`, bukan dari `registered`. Tanpa penyesuaian ini, sesi hasil pindai akan terhapus setiap kali bot dijalankan ulang.

4. **Kode pairing hanya berlaku 60 detik — jangan pernah dipakai ulang.**

   Ini penyebab paling sering *"Gagal menautkan perangkat — dapatkan kode baru"*. Kode lama **tidak bisa** dipakai ulang setelah kedaluwarsa atau setelah socket berganti. Bot sekarang:
   - menampilkan jam kedaluwarsa (`⏰ Kode berlaku sampai ±11:02:04`),
   - menghitung mundur sisa waktu di terminal,
   - **membuat kode baru otomatis** tepat sebelum kode habis,
   - tidak pernah mencetak ulang kode lama saat reconnect.

   Satu kode hanya untuk satu percobaan. Kalau sudah lewat 60 detik, tunggu kode baru muncul (otomatis) atau tekan **ENTER**.

   **Masih gagal?** Pakai **metode QR** (pilih `2` saat diminta) — paling andal dan bebas dari batas 60 detik.

### Requirement Node.js

Butuh **Node.js ≥ 20** (lihat `engines` di package.json).

---

## 💬 Perintah

| Perintah | Fungsi |
|---|---|
| `!help` | Menu bantuan |
| `!rekap` / `!rekap 2026-06` | Laporan bulan ini / bulan tertentu |
| `!backup` / `!backup 2026-06` | Kirim file Excel (semua data / per bulan) |
| `!saldo` | Saldo semua wallet |
| `!wallet BCA 5000000` | Set saldo awal wallet |
| `!budget Transport 500000` | Set budget bulanan kategori |
| `!ai` | Status model & API key Gemini (rotasi otomatis) |
| `!reset` | Hapus semua data (perlu konfirmasi "YA") |
| `!reload` | Muat ulang `.env` tanpa restart |

Contoh pesan bebas (diproses AI):
- _"Beli kopi 25rb pakai QRIS"_
- _"Gaji bulan ini 8 juta masuk BCA"_
- _"Bensin kemarin 50 ribu cash"_
- _"Rekap pengeluaran bulan ini"_
- _"Kirim backup excel"_

### 🧾 Baca struk belanja (foto struk)

Kirim **foto struk** (tanpa caption, atau dengan catatan seperti _"pakai BCA"_) dan bot akan:

1. Membaca struk lewat vision model → total, nama toko, tanggal, metode bayar, daftar item, pajak.
2. Mencatat **1 transaksi expense** dengan nominal **TOTAL** struk (bukan hasil perkiraan item), kategori otomatis (`Belanja`, `Makanan & Minuman`, `Kesehatan`, ...), dan wallet dari metode pembayaran (`QRIS BCA` → `QRIS`, `DEBIT BCA` → `BCA`, `TUNDAI` → `Cash`).
3. Membalas ringkasan: total, toko, jumlah item, kategori, wallet + saldo, metode bayar, dan tanggal.

Contoh balasan:

```
🧾 STRUK SUDAH DIBACA!

💵 Total       : Rp104.340
🏬 Toko        : ALFA MART
📦 Item        : 5 item — INDOMIE GORENG (2), TELUR AYAM 1KG, ...
🏷 Kategori    : Belanja
👛 Wallet      : QRIS (saldo: -Rp104.340)
💳 Bayar       : QRIS BCA
```

Catatan:
- Rincian item disimpan di transaksi (`items[]`) sebagai jejak digital, kolom Excel tetap sama.
- Kalau foto bukan struk → bot menjelaskan tanpa mencatat apa pun.
- Kalau totalstruk tidak terbaca → bot minta nominal manual (tidak pernah mencatat `0`).
- Caption user dipakai sebagai override wallet: _"foto struk ini pakai debit BCA"_.

### 🔑 Rotasi API key & model (mengatasi kuota Gemini)

Free tier Google membatasi **~20 request per model per project**. Karena tiap API key
berasal dari project yang berbeda, **tiap key punya kuota sendiri** — jadi menambah
API key = menambah kapasitas (bukan sekadar cadangan).

```env
# .env — boleh 3 atau lebih key, pisahkan dengan koma
GEMINI_API_KEYS=key1,key2,key3
GEMINI_API_KEY=key1              # key tunggal (lama) tetap didukung & digabung
GEMINI_MODEL=gemini-3.6-flash,gemini-3.8-flash,gemini-3.5-flash-lite
```

Cara kerja rotasi (`src/services/gemini.js`):

| Kondisi | Tindakan bot |
|---|---|
| `429 RESOURCE_EXHAUSTED` (kuota habis) | Pasangan **(model, key)** itu masuk cooldown → coba key berikutnya untuk model yang sama → lalu model berikutnya |
| `401` / `403` / "API key not valid" | Key ditandai **tidak valid** → tidak pernah dicoba lagi (sampai bot restart) |
| `404 model not found` | Model dilewati, coba model/key lain |
| `400 invalid argument` | Config "tangga" diturunkan (mis. tanpa `thinkingConfig`), bukan ganti key |
| `503 overload` | Coba model/key lain |

- Cooldown per pasangan `(model, key)` — kuota itu milik satu project **per model**.
- Lama cooldown diambil dari pesan Google (`retryDelay` / "retry in 19h36m"), dibatasi 30 menit; default 10 menit.
- Kapasitas efektif = **jumlah key × jumlah model**.
- Cek status rotasi kapan saja lewat perintah `!ai` (API key ditampilkan disamarkan: `AQ.A…Pcbg`).
- Setelah ganti key di `.env`, jalankan `!reload` (tidak perlu restart).

> ⚠️ API key adalah rahasia: jangan commit `.env` ke git (sudah ada di `.gitignore`) dan
> pakai key khusus proyek ini saja, bukan key utama pribadi.

### 📨 Laporan otomatis ke owner

Isi nomor owner di `.env` supaya bot bisa memberi tahu kalau AI tumbang:

```env
OWNER_NUMBER=085242283425        # boleh format lokal (0852...) atau 62852...
OWNER_ALERT_COOLDOWN_MIN=15      # jeda minimal antar laporan (anti spam)
```

Bot mengirim laporan ke nomor tersebut **saat**:

- Semua kombinasi **model × API key** kena kuota (429) → judul *"KUOTA GEMINI HABIS"*.
- Semua API key ditolak / tidak valid → judul *"GEMINI GAGAL TOTAL"*.

Contoh isi laporan:

```
🚨 LAPORAN OWNER — KUOTA GEMINI HABIS

⏰ Waktu      : 21/10/2026, 8:13:01 PM
👤 Pemicu    : 628123456789
🧠 Model     : gemini-3.6-flash, gemini-3.8-flash
🔑 API key   : 2 terdaftar (1 tidak valid)

⛔ Kena limit (429):
   • key #1 (`AQ.A…Pcbg`) — gemini-3.6-flash
   • key #2 (`AIza…7fQz`) — gemini-3.6-flash, gemini-3.8-flash

❌ API key tidak valid (401/403):
   • key #2 (`AIza…7fQz`)

🔧 Saran:
   • Tambah API key: GEMINI_API_KEYS=key1,key2,key3 (tiap key = kuota sendiri)
   • Tambah model cadangan: GEMINI_MODEL=model-a,model-b
   • Setelah ubah .env, kirim !reload
```

Catatan:
- **Anti spam**: laporan sejenis maximal 1 per `OWNER_ALERT_COOLDOWN_MIN` (default 15 menit).
- Bila yang memicu adalah **owner sendiri**, laporan tidak dikirim (owner sudah dapat balasan).
- API key pada laporan ditampilkan **disamarkan** (`AQ.A…Pcbg`), tidak pernah utuh.
- Berlaku untuk semua jalur AI: teks, voice note, dan foto struk.
- Kalau `OWNER_NUMBER` belum diisi, bot hanya mencatat peringatan di log console.

---

## 🗄️ Skema Database JSON

**`data/users.json`**
```json
{ "phone": "62812xxx", "name": "Budi", "created_at": "2026-01-01T00:00:00.000Z" }
```

**`data/transactions.json`**
```json
{
  "id": "uuid",
  "user_phone": "62812xxx",
  "type": "expense",
  "amount": 25000,
  "category": "Makanan & Minuman",
  "wallet": "QRIS",
  "description": "Beli kopi",
  "date": "2026-01-01T02:00:00.000Z",
  "created_at": "2026-01-01T02:00:00.000Z",

  // opsional — hanya untuk transaksi hasil baca struk:
  "items": [{ "name": "INDOMIE", "qty": 2, "price": 14000, "category": "Belanja" }],
  "source": "receipt"
}
```

**`data/wallets.json`**
```json
{ "user_phone": "62812xxx", "name": "BCA", "initial_balance": 5000000, "created_at": "..." }
```

**`data/budgets.json`**
```json
{ "id": "uuid", "user_phone": "62812xxx", "category": "Transport", "limit": 500000, "created_at": "..." }
```

### Kalau file JSON rusak

Saat satu file koleksi tidak bisa di-parse, aplikasi **tidak** mengosongkannya:

1. Isi asli disalin ke `<nama>.json.corrupt-<timestamp>` di folder `data/`.
2. Log menampilkan `[DB] users.json KORUP: ...` beserta lokasi salinan.
3. Bot **tetap jalan** (koleksi dibaca sebagai kosong agar tidak crash).
4. **Semua penulisan ke koleksi itu ditolak** dengan pesan jelas — data lama
   tidak mungkin tertimpa array kosong.
5. `GET /health` membalas **503** dengan `data.corruptCollections: ["users"]`.

Cara memperbaiki (pilih salah satu):

```bash
# a) Perbaiki file JSON-nya (mis. dari salinan .corrupt-*) lalu restart.
#    Penulisan otomatis normal lagi setelah file valid.
cp data/users.json.corrupt-<ts> data/users.json   # lalu edit bagian yang rusak

# b) Mulai dari kosong: pindahkan file rusaknya.
mv data/users.json data/users.json.rusak
```

Daftar koleksi yang sedang korup juga bisa dilihat dari kode:
`listCorruptCollections()` di `src/config/database.js`.

---

## ⏰ Cronjob

Diatur lewat `.env` (format cron 5 kolom, zona waktu `TIMEZONE`):

```env
CRON_BACKUP_WEEKLY=0 20 * * 0     # setiap Minggu 20:00 — kirim Excel ke tiap user
CRON_REPORT_MONTHLY=0 8 1 * *     # tgl 1 jam 08:00 — laporan + Excel bulan sebelumnya
CRON_PRUNE_BACKUPS=0 3 * * *      # setiap hari 03:00 — hapus backup lama (>7 hari)
```

Set **`KEEP_BACKUP_FILE=true`** bila ingin file `.xlsx` tetap tersimpan di `backups/` (default terhapus setelah terkirim).

---

## 🛡️ Catatan Keamanan

- `.env`, `data/`, `baileys_auth/`, dan `backups/` sudah masuk `.gitignore` — **jangan pernah commit**.
- API key Gemini hanya dipakai di server, tidak pernah dikirim ke WhatsApp.
- Bot mengabaikan grup/broadcast dan hanya merespons chat pribadi.

### Validasi konfigurasi (fail-fast)

Aplikasi **menolak start** bila konfigurasi web masih berbahaya. Yang diperiksa
saat boot (`src/config/envCheck.js`):

| Variabel | Aturan |
|---|---|
| `JWT_SECRET` | Wajib, minimal **32 karakter**, tidak boleh nilai contoh `.env.example` |
| `WEB_OWNER_PASSWORD` / `WEB_ADMIN_PASSWORD` | Wajib saat admin pertama di-seed, minimal 8 karakter, tidak boleh `owner123`/`admin123` |

Buat secret acak:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Yang sudah diterapkan di dashboard

- **Helmet + CSP**, CORS berbatas `WEB_ORIGIN`, rate limit global & login.
- **CSRF** double-submit cookie: semua request non-GET wajib menyertakan
  header `X-CSRF-Token` (otomatis oleh `api-client.js`).
- **Cookie sesi** `httpOnly` + `SameSite=Lax`, dan `Secure` otomatis aktif
  bila `NODE_ENV=production` (atau `COOKIE_SECURE=true`).
- **Validasi input** semua endpoint mutasi dengan zod (`src/web/validate.js`).
- **Otorisasi berlapis**: `requireRole('owner')` untuk aksi sensitif
  (reset auth instance, hapus admin, restore backup, kelola admin user).
- **Escape XSS**: semua data dinamis di-render lewat `esc()`
  (`public/assets/static/js/safe-dom.js`), tanpa `innerHTML` mentah dan tanpa
  `onclick` inline.
- **Audit log** untuk aksi mutasi penting (login, CRUD, kontrol bot, restore).
- **Kuota atomik**: pemakaian kuota dibungkus satu transaksi tulis sehingga
  request bersamaan tidak bisa melewati batas tier.
- **Anti data-loss**: file JSON yang korup tidak pernah ditimpa; penulisan
  diblokir dan salinan asli disimpan (lihat *Kalau file JSON rusak*).

---

## 🧯 Troubleshooting

| Masalah | Solusi |
|---|---|
| `GEMINI_API_KEY belum diisi` | Isi `.env` lalu `!reload` |
| Error `429 RESOURCE_EXHAUSTED` / "Kuota/limit Gemini habis" | Kuota free tier ~20 request **per model per project**. Bot otomatis pindah ke API key berikutnya lalu model berikutnya (lihat `GEMINI_API_KEYS` & `GEMINI_MODEL` di `.env`). Kalau semua kombinasi habis, tunggu atau aktifkan billing di [AI Studio](https://aistudio.google.com/) |
| API key dianggap tidak valid | Pesan `401`/`403`/ "API key not valid" → key tersebut diblacklist (tidak dicoba lagi). Cek dengan `!ai`, lalu ganti keynya di `.env` + `!reload` |
| "Kuota/limit Gemini habis untuk semua model & API key" | Semua kombinasi model × key sedang kena 429. Tambah API key (`GEMINI_API_KEYS`), tambah model (`GEMINI_MODEL`), atau tunggu hingga cooldown (maks 30 menit) habis |
| Error `404 model is no longer available` | Model lama (mis. `gemini-2.5-flash`) tidak tersedia untuk akun baru. Ganti dengan model yang masih ada, cek daftarnya: `curl -H "x-goog-api-key: $GEMINI_API_KEY" https://generativelanguage.googleapis.com/v1beta/models` |
| Transaksi tercatat dengan nominal 0 / kategori "Lainnya" | Model membalas JSON terpotong. `responseSchema` di `src/services/gemini.js` harus tetap **strict** (semua field `data` wajib) |
| Foto struk gagal dibaca | Bot mungkin salah membaca format struk. Coba foto lebih terang/close-up, atau catat manual. `node tests/test-struk.js` untuk cek pipeline-nya |
| "Kuota/limit Gemini habis untuk semua model" | Semua model di `GEMINI_MODEL` kena 429. Bot otomatis coba model berikutnya, tapi kalau semuanya habis ya memang harus tunggu (atau aktifkan billing) |
| Bot tiba-tiba diam / tidak merespons | Jalankan `!ai` untuk melihat status rotasi model & API key |
| Laporan owner tidak diterima | Pastikan `OWNER_NUMBER` terisi di `.env` (format `0852...` atau `62852...`) lalu `!reload`. Bot juga akan menulis `[OWNER] ...` di log console |
| Bot berhenti: "Metode PAIRING CODE memerlukan nomor bot" | Isi `BOT_NUMBER` di `.env`, atau pilih metode **QR** (`2`) saat diminta |
| Bot menggantung tanpa output di docker/systemd | `stdin` bukan TTY → isi `CONNECTION_METHOD` (`pairing`/`qr`) di `.env` |
| **WA: "Gagal menautkan perangkat / pastikan nomor benar"** | Hanya pada metode Pairing Code. 90% karena **kode sudah kedaluwarsa (>60 detik)** atau kode lama dipakai ulang. Pakai kode **paling baru** dan masukkan dalam 60 detik. Bot membuat kode baru otomatis + hitung mundur. **Solusi paling andal: pakai metode QR (`2`)** |
| Pairing code gagal / habis terus | Tunggu kode baru (otomatis tiap 60 detik), tekan **ENTER**, atau ganti ke **metode QR** |
| QR langsung kedaluwarsa saat dipindai | QR diperbarui tiap ±20 detik — pindai QR yang **paling baru**, jangan yang lama |
| `Sesi LOGOUT` (kode `401`) | Nomor sudah tertaut di perangkat lain. Hapus folder `baileys_auth/`, jalankan ulang, lakukan pairing/QR baru |
| `Connection Closed` (kode `428`) | Normal saat handshake; bot sudah menunggu WebSocket terbuka sebelum minta kode |
| Sesi QR hilang setiap restart | Sudah diperbaiki: sesi QR dikenali dari `me.id` + `account`, bukan `registered` |
| File JSON korup | Bot otomatis mengarsipkan ke `*.corrupt-<timestamp>` dan mulai dari kosong |
| Excel kosong | Pastikan sudah ada transaksi (`!rekap` untuk cek) |
