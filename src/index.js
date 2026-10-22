/**
 * ==========================================================================
 *  src/index.js
 *  ENTRY POINT — WhatsApp Bot Pencatat Keuangan
 *
 *  Alur lengkap:
 *    .env  ->  init database  ->  koneksi Baileys (PAIRING CODE)  ->  reconnect
 *    ->  listener messages.upsert  ->  deteksi perintah / AI Gemini
 *    ->  simpan transaksi / kirim rekap / kirim backup Excel  ->  cronjob
 *
 *  Cara pakai:  npm install  &&  cp .env.example .env (isi nilainya)  &&  npm start
 * ==========================================================================
 */

import 'dotenv/config';

import path from 'node:path';
import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import readline from 'node:readline/promises';

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidNormalizedUser,
  jidDecode,
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import cron from 'node-cron';
import qrcode from 'qrcode-terminal';

import { parseMessage, parseReceiptImage, getRotationStatus, generateText } from './services/gemini.js';
import { buildItemSummary, buildReceiptTransaction } from './services/receipt.js';
import { reportAiFailureToOwner } from './services/owner.js';
import { normalizePhoneNumber } from './utils/phone.js';
import { normalizeTimezone, timezoneLabel } from './utils/datetime.js';
import { sendBackup, pruneOldBackups } from './services/backup.js';
import { checkAndConsumeQuota, canUseBackup } from './services/quota.js';
import { startWebServer } from './web/server.js';
import { setBotState } from './web/state.js';
import {
  COLLECTIONS,
  addTransaction,
  currentMonth,
  formatMonthLabel,
  formatRupiah,
  getBudgets,
  getCategoryExpenses,
  getStats,
  getUser,
  getUserTimezone,
  getWalletBalance,
  getWalletBalances,
  listTransactions,
  previousMonth,
  readCollection,
  setBudget,
  setUserTimezone,
  setWalletBalance,
  upsertUser,
  withCollection,
  writeCollection,
} from './config/database.js';

/* ==========================================================================
 *  KONFIGURASI
 * ========================================================================== */
const CONFIG = {
  botNumber: (process.env.BOT_NUMBER || '').replace(/\D/g, ''),
  sessionDir: process.env.SESSION_DIR || './baileys_auth',
  dataDir: process.env.DATA_DIR || './data',
  timezone: process.env.TIMEZONE || 'Asia/Jakarta',
  /**
   * Prefix perintah. Mendukung BANYAK prefix sekaligus sehingga pengguna
   * tidak harus menghafal satu simbol saja.
   *
   * Contoh isi .env:
   *   COMMAND_PREFIX=!          -> hanya "!"
   *   COMMAND_PREFIX=!,.,#,     -> "!" "." "#" "," (dipisah koma)
   *   COMMAND_PREFIX=           -> kembali ke default "!,.,:,*" 
   *
   * Karakter yang aman dipakai: ! . , : * # / -
   * Spasi TIDAK dipakai sebagai prefix (akan bentrok dengan pesan biasa).
   */
  prefix: process.env.COMMAND_PREFIX || '!,.,:,*',
  /** Daftar prefix hasil parsing (diisi di bawah setelah CONFIG dibuat). */
  prefixes: [],
  /** 'pairing' | 'qr' — default bila pengguna tidak memilih di terminal. */
  connectionMethod: process.env.CONNECTION_METHOD || '',
  /**
   * Versi WhatsApp Web yang diiklankan ke server.
   *
   * Sengaja DI-PIN (mengikuti neoxr-bot) alih-alih `fetchLatestBaileysVersion`.
   * Versi yang di-fetch otomatis dari web bisa tertinggal / tidak dikenali
   * server sehingga koneksi diputus berulang (mis. 440/401). Pemilik bot boleh
   * menimpanya lewat `WA_VERSION` di .env bila WhatsApp menaikkan versinya.
   */
  waVersion: (process.env.WA_VERSION || '2,3000,1045101284')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n)),
  /**
   * Identitas browser yang dilaporkan. Format: "OS,Browser,Versi".
   * neoxr-bot memakai macOS + Chrome dengan versi Chrome nyata; kombinasi
   * "Desktop" sebagai tipe browser terbukti kurang cocok untuk pairing.
   */
  browser: (process.env.WA_BROWSER || 'Mac OS,Chrome,139.0.7258.164')
    .split(',')
    .map((s) => s.trim()),
  // Kosong / nilai tak dikenal -> 'silent' agar console tetap bersih
  logLevel: ['silent', 'error', 'warn', 'info', 'debug'].includes(
    process.env.BAILEYS_LOG_LEVEL,
  )
    ? process.env.BAILEYS_LOG_LEVEL
    : 'silent',
};

const require = createRequire(import.meta.url);

/** Logger Baileys: level mengikuti BAILEYS_LOG_LEVEL (default 'silent'). */
const logger = pino({ level: CONFIG.logLevel });

/** Socket Baileys aktif (di-set ulang setiap kali reconnect). */
let sock = null;

/**
 * Status permintaan pairing code.
 *   false     -> belum diminta
 *   'pending' -> kode sudah tampil, menunggu user memasukkan di HP
 *   'done'    -> sesi sudah terdaftar (creds.registered)
 */
let pairingState = false;

/**
 * Kunci agar hanya SATU permintaan pairing berjalan.
 * Dua permintaan bersamaan akan saling menimpa `creds.pairingCode`, sehingga
 * kode yang sedang dimasukkan pengguna di HP menjadi tidak valid.
 */
let pairingRequestInFlight = false;

/** Kunci agar tidak ada reconnect beruntun yang saling menimpa. */
let reconnecting = false;

/**
 * Hitungan koneksi terputus beruntun dengan kode 440 (connectionReplaced).
 * Bila terlalu sering, bot berhenti agar tidak berujung 401 (logout).
 */
let consecutive440 = 0;

/**
 * Waktu (ms) koneksi terakhir kali benar-benar `open`.
 *
 * 440 bisa datang berulang dengan pola: `open` -> 440 -> reconnect -> `open`
 * -> 440 -> ... Karena itu penghitung tidak boleh di-reset di setiap `open`
 * (kalau di-reset, penghitung tidak pernah mencapai batas dan bot loop
 * selamanya). Reset hanya dilakukan bila koneksi sebelumnya bertahan cukup
 * lama — artinya memang sehat, bukan sekadar sempat menyala.
 */
let lastOpenAt = 0;

/** Koneksi dianggap sehat bila bertahan minimal selama ini (ms). */
const HEALTHY_UPTIME_MS = 30_000;

/**
 * Jeda reconnect (ms) yang meningkat setiap kali 440 berulang, agar WhatsApp
 * tidak dibombardir. Pola `open`-`440` beruntun biasanya karena ada sesi lain
 * yang login memakai kredensial sama.
 */
function reconnectDelayFor440() {
  return 3000 + Math.min(consecutive440, 5) * 2000;
}

/** Guard agar listener ENTER hanya dipasang sekali. */
let retryListenerAttached = false;

/** Timer pembaruan kode pairing otomatis. */
let pairingCodeTimer = null;

/** Timer hitung mundur kode pairing. */
let pairingCountdownTimer = null;

/**
 * Umur kode pairing WhatsApp. WhatsApp memberi ±60 detik; kita pakai 58 detik
 * agar kode baru dibuat sedikit sebelum batas sebenarnya.
 */
const PAIRING_CODE_TTL_MS = 58_000;

/**
 * METODE KONEKSI YANG DIPILIH PENGGUNA DI TERMINAL.
 *   'pairing' -> tautkan dengan nomor telepon (pairing code)
 *   'qr'      -> tautkan dengan memindai QR
 *
 * Dipilih SEKALI sebelum koneksi dibuat, lewat resolveConnectionMethod().
 * Nilai awal diambil dari CONNECTION_METHOD di .env bila ada, supaya bot
 * tetap bisa dijalankan non-interaktif (docker/systemd). Pengguna masih bisa
 * menggantinya interaktif di terminal.
 */
let connectionMethod = null;

/** Objek QR terakhir yang diterima (untuk render & pesan kedaluwarsa). */
let lastQr = null;

/** Antarmuka terminal (dipakai untuk meminta nomor & mengulang pairing code). */
let rl = null;
/** true bila stdin bukan TTY (mis. dijalankan via systemd/docker) -> non-interaktif. */
let interactive = process.stdin.isTTY === true;

/** Nomor bot aktif (dari .env atau hasil input terminal). */
let botNumber = '';

/** State sementara untuk command interaktif (yang butuh jawaban lanjutan). */
const pendingStates = new Map(); // jid -> { state, data, expiresAt }
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 menit

/* ==========================================================================
 *  HELPER UTIL
 * ========================================================================== */

/** Delay sederhana untuk menghindari rate-limit WhatsApp. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------------------------------------------------------
 *  MULTI PREFIX
 *
 *  `COMMAND_PREFIX` boleh berisi beberapa karakter sekaligus, dipisah koma.
 *  Contoh: "!,.,:,*"  ->  perintah bisa ditulis `!rekap`, `.rekap`,
 *  `:rekap`, maupun `*rekap`.
 *
 *  Karakter yang AMAN dipakai: ! . , : * # / -
 *  (spasi & huruf/angka tidak dipakai agar tidak bentrok dengan chat biasa)
 * ------------------------------------------------------------------------ */

/** Daftar karakter prefix yang diizinkan. */
const ALLOWED_PREFIX_CHARS = ['!', '.', ',', ':', '*', '#', '/', '-'];

/** Default bila .env kosong: tuntutan "multi prefix" pengguna. */
const DEFAULT_PREFIXES = '!,.,:,*';

/**
 * Ubah isi `COMMAND_PREFIX` menjadi array karakter prefix yang unik & valid.
 * Karakter tak dikenal otomatis dibuang sehingga bot tidak pernah "buta"
 * perintah karena salah isi .env.
 *
 * @param {string} raw nilai mentah dari CONFIG.prefix
 * @returns {string[]} daftar prefix, mis. ['!', '.', ',', ':', '*']
 */
function parsePrefixes(raw) {
  const source = String(raw ?? '').trim() || DEFAULT_PREFIXES;
  const out = [];
  for (const ch of source) {
    // Pemisah koma dilewati; karakter lain dicek terhadap daftar putih.
    if (ch === ',' || /\s/.test(ch)) continue;
    if (ALLOWED_PREFIX_CHARS.includes(ch) && !out.includes(ch)) out.push(ch);
  }
  // Jaring pengaman: bila semua isian tidak valid, pakai default.
  return out.length ? out : ['!'];
}

/**
 * Periksa apakah sebuah teks diawali salah satu prefix.
 *
 * @param {string} text isi pesan
 * @returns {string|null} karakter prefix yang cocok, atau null
 */
function detectPrefix(text) {
  const first = String(text ?? '')[0];
  return first && CONFIG.prefixes.includes(first) ? first : null;
}

/**
 * Inisialisasi daftar prefix dari `CONFIG.prefix`.
 * Dilakukan SETELAH fungsi parsePrefixes didefinisikan.
 */
CONFIG.prefixes = parsePrefixes(CONFIG.prefix);

/** Nomor telepon murni dari JID: '62812...:12@s.whatsapp.net' -> '62812...' */
function phoneFromJid(jid) {
  return jidNormalizedUser(jid).split('@')[0].split(':')[0];
}

/**
 * Ambil JID pengirim sebenarnya dari sebuah pesan.
 *
 * PENTING (era LID): WhatsApp sekarang sering mengalamatkan pengirim dengan
 * JID berbentuk `1234567890@lid` (Linked ID) alih-alih `62812...@s.whatsapp.net`.
 * Untuk pesan dari orang lain, JID asli (nomor telepon) tersedia di
 * `key.senderPn`; untuk pesan dari diri sendiri, nomor bot dipakai.
 */
function resolveSenderJid(msg, remoteJid) {
  return (
    msg.key?.senderPn ||          // nomor telepon asli (PN) bila disertakan
    msg.key?.participantPn ||
    msg.key?.senderLid ||         // fallback: LID
    msg.key?.participantLid ||
    remoteJid
  );
}

/**
 * Hanya proses chat PRIBADI (1-on-1).
 * Grup (@g.us), broadcast/status (@broadcast), newsletter/channel
 * (@newsletter) otomatis ditolak.
 *
 * Mendukung DUA bentuk JID pengguna: `@s.whatsapp.net` (nomor telepon)
 * dan `@lid` (Linked ID) — keduanya sama-sama chat pribadi yang sah.
 */
function isPrivateChat(msg, remoteJid) {
  if (!remoteJid) return false;
  const decoded = jidDecode(remoteJid);
  if (!decoded?.user) return false;
  return decoded.server === 's.whatsapp.net' || decoded.server === 'lid';
}

/** Ambil teks dari berbagai bentuk pesan. */
function extractText(message = {}) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.buttonsResponseMessage?.selectedButtonId ||
    message.listResponseMessage?.singleSelectReply?.selectedRowId ||
    message.templateButtonReplyMessage?.selectedId ||
    ''
  ).trim();
}

/**
 * Baca ulang `.env` + muat ulang modul yang bergantung padanya.
 * Dipakai command `!reload` (tanpa restart bot).
 */
async function reloadEnv() {
  try {
    const envPath = path.resolve('.env');
    const content = await fs.readFile(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i === -1) continue;
      const key = s.slice(0, i).trim();
      const value = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      process.env[key] = value;
    }
    CONFIG.timezone = process.env.TIMEZONE || CONFIG.timezone;
    CONFIG.prefix = process.env.COMMAND_PREFIX || CONFIG.prefix;
    // Bersihkan cache modul internal agar env baru langsung terbaca
    for (const p of ['./services/gemini.js', './config/database.js', './services/backup.js']) {
      delete require.cache[require.resolve(p)];
    }
    return true;
  } catch (err) {
    console.error('[ENV] Reload gagal:', err.message);
    return false;
  }
}

/* ==========================================================================
 *  BENTUK PESAN (formatter)
 * ========================================================================== */

const TYPE_ICON = { income: '💚', expense: '🧡' };

function formatTransactionReply(tx, walletBalance, timezone = CONFIG.timezone) {
  const label = tx.type === 'income' ? 'PEMASUKAN' : 'PENGELUARAN';
  return [
    `${TYPE_ICON[tx.type]} *${label} TERCATAT!*`,
    '',
    `💵 Jumlah     : *${formatRupiah(tx.amount)}*`,
    `🏷 Kategori   : ${tx.category}`,
    `👛 Wallet     : ${tx.wallet}${walletBalance !== null ? ` (saldo: ${formatRupiah(walletBalance)})` : ''}`,
    `📝 Deskripsi  : ${tx.description || '-'}`,
    `🕒 Waktu      : ${new Date(tx.date).toLocaleString('id-ID', { timeZone: timezone })}`,
    '',
    `_Ketik ${CONFIG.prefix}rekap untuk melihat laporan bulan ini_`,
  ].join('\n');
}

function formatWalletList(balances) {
  if (!balances.length) return 'Belum ada wallet.';
  return balances
    .map((w) => `👛 *${w.name}* : ${formatRupiah(w.balance)}`)
    .join('\n');
}

/* ==========================================================================
 *  PEMBACA STRUK BELANJA (foto struk)
 * ========================================================================== */

/** Balasan konfirmasi setelah struk berhasil dicatat. */
function formatReceiptReply(receipt, tx, walletBalance, timezone = CONFIG.timezone) {
  const lines = [
    '🧾 *STRUK SUDAH DIBACA!*',
    '',
    `💵 Total       : *${formatRupiah(receipt.total)}*`,
  ];

  if (receipt.store) lines.push(`🏬 Toko        : ${receipt.store}`);
  if (receipt.items.length) {
    lines.push(`📦 Item        : ${receipt.items.length} item — ${buildItemSummary(receipt.items)}`);
  }
  if (receipt.subtotal) {
    lines.push(
      `🧾 Subtotal    : ${formatRupiah(receipt.subtotal)}` +
        (receipt.tax ? `  + pajak ${formatRupiah(receipt.tax)}` : ''),
    );
  }
  lines.push(`🏷 Kategori    : ${tx.category}`);
  lines.push(
    `👛 Wallet      : ${tx.wallet}` +
      (walletBalance !== null ? ` (saldo: ${formatRupiah(walletBalance)})` : ''),
  );
  if (receipt.payment_method) lines.push(`💳 Bayar       : ${receipt.payment_method}`);
  lines.push(`🕒 Waktu       : ${new Date(tx.date).toLocaleString('id-ID', { timeZone: timezone })}`);
  if (receipt.notes) lines.push(`📝 Catatan     : ${receipt.notes}`);
  lines.push('', `_Ketik ${CONFIG.prefix}rekap untuk melihat laporan bulan ini_`);

  return lines.join('\n');
}

/* ==========================================================================
 *  LAPORAN KE OWNER (pemilik bot)
 *  Logika ada di src/services/owner.js (bisa diuji terpisah).
 * ========================================================================== */

function buildReport({ month, stats, balances, categories, budgets, transactions, timezone = CONFIG.timezone }) {
  const topCats = Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, total], i) => `   ${i + 1}. ${name} — ${formatRupiah(total)}`)
    .join('\n');

  const budgetLines = budgets
    .map((b) => {
      const used = categories[b.category] || 0;
      const pct = b.limit > 0 ? Math.round((used / b.limit) * 100) : 0;
      const bar = '█'.repeat(Math.min(10, Math.round(pct / 10))) + '░'.repeat(Math.max(0, 10 - Math.round(pct / 10)));
      return `   ${pct >= 100 ? '🔴' : pct >= 75 ? '🟡' : '🟢'} ${b.category}: ${bar} ${pct}% (${formatRupiah(used)}/${formatRupiah(b.limit)})`;
    })
    .join('\n');

  const lines = [
    `📊 *REKAP KEUANGAN — ${formatMonthLabel(month).toUpperCase()}*`,
    `🕒 Zona waktu  : ${timezoneLabel(timezone)}`,
    '',
    `💚 Pemasukan   : *${formatRupiah(stats.income)}*`,
    `🧡 Pengeluaran : *${formatRupiah(stats.expense)}*`,
    `📈 Selisih     : *${formatRupiah(stats.net)}*`,
    `🧾 Transaksi   : ${stats.count} catatan`,
    '',
    '👛 *SALDO PER WALLET*',
    formatWalletList(balances),
  ];

  if (topCats) {
    lines.push('', '🏷 *TOP KATEGORI PENGELUARAN*', topCats);
  }
  if (budgetLines) {
    lines.push('', '🎯 *BUDGET BULANAN*', budgetLines);
  }
  if (transactions?.length) {
    const recent = [...transactions].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
    lines.push(
      '',
      '🧾 *5 TRANSAKSI TERAKHIR*',
      ...recent.map(
        (t) =>
          `   ${TYPE_ICON[t.type]} ${new Date(t.date).toLocaleString('id-ID', { timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} • ${t.category} • ${formatRupiah(t.amount)}`,
      ),
    );
  }

  lines.push('', `_Ketik ${CONFIG.prefix}backup untuk mengunduh file Excel_`);
  return lines.join('\n');
}

const HELP_TEXT = (prefix) =>
  [
    '🤖 *BOT PENCATAT KEUANGAN*',
    '',
    '📝 *Catat transaksi* — tinggal ngobrol natural:',
    '   • _Beli kopi 25rb pakai QRIS_',
    '   • _Gaji masuk 8jt ke BCA_',
    '   • _Bensin 50 ribu cash_',
    '   🎤 Bisa juga *voice note*!',
    '   🧾 Bisa juga kirim *foto struk* — totalnya otomatis dicatat!',
    '',
    '📋 *Perintah*',
    `   • ${prefix}rekap — laporan bulan ini`,
    `   • ${prefix}rekap 2026-06 — laporan bulan tertentu`,
    `   • ${prefix}analisis — analisis keuangan bulan ini (AI)`,
    `   • ${prefix}analisis 2026-06 — analisis bulan tertentu`,
    `   • ${prefix}backup — pilih format backup (Excel/PDF)`,
    `   • ${prefix}backup excel/pdf/json — kirim backup Excel/PDF/JSON`,
    `   • ${prefix}backup 2026-06 — backup bulan tertentu`,
    `   • ${prefix}saldo — saldo semua wallet`,
    `   • ${prefix}wallet <nama> <saldo_awal> — set saldo awal`,
    `   • ${prefix}budget <kategori> <limit> — set budget bulanan`,
    `   • ${prefix}setzonawaktu — set zona waktu (WIB/WITA/WIT)`,
    `   • ${prefix}reset — hapus SEMUA data (perlu konfirmasi)`,
    `   • ${prefix}help — tampilkan menu ini`,
    '',
    '💡 Contoh: _"minggu ini habis berapa buat makan?"_',
  ].join('\n');

/* ==========================================================================
 *  PERINTAH / COMMAND HANDLER
 * ========================================================================== */

/**
 * Menangani perintah teks yang diawali prefix (mis. `!rekap`).
 * @returns {Promise<boolean>} true bila pesan adalah perintah yang dikenali
 */
async function handleCommand(prefix, rawText, ctx) {
  const { jid, phone, name, msg } = ctx;
  const timezone = ctx.timezone || CONFIG.timezone;
  const owner = normalizePhoneNumber(process.env.OWNER_NUMBER || '') || (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
  const [rawCmd, ...args] = rawText.slice(prefix.length).trim().split(/\s+/);
  const cmd = (rawCmd || '').toLowerCase();
  const reply = (text) => sock.sendMessage(jid, { text: `${text}\n\nby: ampang dev` }, { quoted: msg });

  switch (cmd) {
    /* ---------------------------------------------------------------- help */
    case 'help':
    case 'menu':
    case 'start':
      await reply(HELP_TEXT(prefix));
      return true;

    /* ------------------------------------------------------------------ ai */
    case 'ai':
    case 'gemini':
    case 'status': {
      if (owner && phone !== owner) {
        await reply('❌ Fitur ini khusus owner/admin bot.');
        return true;
      }
      const st = getRotationStatus();
      const keyLines = st.keys.length
        ? st.keys
            .map((k) => {
              const badges = [];
              if (k.invalid) badges.push('❌ tidak valid');
              if (k.exhaustedModels.length) {
                badges.push(`⏳ limit di ${k.exhaustedModels.join(', ')}`);
              }
              return `   ${k.index}. \`${k.masked}\`${badges.length ? ` — ${badges.join('; ')}` : ' — ✅ siap'}`;
            })
            .join('\n')
        : '   (belum ada API key)';

      await reply(
        [
          '🤖 *STATUS AI (Gemini)*',
          '',
          `🧠 Model : ${st.models.join(', ')}`,
          '',
          `🔑 API key (${st.keys.length} terdaftar):`,
          keyLines,
          '',
          '_Bot otomatis pindah model/API key saat kena kuota (429) atau key tidak valid._',
          `_Perintah: ${prefix}reload untuk memuat ulang .env_`,
        ].join('\n'),
      );
      return true;
    }

    /* --------------------------------------------------------------- rekap */
    case 'rekap':
    case 'laporan':
    case 'report': {
      const month = /^\d{4}-\d{2}$/.test(args[0] || '') ? args[0] : currentMonth();
      const [stats, balances, categories, budgets, transactions] = await Promise.all([
        getStats(phone, month),
        getWalletBalances(phone),
        getCategoryExpenses(phone, month),
        getBudgets(phone),
        listTransactions(phone, { month }),
      ]);
      await reply(buildReport({ month, stats, balances, categories, budgets, transactions, timezone }));
      return true;
    }

    /* ----------------------------------------------------------- analisis */
    case 'analisis':
    case 'analisa':
    case 'analysis': {
      const month = /^\d{4}-\d{2}$/.test(args[0] || '') ? args[0] : currentMonth();
      const [stats, categories, transactions] = await Promise.all([
        getStats(phone, month),
        getCategoryExpenses(phone, month),
        listTransactions(phone, { month }),
      ]);

      if (!transactions || !transactions.length) {
        await reply(`📊 Belum ada transaksi di periode *${formatMonthLabel(month)}*. Catat dulu beberapa transaksi, lalu coba lagi.`);
        return true;
      }

      // Susun data transaksi menjadi teks untuk dianalisis AI.
      const txLines = transactions.map((t, i) => {
        const amt = t.type === 'income' ? `+${formatRupiah(t.amount)}` : `-${formatRupiah(t.amount)}`;
        return `${i + 1}. ${t.date} | ${t.type === 'income' ? 'Pemasukan' : 'Pengeluaran'} | ${t.category || '-'} | ${amt} | ${t.note || '-'}`;
      }).join('\n');

      const catLines = Object.entries(categories || {}).map(([name, total]) => `- ${name}: ${formatRupiah(total)}`).join('\n');

      const dataBlock = [
        `Periode: ${formatMonthLabel(month)} (${month})`,
        `Total Pemasukan: ${formatRupiah(stats.income || 0)}`,
        `Total Pengeluaran: ${formatRupiah(stats.expense || 0)}`,
        `Sisa Cashflow: ${formatRupiah((stats.income || 0) - (stats.expense || 0))}`,
        '',
        'Ringkasan per kategori:',
        catLines || '- (tidak ada)',
        '',
        'Daftar transaksi (terurut waktu input):',
        txLines,
      ].join('\n');

      await reply('🧠 Sedang menganalisis keuanganmu, mohon tunggu sebentar...');
      try {
        const result = await generateText(
          [{ text: `Berikut data transaksi bulanan saya:\n\n${dataBlock}` }],
          ANALYSIS_INSTRUCTION,
          { timezone, maxOutputTokens: 4096, temperature: 0.4 },
        );
        await reply(result);
      } catch (err) {
        await reply(`❌ Gagal menganalisis: ${err?.message || err}`);
      }
      return true;
    }

    /* -------------------------------------------------------------- backup */
    case 'backup':
    case 'excel':
    case 'export':
    case 'pdf': {
      const monthToken = args.find((a) => /^\d{4}-\d{2}$/.test(a));
      const month = monthToken || null;
      const formatToken = args.map((a) => a.toLowerCase()).find((a) => ['pdf', 'json', 'excel', 'xlsx', 'xls'].includes(a));
      const format = formatToken === 'pdf' ? 'pdf' : formatToken === 'json' ? 'json' : formatToken ? 'xlsx' : null;

      const bu = await getUser(phone);
      if (!canUseBackup(bu)) {
        await reply('❌ Backup data hanya tersedia untuk tier Premium & Sultan. Upgrade dulu ya.');
        return true;
      }

      if (!format) {
        pendingStates.set(jid, { state: 'await_backup_format', data: { month }, expiresAt: Date.now() + PENDING_TTL_MS });
        await reply(
          `📦 Mau backup format apa?\n` +
            `Balas *EXCEL*, *PDF*, atau *JSON*` +
            (month ? ` (periode ${formatMonthLabel(month)})` : ' (semua data)') +
            `.\nAtau ketik langsung: *${prefix}backup excel* / *${prefix}backup pdf*.`,
        );
        return true;
      }

      await reply(
        `⏳ Menyiapkan backup ${format.toUpperCase()}${month ? ` periode ${formatMonthLabel(month)}` : ' (semua data)'}...`,
      );
      await sendBackup(sock, jid, phone, { month, format, quoted: msg });
      return true;
    }

    /* ------------------------------------------------------------- setlevel */
    case 'setlevel': {
      if (phone !== (normalizePhoneNumber(process.env.OWNER_NUMBER || '') || process.env.OWNER_NUMBER)) {
        await reply('❌ Hanya owner yang boleh mengubah level.');
        return true;
      }
      const targetPhone = normalizePhoneNumber(args[0] || '');
      const tier = (args[1] || '').toLowerCase();
      const days = Number(args[2]) || 30;
      if (!targetPhone || !['free', 'basic', 'premium', 'sultan'].includes(tier)) {
        await reply('❌ Format: `!setlevel <nomor> <free|basic|premium|sultan> [hari]`');
        return true;
      }
      const expiredAt = tier === 'free' ? null : new Date(Date.now() + days * 86400000).toISOString();
      await setUserTier(targetPhone, tier, expiredAt);
      await reply(`✅ Level ${targetPhone} diubah ke *${tier}*${expiredAt ? ` (expired ${expiredAt.slice(0, 10)})` : ''}.`);
      return true;
    }

    /* ---------------------------------------------------------- setbotlimit */
    case 'setbotlimit': {
      if (phone !== (normalizePhoneNumber(process.env.OWNER_NUMBER || '') || process.env.OWNER_NUMBER)) {
        await reply('❌ Hanya owner yang boleh mengubah limit bot.');
        return true;
      }
      const targetPhone = normalizePhoneNumber(args[0] || '');
      const limit = Number(args[1]);
      if (!targetPhone || !Number.isFinite(limit) || limit < 0) {
        await reply('❌ Format: `!setbotlimit <nomor> <limit>`');
        return true;
      }
      await updateUserFields(targetPhone, { sultan_bot_limit: limit });
      await reply(`✅ Limit bot ${targetPhone} diubah ke *${limit}*.`);
      return true;
    }

    /* --------------------------------------------------------------- quota */
    case 'quota': {
      const u = await getUser(phone);
      if (!u) { await reply('❌ User tidak ditemukan.'); return true; }
      await reply(
        [
          '📊 *KUOTA ANDA*',
          `Tier: *${u.tier}*${u.tier_expired_at ? ` (expired ${u.tier_expired_at.slice(0, 10)})` : ''}`,
          `Teks terpakai: ${u.text_quota_used}${u.tier === 'free' ? '/50' : u.tier === 'basic' ? ' (gabungan max 100)' : ''}`,
          `Media terpakai: ${u.media_quota_used}${u.tier === 'premium' ? '/100 (bulan)' : u.tier === 'basic' ? ' (max 1/hari)' : ''}`,
          `Limit bot Sultan: ${u.sultan_bot_limit}`,
          `Instance aktif: ${u.active_bot_instances.length}`,
        ].join('\\n'),
      );
      return true;
    }

    /* --------------------------------------------------------------- saldo */
    case 'saldo':
    case 'wallet': {
      // `!wallet <nama> <saldo_awal>` -> set saldo awal
      if (cmd === 'wallet' && args.length >= 2) {
        const nominal = Number(args[args.length - 1].replace(/[^\d]/g, ''));
        const walletName = args.slice(0, -1).join(' ');
        if (!Number.isFinite(nominal)) {
          await reply('❌ Format: `!wallet <nama> <saldo_awal>`\nContoh: `!wallet BCA 5000000`');
          return true;
        }
        await setWalletBalance(phone, walletName, nominal);
        const bal = await getWalletBalance(phone, walletName);
        await reply(
          `✅ Saldo awal *${walletName}* diset ke *${formatRupiah(nominal)}*.\nSaldo akhir sekarang: *${formatRupiah(bal)}*`,
        );
        return true;
      }

      const balances = await getWalletBalances(phone);
      const total = balances.reduce((s, w) => s + w.balance, 0);
      await reply(
        [
          '👛 *SALDO WALLET*',
          '',
          formatWalletList(balances),
          '',
          `💰 *Total: ${formatRupiah(total)}*`,
          '',
          `_Set saldo awal: ${prefix}wallet BCA 5000000_`,
        ].join('\n'),
      );
      return true;
    }

    /* -------------------------------------------------------------- budget */
    case 'budget': {
      if (args.length < 2) {
        const budgets = await getBudgets(phone);
        if (!budgets.length) {
          await reply(
            `Belum ada budget.\nFormat: \`${prefix}budget <kategori> <limit>\`\nContoh: \`${prefix}budget Makanan & Minuman 1500000\``,
          );
          return true;
        }
        const categories = await getCategoryExpenses(phone, currentMonth());
        const lines = budgets.map((b) => {
          const used = categories[b.category] || 0;
          const pct = b.limit > 0 ? Math.round((used / b.limit) * 100) : 0;
          return `   • ${b.category}: ${formatRupiah(used)} / ${formatRupiah(b.limit)} (${pct}%)`;
        });
        await reply(['🎯 *BUDGET BULAN INI*', '', ...lines].join('\n'));
        return true;
      }

      const nominal = Number(args[args.length - 1].replace(/[^\d]/g, ''));
      const category = args.slice(0, -1).join(' ');
      if (!Number.isFinite(nominal) || !category) {
        await reply(`❌ Format: \`${prefix}budget <kategori> <limit>\`\nContoh: \`${prefix}budget Transport 500000\``);
        return true;
      }
      await setBudget(phone, category, nominal);
      await reply(`✅ Budget *${category}* diset ke *${formatRupiah(nominal)}*/bulan.`);
      return true;
    }

    /* --------------------------------------------------------------- reset */
    case 'reset': {
      if (args[0] !== 'konfirmasi') {
        pendingStates.set(jid, { state: 'await_reset_confirm', data: {}, expiresAt: Date.now() + PENDING_TTL_MS });
        await reply(
          `⚠️ *PERINGATAN*\nPerintah ini akan menghapus SELURUH data transaksi, wallet, dan budget milikmu.\n\nBalas *YA* dalam 5 menit untuk melanjutkan.`,
        );
        return true;
      }
      await hardResetUser(jid, phone);
      return true;
    }

    /* -------------------------------------------------------------- reload */
    case 'reload': {
      if (owner && phone !== owner) {
        await reply('❌ Fitur ini khusus owner/admin bot.');
        return true;
      }
      const ok = await reloadEnv();
      await reply(ok ? '♻️ Konfigurasi .env berhasil dimuat ulang.' : '❌ Gagal memuat ulang .env.');
      return true;
    }

    /* --------------------------------------------------------------- addapi */
    case 'addapi':
    case 'addapikey':
    case 'tambahapi': {
      if (owner && phone !== owner) {
        await reply('❌ Fitur ini khusus owner/admin bot.');
        return true;
      }

      const key = args.join('').trim();
      if (!key) {
        await reply(`❌ Format: ${prefix}addapi <api_key>\nContoh: ${prefix}addapi AIza...`);
        return true;
      }

      try {
        const envPath = path.resolve('.env');
        let content = await fs.readFile(envPath, 'utf8');
        const lineRegex = /^GEMINI_API_KEYS=.*$/m;
        if (lineRegex.test(content)) {
          content = content.replace(lineRegex, (line) => {
            const existing = line
              .slice('GEMINI_API_KEYS='.length)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            if (existing.includes(key)) return line; // sudah ada, jangan duplikat
            return `GEMINI_API_KEYS=${[...existing, key].join(',')}`;
          });
        } else {
          content = content.trimEnd() + `\nGEMINI_API_KEYS=${key}\n`;
        }
        await fs.writeFile(envPath, content, 'utf8');
        await reloadEnv();

        const total = (process.env.GEMINI_API_KEYS || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean).length;
        await reply(`✅ API key Gemini berhasil ditambahkan.\nTotal API key terdaftar: *${total}*`);
      } catch (err) {
        await reply(`❌ Gagal menambahkan API key: ${err?.message || err}`);
      }
      return true;
    }

    /* ------------------------------------------------------- setzonawaktu */
    case 'setzonawaktu':
    case 'settimezone':
    case 'setzona':
    case 'timezone': {
      const arg = args.join(' ').trim();
      if (!arg) {
        pendingStates.set(jid, { state: 'await_timezone_choice', data: {}, expiresAt: Date.now() + PENDING_TTL_MS });
        await reply(
          [
            '🌍 *SET ZONA WAKTU*',
            '',
            'Pilih zona waktu kamu:',
            '   • *WIB*  — Asia/Jakarta (UTC+7)',
            '   • *WITA* — Asia/Makassar (UTC+8)',
            '   • *WIT*  — Asia/Jayapura (UTC+9)',
            '',
            `Balas *WIB*, *WITA*, atau *WIT* (atau langsung \`${prefix}setzonawaktu WIB\`).`,
          ].join('\n'),
        );
        return true;
      }

      const tz = normalizeTimezone(arg);
      if (!tz) {
        await reply('❌ Zona waktu tidak dikenali. Pilih: WIB, WITA, atau WIT.');
        return true;
      }
      await setUserTimezone(phone, tz);
      await reply(`✅ Zona waktu diset ke *${timezoneLabel(tz)}*.`);
      return true;
    }

    default:
      return false; // bukan perintah yang dikenal -> lanjut ke AI
  }
}

/**
 * Menghapus seluruh data milik satu user dari semua koleksi JSON.
 * (User + wallet default dibuat ulang dengan saldo 0.)
 *
 * Catatan skema: `users.json` memakai key `phone`, sedangkan koleksi lain
 * memakai `user_phone`. Keduanya harus ditangani agar reset benar-benar bersih.
 */
const USER_KEY_BY_COLLECTION = {
  users: 'phone',
  transactions: 'user_phone',
  wallets: 'user_phone',
  budgets: 'user_phone',
};

async function hardResetUser(jid, phone) {
  for (const collection of COLLECTIONS) {
    const key = USER_KEY_BY_COLLECTION[collection] ?? 'user_phone';
    await withCollection(collection, (rows) => {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i]?.[key] === phone) rows.splice(i, 1);
      }
    });
  }

  // Daftarkan ulang user + wallet default (saldo 0).
  // Baris user sudah dihapus di atas, sehingga upsertUser() menganggapnya
  // user BARU dan kembali melakukan seeding wallet default.
  await upsertUser(phone, phone);

  await sock.sendMessage(jid, {
    text: '🧹 Semua data kamu telah dihapus. Wallet default dibuat ulang dengan saldo 0.\n\nby: ampang dev',
  });
}

/* ==========================================================================
 *  AI ROUTER (intent dari Gemini)
 * ========================================================================== */

/**
 * Menjalankan aksi sesuai intent AI.
 * @param {{intent:string, data:object|null}} ai
 */
async function handleAiResult(ai, ctx) {
  const { jid, phone, msg } = ctx;
  const timezone = ctx.timezone || CONFIG.timezone;
  const reply = (text) => sock.sendMessage(jid, { text: `${text}\n\nby: ampang dev` }, { quoted: msg });

  switch (ai.intent) {
    /* ------------------------------------------------- add_transaction --- */
    case 'add_transaction': {
      const data = ai.data || {};
      if (!data.amount || data.amount <= 0) {
        await reply(
          `🤔 Nominalnya belum jelas. Contoh yang benar:\n• _"Beli kopi 25rb pakai QRIS"_\n• _"Gaji 8 juta masuk BCA"_`,
        );
        return;
      }

      // Tanggal + jam yang disebut AI sudah digabung jadi timestamp ISO UTC
      // (lihat combineDateTime di services/gemini.js).
      const date = data.date ? new Date(data.date) : new Date();
      const tx = await addTransaction({
        user_phone: phone,
        type: data.type,
        amount: data.amount,
        category: data.category,
        wallet: data.wallet,
        description: data.description,
        date: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
      });

      const balance = await getWalletBalance(phone, tx.wallet);
      await reply(formatTransactionReply(tx, balance, timezone));

      // Peringatan bila budget kategori ini terlampaui
      await checkBudgetAlert(phone, tx, jid, msg);
      return;
    }

    /* ------------------------------------------------------- get_report -- */
    case 'get_report': {
      // Bila pesan menyebut bulan lain ("bulan lalu"), pakai bulan sebelumnya
      const text = (ctx.text || '').toLowerCase();
      const explicit = (ctx.text || '').match(/(\d{4})-(\d{2})/);
      const month = explicit
        ? `${explicit[1]}-${explicit[2]}`
        : /bulan lalu|lalu|kemarin bulan|previous/.test(text)
          ? previousMonth()
          : currentMonth();

      const [stats, balances, categories, budgets, transactions] = await Promise.all([
        getStats(phone, month),
        getWalletBalances(phone),
        getCategoryExpenses(phone, month),
        getBudgets(phone),
        listTransactions(phone, { month }),
      ]);
      await reply(buildReport({ month, stats, balances, categories, budgets, transactions, timezone }));
      return;
    }

    /* ------------------------------------------------------- get_backup -- */
    case 'get_backup': {
      const bu = await getUser(phone);
      if (!canUseBackup(bu)) {
        await reply('❌ Backup data hanya tersedia untuk tier Premium & Sultan.');
        return;
      }
      pendingStates.set(jid, { state: 'await_backup_format', data: { month: null }, expiresAt: Date.now() + PENDING_TTL_MS });
      await reply(
        `📦 Mau backup format apa?\nBalas *EXCEL* atau *PDF* (semua data).\n` +
          `Atau ketik *${CONFIG.prefixes[0]}backup excel* / *${CONFIG.prefixes[0]}backup pdf*.`,
      );
      return;
    }

    /* ----------------------------------------------------------- unknown - */
    default:
      await reply(
        [
          '🤔 Maaf, saya belum paham maksudnya.',
          '',
          'Coba tulis seperti ini:',
          '   • _"Beli nasi goreng 20rb cash"_',
          '   • _"Gaji bulan ini 8 juta masuk BCA"_',
          `   • _"Rekap pengeluaran bulan ini"_`,
          '',
          '📸 Bisa juga kirim *foto struk* — otomatis dicatat.',
          '',
          `Ketik *${CONFIG.prefix}help* untuk melihat semua fitur.`,
        ].join('\n'),
      );
  }
}

/**
 * Tangani hasil pembacaan struk: catat 1 transaksi expense dengan total struk.
 * @param {object} receipt hasil parseReceiptImage
 * @param {object} ctx      { jid, phone, msg, text }
 */
async function handleReceiptResult(receipt, ctx) {
  const { jid, phone, msg } = ctx;
  const timezone = ctx.timezone || CONFIG.timezone;
  const reply = (text) => sock.sendMessage(jid, { text: `${text}\n\nby: ampang dev` }, { quoted: msg });

  // Bukan struk -> beri petunjuk, jangan necat transaksi apa pun.
  if (!receipt?.is_receipt) {
    await reply(
      [
        '🤔 Sepertinya foto itu *bukan struk belanja*.',
        '',
        'Tips biar struknya kebaca:',
        '   • foto close-up, pencahayaan cukup terang',
        '   • pastikan bagian *TOTAL* dan nama toko terlihat',
        '',
        'Kalau tetap gagal, catat manual aja: _"Belanja 75rb"_',
      ].join('\n'),
    );
    return;
  }

  // Total tidak terbaca -> jangan necat transaksi dengan nominal 0.
  if (!receipt.total || receipt.total <= 0) {
    await reply(
      [
        '💡 Struk-nya kelihatan, tapi *nominal totalnya tidak terbaca*.',
        '',
        'Bisa sebut manual nominalnya? misalnya:',
        `   _"Belanja ${Math.round((receipt.subtotal || 0) / 1000) * 1000 || 50000} Cash"_`,
      ].join('\n'),
    );
    return;
  }

  // Wallet + deskripsi + tanggal/jam dihitung oleh service receipt.
  const txFields = buildReceiptTransaction(receipt, {
    caption: ctx.text || '',
    timezone,
  });

  const tx = await addTransaction({
    user_phone: phone,
    type: txFields.type,
    amount: txFields.amount,
    category: txFields.category,
    wallet: txFields.wallet,
    description: txFields.description,
    date: txFields.date,
    items: txFields.items,
    source: 'receipt',
  });

  const balance = await getWalletBalance(phone, tx.wallet);
  await reply(formatReceiptReply(receipt, tx, balance, timezone));

  // Peringatan bila budget kategori ini terlampaui
  await checkBudgetAlert(phone, tx, jid, msg);
}

/** Kirim peringatan bila penggunaan budget kategori ≥ 80%. */
async function checkBudgetAlert(phone, tx, jid, quoted) {
  try {
    if (tx.type !== 'expense') return;
    const budgets = await getBudgets(phone);
    const budget = budgets.find(
      (b) => String(b.category).toLowerCase() === String(tx.category).toLowerCase(),
    );
    if (!budget || !budget.limit) return;

    const categories = await getCategoryExpenses(phone, currentMonth());
    const used = categories[budget.category] || 0;
    const pct = Math.round((used / budget.limit) * 100);
    if (pct < 80) return;

    const isOver = used > budget.limit;
    const emoji = isOver ? '🔴' : '🟡';
    const status = isOver ? 'TERLAMPAUI' : 'HAMPIR HABIS';
    await sock.sendMessage(
      jid,
      {
        text: `${emoji} *BUDGET ${status}*\n\nKategori *${budget.category}* sudah terpakai *${formatRupiah(used)}* dari limit *${formatRupiah(budget.limit)}* (${pct}%).\n${
          isOver ? `Kelebihan: *${formatRupiah(used - budget.limit)}*` : `Sisa: *${formatRupiah(budget.limit - used)}*`
        }\n\nby: ampang dev`,
      },
      quoted ? { quoted } : {},
    );
  } catch (err) {
    console.warn('[BUDGET] Gagal cek alert:', err.message);
  }
}

/* ==========================================================================
 *  INSTRUKSI ANALISIS KEUANGAN (PERSONA)
 * ========================================================================== */
const ANALYSIS_INSTRUCTION = `Kamu adalah seorang Perencana Keuangan Pribadi (Personal Financial Analyst & Coach) yang ramah, analitis, intuitif, dan solutif.

Tugas utamamu adalah menganalisis data catatan keuangan pengguna selama 1 bulan penuh, memberikan evaluasi menyeluruh, serta memberikan saran aksi (actionable insights) yang mudah diterapkan.

ATURAN UTAMA & CARA KERJA:
1. BAHASA & NADA BICARA:
   - Gunakan bahasa Indonesia yang santai, suportif, empatik, namun tetap profesional.
   - Hindari menggurui atau menghakimi gaya hidup pengguna, berikan kritikan yang membangun.

2. PROSES ANALISIS:
   - Hitung Total Pemasukan, Total Pengeluaran, dan Net Savings (Sisa Uang/Cashflow).
   - Kelompokkan pengeluaran ke dalam kategori utama:
     * Needs (Kebutuhan Pokok): Makanan harian, tagihan, tempat tinggal, transport, kesehatan.
     * Wants (Keinginan/Gaya Hidup): Jajan/kopi, hiburan, belanja non-pokok, langganan, hobi.
     * Financial Goals (Investasi/Tabungan/Cicilan): Tabungan, investasi, bayar utang.
   - Hitung persentase dari masing-masing kategori terhadap total pengeluaran atau total pemasukan.

3. FORMAT STRUKTUR OUTPUT / BALASAN BOT:
   Susun laporan analisis bulanan dengan struktur berikut (gunakan format Markdown yang rapi):

   📊 **REKAP KEUANGAN BULAN [NAMA BULAN/PERIODE]**
   ---
   • Total Pemasukan  : Rp X.XXX.XXX
   • Total Pengeluaran : Rp X.XXX.XXX
   • Sisa Cashflow     : Rp X.XXX.XXX (Persentase % dari Pemasukan)

   ---

   🔍 **BREAKDOWN PENGELUARAN UTAMA**
   - 🏠 **Kebutuhan (Needs)**: Rp X.XXX (X%)
   - 🍕 **Keinginan (Wants)**: Rp X.XXX (X%)
   - 📈 **Tabungan/Investasi/Cicilan**: Rp X.XXX (X%)

   ---

   💡 **HIGHLIGHT & CATATAN PENTING (REVIEW)**
   - **Kategori Terboros**: Sebutkan kategori atau item transaksi terbesar dan berikan pandanganmu.
   - **Pola Transaksi**: Soroti kebiasaan belanja yang unik.
   - **Kesehatan Cashflow**: Tentukan apakah cashflow bulan ini Sehat / Waspada / Bahaya.

   ---

   🎯 **SARAN & REKOMENDASI UNTUK BULAN DEPAN**
   - Berikan 2-3 langkah konkret yang realistis untuk memotong pengeluaran bocor halus atau meningkatkan tabungan di bulan berikutnya.

Gunakan data transaksi yang diberikan pengguna. Jangan mengarang angka; hitung dari data. Jika data tidak cukup untuk suatu kategori, nyatakan perkiraan dengan jelas.`;

/* ==========================================================================
 *  MESSAGE ORCHESTRATOR
 * ========================================================================== */

/** Titik masuk setiap pesan masuk dari messages.upsert. */
async function processIncomingMessage(msg) {
  const remoteJid = msg.key?.remoteJid;

  // Abaikan: grup, status, broadcast, newsletter
  if (!isPrivateChat(msg, remoteJid)) return;

  // JID balasan = chat tempat pesan masuk (bisa @s.whatsapp.net atau @lid).
  const jid = jidNormalizedUser(remoteJid);

  // Nomor telepon asli pengirim. Bila WhatsApp mengirim dalam bentuk @lid,
  // `key.senderPn` berisi nomor telepon sebenarnya (mis. 6281253542661).
  const rawSender = resolveSenderJid(msg, remoteJid);
  const phone = phoneFromJid(rawSender);
  if (!phone || phone === 'status') return;

  // ---------------------------------------------------------------------
  // Pengaman: JID `@lid` TANPA `senderPn`.
  //
  // Bila WhatsApp tidak menyertakan nomor telepon (senderPn) — mis. pada
  // sebagian pesan dari diri sendiri / sinkronisasi — maka yang tersisa
  // hanyalah angka LID (mis. "113868290408451", 15 digit). Angka itu BUKAN
  // nomor telepon dan tidak boleh disimpan sebagai user.
  //
  // Nomor telepon Indonesia selalu diawali "62" dan panjang 10-15 digit
  // (62 + 8..13). LID acak hampir selalu gagal pola ini.
  // ---------------------------------------------------------------------
  const isPhoneNumber = /^62\d{8,13}$/.test(phone);
  if (!isPhoneNumber) {
    // Untuk pesan dari diri sendiri kita masih tahu nomor bot yang sebenarnya.
    if (msg.key?.fromMe && botNumber) {
      // lanjut dengan nomor bot di bawah
    } else {
      console.warn(`[MSG] Dilewati: pengirim tanpa nomor telepon (JID: ${rawSender})`);
      return;
    }
  }
  const effectivePhone = isPhoneNumber ? phone : botNumber;

  const name = msg.pushName || (isPhoneNumber ? effectivePhone : 'Saya');
  const reply = (text) => sock.sendMessage(jid, { text: `${text}\n\nby: ampang dev` }, { quoted: msg });

  // Cek registrasi user: jika belum terdaftar, tawarkan pendaftaran.
  let existingUser = await getUser(effectivePhone);
  if (!existingUser) {
    const pending = pendingStates.get(jid);
    if (pending && pending.state === 'await_register' && pending.expiresAt > Date.now()) {
      pendingStates.delete(jid);
      if (/\b(daftar|ya|yes|y)\b/i.test(extractText(msg.message || {}))) {
        await upsertUser(effectivePhone, name);
        await reply('✅ Pendaftaran berhasil! Sekarang Anda bisa menggunakan bot. Ketik *!help* untuk menu.');
        return;
      }
      await reply('Balas *DAFTAR* untuk mendaftar dan menggunakan bot.');
      return;
    }

    pendingStates.set(jid, { state: 'await_register', data: {}, expiresAt: Date.now() + PENDING_TTL_MS });
    await reply(
      [
        '👋 Halo! Anda belum terdaftar di bot ini.',
        '',
        'Balas *DAFTAR* untuk mendaftar dan mulai menggunakan bot.',
      ].join('\n'),
    );
    return;
  }

  // Perbarui nama bila perlu
  await upsertUser(effectivePhone, name);

  const timezone = await getUserTimezone(effectivePhone);
  const ctx = { jid, phone: effectivePhone, name, msg, timezone };

  // Tandai pesan sudah dibaca (centang biru) — praktik yang baik
  sock.readMessages([msg.key]).catch(() => {});

  const textContent = extractText(msg.message || {});

  // ==== 0. State interaktif (mis. konfirmasi reset) ====
  const pending = pendingStates.get(jid);
  if (pending && pending.expiresAt > Date.now()) {
    pendingStates.delete(jid);
    if (pending.state === 'await_reset_confirm') {
      if (/\b(ya|yes|yakin|hapus|ok)\b/i.test(textContent)) {
        await hardResetUser(jid, effectivePhone);
      } else {
        await reply('✅ Dibatalkan. Datamu aman.');
      }
      return;
    }
    if (pending.state === 'await_timezone_choice') {
      const tz = normalizeTimezone(textContent);
      if (!tz) {
        await reply('❌ Pilihan tidak dikenali. Balas *WIB*, *WITA*, atau *WIT*.');
        return;
      }
      await setUserTimezone(effectivePhone, tz);
      await reply(`✅ Zona waktu diset ke *${timezoneLabel(tz)}*.`);
      return;
    }
    if (pending.state === 'await_backup_format') {
      const t = textContent.toLowerCase();
      let format = null;
      if (/\bpdf\b/.test(t)) format = 'pdf';
      else if (/\bjson\b/.test(t)) format = 'json';
      else if (/\b(excel|xlsx|xls)\b/.test(t)) format = 'xlsx';
      if (!format) {
        pendingStates.set(jid, { state: 'await_backup_format', data: pending.data, expiresAt: Date.now() + PENDING_TTL_MS });
        await reply('❌ Pilihan tidak dikenali. Balas *EXCEL*, *PDF*, atau *JSON*.');
        return;
      }
      const month = pending.data?.month ?? null;
      await reply(
        `⏳ Menyiapkan backup ${format.toUpperCase()}${month ? ` periode ${formatMonthLabel(month)}` : ' (semua data)'}...`,
      );
      await sendBackup(sock, jid, effectivePhone, { month, format, quoted: msg });
      return;
    }
  }

  // ==== 1. Perintah teks berawalan prefix ====
  const prefix = detectPrefix(textContent);
  if (prefix) {
    const handled = await handleCommand(prefix, textContent, ctx);
    if (handled) return;
  }

  // ==== 2. Voice note -> Gemini (audio -> transkripsi + ekstraksi) ====
  const audioMessage = msg.message?.audioMessage;
  if (audioMessage) {
    const q = await checkAndConsumeQuota(effectivePhone, 'media');
    if (!q.allowed) { await reply(q.reason); return; }
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      const ai = await parseMessage({
        audio: buffer,
        mimeType: audioMessage.mimetype || 'audio/ogg',
        timezone,
      });
      await handleAiResult(ai, { ...ctx, text: null });
    } catch (err) {
      console.error('[VOICE] Gagal memproses voice note:', err.message);
      if (err?.code === 'GEMINI_QUOTA_EXCEEDED' || err?.code === 'GEMINI_ALL_FAILED') {
        await reportAiFailureToOwner(sock, err, ctx, getRotationStatus(), { timezone: CONFIG.timezone });
        await reply(
          '⏳ Kuota AI sedang habis untuk semua model. Coba lagi beberapa saat lagi ya.\n' +
            `Perintah manual tetap jalan: *${CONFIG.prefixes[0]}rekap*, *${CONFIG.prefixes[0]}backup*, *${CONFIG.prefixes[0]}saldo*.`
        );
      } else {
        await reply('😔 Maaf, voice note-nya gagal diproses. Coba kirim sebagai teks ya.');
      }
    }
    return;
  }

  // ==== 3. Foto struk -> Gemini (baca struk belanja) ====
  const imageMessage = msg.message?.imageMessage;
  if (imageMessage) {
    const q = await checkAndConsumeQuota(effectivePhone, 'media');
    if (!q.allowed) { await reply(q.reason); return; }
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      const receipt = await parseReceiptImage(buffer, imageMessage.mimetype || 'image/jpeg', {
        caption: textContent || '',
        timezone,
      });
      await handleReceiptResult(receipt, { ...ctx, text: textContent });
    } catch (err) {
      console.error('[STRUK] Gagal membaca struk:', err.message);
      if (err?.code === 'GEMINI_QUOTA_EXCEEDED' || err?.code === 'GEMINI_ALL_FAILED') {
        await reportAiFailureToOwner(sock, err, ctx, getRotationStatus(), { timezone: CONFIG.timezone });
        await reply(
          '⏳ Kuota AI sedang habis untuk semua model. Coba lagi beberapa saat lagi ya.\n' +
            `Perintah manual tetap jalan: *${CONFIG.prefixes[0]}rekap*, *${CONFIG.prefixes[0]}backup*, *${CONFIG.prefixes[0]}saldo*.`
        );
      } else {
        await reply(
          '😔 Maaf, struknya gagal dibaca. Coba foto ulang yang lebih jelas, atau catat manual: _"Belanja 75rb"_'
        );
      }
    }
    return;
  }

  // ==== 4. Teks bebas -> Gemini (parsing intent + data) ====
  if (!textContent) return; // tipe pesan lain (gambar, stiker, dll) diabaikan

  const tq = await checkAndConsumeQuota(effectivePhone, 'text');
  if (!tq.allowed) { await reply(tq.reason); return; }

  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  try {
    const ai = await parseMessage({ text: textContent, timezone });
    await handleAiResult(ai, { ...ctx, text: textContent });
  } catch (err) {
    console.error('[AI] Gagal memproses pesan:', err.message);
    if (err?.code === 'GEMINI_QUOTA_EXCEEDED' || err?.code === 'GEMINI_ALL_FAILED') {
      await reportAiFailureToOwner(sock, err, ctx, getRotationStatus(), { timezone: CONFIG.timezone });
      await reply(
        '⏳ Kuota AI sedang habis untuk semua model. Coba lagi beberapa saat lagi ya.\n' +
          `Perintah manual tetap jalan: *${CONFIG.prefixes[0]}rekap*, *${CONFIG.prefixes[0]}backup*, *${CONFIG.prefixes[0]}saldo*.`
      );
    } else {
      await reply(
        '⚠️ Terjadi kendala saat memproses pesanmu (AI/API).\n' +
          `Coba lagi beberapa saat. Perintah manual tetap jalan: *${CONFIG.prefixes[0]}rekap*, *${CONFIG.prefixes[0]}backup*, *${CONFIG.prefixes[0]}saldo*.`,
      );
    }
  }
}

/* ==========================================================================
 *  CRONJOB
 * ========================================================================== */

/** Jalankan job untuk SEMUA user terdaftar (dipanggil cron). */
async function forEachUser(handler) {
  if (!sock?.user) {
    console.warn('[CRON] WhatsApp belum terhubung, job dilewati.');
    return;
  }
  const { listUsers } = await import('./config/database.js');
  const users = await listUsers();
  console.log(`[CRON] Memproses ${users.length} user...`);

  for (const user of users) {
    try {
      await handler(user, `${user.phone}@s.whatsapp.net`);
      await sleep(1500); // jeda antar-user agar tidak kena rate limit
    } catch (err) {
      console.error(`[CRON] Gagal untuk ${user.phone}:`, err.message);
    }
  }
}

function startCronJobs() {
  const opts = { timezone: CONFIG.timezone };
  const tasks = [];

  const weekly = process.env.CRON_BACKUP_WEEKLY || '0 20 * * 0';
  const monthly = process.env.CRON_REPORT_MONTHLY || '0 8 1 * *';
  const prune = process.env.CRON_PRUNE_BACKUPS || '0 3 * * *';

  // --- 1. Auto backup mingguan (kirim file Excel ke tiap user) ---
  if (cron.validate(weekly)) {
    tasks.push(
      cron.schedule(
        weekly,
        async () => {
          console.log('[CRON] Auto-backup mingguan dimulai...');
          await forEachUser((user, jid) => sendBackup(sock, jid, user.phone, { month: null }));
        },
        opts,
      ),
    );
  }

  // --- 2. Laporan + backup bulanan (periode = bulan sebelumnya) ---
  if (cron.validate(monthly)) {
    tasks.push(
      cron.schedule(
        monthly,
        async () => {
          const month = previousMonth();
          console.log(`[CRON] Laporan bulanan periode ${month}...`);
          await forEachUser(async (user, jid) => {
            const tz = await getUserTimezone(user.phone);
            const [stats, balances, categories, budgets, transactions] = await Promise.all([
              getStats(user.phone, month),
              getWalletBalances(user.phone),
              getCategoryExpenses(user.phone, month),
              getBudgets(user.phone),
              listTransactions(user.phone, { month }),
            ]);

            await sock.sendMessage(jid, {
              text: `${buildReport({ month, stats, balances, categories, budgets, transactions, timezone: tz })}\n\nby: ampang dev`,
            });

            // Lampirkan file Excel periode tersebut sebagai arsip
            await sendBackup(sock, jid, user.phone, { month });
          });
        },
        opts,
      ),
    );
  }

  // --- 3. Pembersihan file backup lama (disk hygiene) ---
  if (cron.validate(prune)) {
    tasks.push(cron.schedule(prune, () => pruneOldBackups(), opts));
  }

  console.log(
    `[CRON] Terjadwal (${CONFIG.timezone}): mingguan="${weekly}" | bulanan="${monthly}" | prune="${prune}"`,
  );
  return tasks;
}

/* ==========================================================================
 *  BAILEYS — KONEKSI VIA PAIRING CODE (TANPA QR)
 * ========================================================================== */

/* -------------------------------------------------------------------------
 *  Helper terminal
 * ---------------------------------------------------------------------- */

/** Buat (atau pakai ulang) antarmuka readline. */
function getRl() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

function closeRl() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

/** Tanya ke terminal; mengembalikan null bila non-interaktif / gagal. */
async function ask(question) {
  if (!interactive) return null;
  try {
    return (await getRl().question(question)).trim();
  } catch {
    return null;
  }
}

/* ==========================================================================
 *  PEMILIHAN METODE KONEKSI (ditanyakan SEBELUM scan/kode)
 * ========================================================================== */

/** Normalisasi nilai metode dari .env / input pengguna -> 'pairing' | 'qr' | null */
function normalizeMethod(input) {
  const v = String(input || '').trim().toLowerCase();
  if (['1', 'pairing', 'pairingcode', 'pairing-code', 'code', 'kode'].includes(v)) {
    return 'pairing';
  }
  if (['2', 'qr', 'qrcode', 'qr-code', 'scan', 'pindai'].includes(v)) return 'qr';
  return null;
}

/** Tampilkan menu pilihan metode koneksi. */
function printMethodMenu(suggested = null) {
  const mark = (m) => (suggested === m ? '  ← saran' : '');
  console.log('\n==================================================');
  console.log('  PILIH METODE KONEKSI WHATSAPP');
  console.log('==================================================');
  console.log(`   1) PAIRING CODE  — tautkan dengan nomor telepon${mark('pairing')}`);
  console.log('      Bot menampilkan 8 karakter. Masukkan di WhatsApp >');
  console.log('      Perangkat Tertaut > "Tautkan dengan nomor telepon saja".');
  console.log('      (kode hanya berlaku ±60 detik, dibuat ulang otomatis)');
  console.log('');
  console.log(`   2) QR CODE       — tautkan dengan memindai${mark('qr')}`);
  console.log('      Bot menampilkan QR di terminal. Pindai lewat WhatsApp >');
  console.log('      Perangkat Tertaut > "Tautkan Perangkat".');
  console.log('      (paling andal; QR dibuat ulang otomatis ±20 detik)');
  console.log('==================================================');
}

/**
 * Tentukan metode koneksi SEBELUM apa pun dikoneksikan.
 *
 * Urutan keputusan:
 *   1. Sudah ada sesi tersimpan  -> tidak perlu metode (langsung connect)
 *   2. CONNECTION_METHOD di .env -> dipakai sebagai default/saran
 *   3. Terminal TTY              -> TANYAKAN pilihan (1/2), ENTER = default
 *   4. Non-TTY tanpa .env        -> default 'pairing' (dengan peringatan)
 *
 * @param {string} page 'connect' (awal) atau 'reconnect' (socket terputus)
 */
async function resolveConnectionMethod(page) {
  const fromEnv = normalizeMethod(process.env.CONNECTION_METHOD);

  if (page === 'reconnect') {
    if (!connectionMethod) connectionMethod = fromEnv || 'pairing';
    console.log(`[AUTH] Metode koneksi yang sedang dipakai: ${connectionMethod.toUpperCase()}`);
    return connectionMethod;
  }

  /** @type {'pairing'|'qr'} */
  let chosen;

  // TTY -> tanya; non-TTY -> pakai .env / default.
  if (interactive) {
    const defaultMethod = fromEnv || 'pairing';
    printMethodMenu(defaultMethod);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const label = `  Pilih metode [1 = Pairing, 2 = QR] (ENTER = ${defaultMethod}): `;
      const raw = await ask(label);
      if (raw === null) break; // EOF / terminal bermasalah

      if (raw === '') {
        chosen = defaultMethod;
        break;
      }
      const parsed = normalizeMethod(raw);
      if (!parsed) {
        console.log(`  ⚠️  "${raw}" bukan pilihan yang dikenali. Ketik 1 atau 2.`);
        continue;
      }
      chosen = parsed;
      break;
    }
    // Tidak ada jawaban -> pakai default.

    chosen = chosen || defaultMethod;
  } else {
    chosen = fromEnv || 'pairing';
  }

  connectionMethod = chosen;
  // Simpan agar pilihan ikut terpakai modul lain / proses anak.
  process.env.CONNECTION_METHOD = chosen;
  console.log(`\n  ✅ Metode koneksi: ${chosen === 'qr' ? 'QR CODE' : 'PAIRING CODE'}\n`);
  return chosen;
}

/** Tampilkan QR yang diterima dari WhatsApp ke terminal. */
function renderQr(qr) {
  if (!qr) return;
  lastQr = qr;

  // qrcode-terminal 'small' = lebih ringkas, tetap terbaca di terminal HP/desktop.
  const qrText = qrcode.generate(qr, { small: true }, (output) => output);

  console.log('\n==================================================');
  console.log('  QR CODE KONEKSI WHATSAPP');
  console.log('==================================================');
  console.log('  Langkah aktivasi:');
  console.log('   1. Buka WhatsApp di HP nomor bot');
  console.log('   2. Pengaturan > Perangkat Tertaut > Tautkan Perangkat');
  console.log('   3. Pindai QR di bawah ini');
  console.log('  ⏰ QR dibuat ulang otomatis (±20 detik).');
  console.log('     Bila gagal, tunggu QR berikutnya lalu pindai lagi.');
  console.log('--------------------------------------------------\n');
  // qrcode-terminal menulis langsung ke stdout.
  qrcode.generate(qr, { small: true });
  console.log('\n--------------------------------------------------');
  console.log('  (QR di atas diperbarui otomatis — jangan di-scroll jauh)');
  console.log('==================================================\n');
  return qrText;
}

/**
 * Normalisasi nomor telepon ke format internasional (E.164 tanpa '+').
 *   "0812-3456-7890"  -> "6281234567890"   (asumsi Indonesia)
 *   "+62 812 3456..." -> "6281234567890"
 *   "6281234567890"   -> "6281234567890"
 *
 * Aturan: nomor Indonesia (seluler) selalu diawali "8" setelah kode negara 62.
 * Input tanpa awalan 0/62 hanya diterima bila memang diawali "8", supaya
 * nomor asing/typo tidak diam-diam diubah menjadi nomor Indonesia.
 *
 * Implementasinya ada di src/utils/phone.js (dipakai juga oleh services/owner.js).
 *
 * @returns {string|null} null bila tidak valid
 */

/**
 * Tentukan nomor bot: dari .env bila ada, jika tidak tanya lewat terminal.
 * Diulang sampai nomor valid (maks 3 kali).
 * @returns {Promise<string>} nomor valid, atau '' bila gagal
 */
async function resolveBotNumber() {
  const fromEnv = normalizePhoneNumber(process.env.BOT_NUMBER);
  if (fromEnv) {
    console.log(`[AUTH] Nomor bot dari .env: ${fromEnv}`);
    return fromEnv;
  }

  if (!interactive) {
    console.error('[AUTH] BOT_NUMBER kosong dan terminal non-interaktif (stdin bukan TTY).');
    console.error('[AUTH] Set BOT_NUMBER di .env lalu jalankan ulang.');
    return '';
  }

  console.log('\n==================================================');
  console.log('  METODE KONEKSI: PAIRING CODE');
  console.log('==================================================');
  console.log('  BOT_NUMBER belum diisi di .env.');
  console.log('  Masukkan nomor WhatsApp yang akan dijadikan bot.');
  console.log('  Contoh: 081234567890  atau  6281234567890\n');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const raw = await ask('  Nomor WhatsApp bot: ');
    if (raw === null) break; // terminal bermasalah / EOF

    if (raw === '') {
      console.log('  ⚠️  Nomor tidak boleh kosong.');
      continue;
    }

    const normalized = normalizePhoneNumber(raw);
    if (!normalized) {
      console.log(`  ⚠️  Format nomor "${raw}" tidak dikenali. Coba lagi.`);
      continue;
    }

    // Simpan juga ke process.env agar dipakai modul lain (mis. cron/reload).
    process.env.BOT_NUMBER = normalized;
    console.log(`  ✅ Nomor diterima: ${normalized}\n`);
    return normalized;
  }

  console.error('[AUTH] Gagal mendapatkan nomor bot yang valid.');
  return '';
}

/**
 * Cetak kode pairing dalam format yang mudah dibaca.
 *
 * Kode WhatsApp hanya berlaku ±60 detik. Waktu kedaluwarsa ditampilkan
 * eksplisit supaya pengguna tahu batas waktunya.
 */
function printPairingCode(rawCode, phone) {
  const pretty = String(rawCode).match(/.{1,4}/g)?.join('-') ?? rawCode;
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
  const hhmmss = expiresAt.toLocaleTimeString('en-GB', { hour12: false });
  console.log('\n==================================================');
  console.log(`  PAIRING CODE :  ${pretty}`);
  console.log('==================================================');
  console.log(`  Nomor bot : ${phone}`);
  console.log(`  ⏰ Kode berlaku sampai ±${hhmmss} (60 detik)`);
  console.log('  Langkah aktivasi:');
  console.log(`   1. Buka WhatsApp di HP nomor ${phone}`);
  console.log('   2. Pengaturan > Perangkat Tertaut > Tautkan Perangkat');
  console.log('   3. Pilih "Tautkan dengan nomor telepon saja"');
  console.log('   4. Masukkan kode di atas SEKARANG');
  if (interactive) {
    console.log('   ⚠️  Kode kedaluwarsa = "Gagal menautkan perangkat".');
    console.log('   Bot otomatis membuat kode baru saat kode lama habis.');
  }
  console.log('==================================================\n');
}

/**
 * Jadwalkan pembaruan kode otomatis tepat saat kode kedaluwarsa.
 *
 * Kode WhatsApp hanya hidup ±60 detik. Tanpa pembaruan, pengguna yang butuh
 * lebih dari 60 detik (membuka menu Perangkat Tertaut, mengetik 8 karakter)
 * akan selalu memasukkan kode yang sudah mati — dan WhatsApp menampilkan
 * "Gagal menautkan perangkat, dapatkan kode baru".
 *
 * Pembaruan TIDAK merugikan pengguna: kode lama memang sudah tidak berlaku
 * pada saat itu. Dengan pembaruan, selalu ada kode valid yang bisa dipakai.
 */
function schedulePairingCodeRefresh() {
  if (pairingCodeTimer) clearTimeout(pairingCodeTimer);
  if (pairingCountdownTimer) clearInterval(pairingCountdownTimer);

  const deadline = Date.now() + PAIRING_CODE_TTL_MS;

  // Hitung mundur supaya pengguna tahu sisa waktunya.
  if (interactive) {
    let lastShown = null;
    pairingCountdownTimer = setInterval(() => {
      if (pairingState !== 'pending' || sock?.user) {
        clearInterval(pairingCountdownTimer);
        pairingCountdownTimer = null;
        return;
      }
      const left = Math.ceil((deadline - Date.now()) / 1000);
      // Tampilkan tiap 10 detik, dan 5 detik terakhir tiap detik.
      if (left <= 5 || (left % 10 === 0 && left !== lastShown)) {
        lastShown = left;
        console.log(`   ⏳ ${left} detik tersisa untuk memasukkan kode...`);
      }
      if (left <= 0) {
        clearInterval(pairingCountdownTimer);
        pairingCountdownTimer = null;
      }
    }, 1000);
  }

  pairingCodeTimer = setTimeout(async () => {
    pairingCodeTimer = null;
    if (pairingCountdownTimer) {
      clearInterval(pairingCountdownTimer);
      pairingCountdownTimer = null;
    }
    // Sudah terhubung / tidak lagi pairing -> tidak perlu kode baru.
    if (pairingState === 'done' || sock?.user) return;
    if (pairingState !== 'pending') return;

    console.log('\n[AUTH] ⏰ Kode sebelumnya sudah kedaluwarsa.');
    console.log('[AUTH] Membuat kode BARU otomatis...');
    await requestPairingCode();
  }, PAIRING_CODE_TTL_MS);
}

/**
 * Tunggu sampai socket BENAR-BENAR siap menerima `requestPairingCode()`.
 *
 * Dua hal harus terpenuhi:
 *
 *   1. WebSocket sudah terbuka (`sock.ws.isOpen`).
 *   2. Handshake registrasi Baileys SUDAH selesai.
 *
 * Mengapa (2) penting — hasil pengukuran nyata:
 *
 *   ws.isOpen menjadi true pada  +485 ms
 *   handshake registrasi selesai +800 ms   <-- selisih ~315 ms
 *   requestPairingCode() pada   +485 ms  -> socket MATI (close 428)
 *   requestPairingCode() pada   +985 ms  -> socket HIDUP ✅
 *
 * Jadi `ws.isOpen` saja TERLALU AWAL. Bila pairing diminta saat handshake
 * masih berjalan, WhatsApp menutup koneksi (428 "Connection Terminated"),
 * kode menjadi tidak valid, dan WhatsApp menampilkan "pastikan nomor yang
 * anda masukan benar" saat pengguna memasukkan kode.
 *
 * Untuk nomor yang BELUM terdaftar, event `connection.update` tidak pernah
 * bernilai 'open' — jadi tidak bisa menunggu event itu.
 *
 * @param {object} sockObj socket Baileys
 * @param {number} [timeoutMs] batas waktu (default 20000 ms)
 * @returns {Promise<boolean>} true bila socket siap sebelum timeout
 */
async function waitForSocketOpen(sockObj, timeoutMs = 20_000) {
  const start = Date.now();

  // Tahap 1: tunggu WebSocket terbuka.
  while (Date.now() - start < timeoutMs) {
    if (!sockObj || sockObj.ws?.isOpen) break;
    if (sockObj?.user) return false; // keburu connect (sesi lama masih valid)
    await sleep(50);
  }
  if (!sockObj?.ws?.isOpen) return false;

  // Tahap 2: beri jeda agar handshake registrasi selesai.
  // Nilai ini berasal dari pengukuran: handshake selesai ~315 ms setelah
  // ws.isOpen. Kita pakai 1200 ms agar aman pada jaringan lambat.
  await sleep(1200);

  // Bila socket mati saat kita menunggu, laporkan gagal.
  return Boolean(sockObj?.ws?.isOpen);
}

/**
 * Minta pairing code dari WhatsApp.
 *
 * Alur yang benar:
 *   1. Tunggu socket benar-benar siap (`waitForSocketOpen`), termasuk
 *      menunggu handshake registrasi selesai.
 *   2. Pastikan socket belum berganti (reconnect) sebelum & sesudah request.
 *   3. Hanya SATU permintaan berjalan; permintaan kedua akan menimpa
 *      `creds.pairingCode` dan membatalkan kode yang sedang dipakai.
 *
 * @param {object}  [opts]
 * @param {object}  [opts.socket] socket target (default `sock` saat ini)
 * @param {boolean} [opts.print]  cetak kode ke terminal (default true)
 * @returns {Promise<string|null>} kode pairing, atau null bila gagal
 */
async function requestPairingCode({ socket = null, print = true } = {}) {
  if (!botNumber) {
    console.error('[AUTH] Nomor bot belum tersedia — pairing code tidak bisa dibuat.');
    return null;
  }

  // Jangan tumpang-tindih: permintaan yang masih berjalan akan dibatalkan
  // oleh permintaan baru (menimpa creds.pairingCode).
  if (pairingRequestInFlight) {
    console.log('[AUTH] Permintaan pairing code masih berjalan — tunggu sebentar.');
    return null;
  }
  pairingRequestInFlight = true;

  const target = socket ?? sock;
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      // Socket sudah connect (sesi lama masih valid) -> tidak perlu pairing.
      if (target?.user) return null;

      // 1) TUNGGU WS TERBUKA. Ini pengganti sleep() yang tidak andal.
      const opened = await waitForSocketOpen(target);
      if (sock !== target) {
        console.log('[AUTH] Socket berganti saat menunggu — permintaan kode dibatalkan.');
        return null;
      }
      if (target?.user) return null;
      if (!opened) {
        console.error(`[AUTH] WebSocket belum terbuka (percobaan ${attempt}/5) — ulangi.`);
        if (attempt < 5) await sleep(2000);
        continue;
      }

      // 2) Kirim permintaan pairing.
      const code = await target.requestPairingCode(botNumber);

      // 3) Verifikasi socket masih yang aktif setelah request selesai.
      if (sock !== target) {
        console.log('[AUTH] Koneksi berganti setelah request — minta kode baru...');
        return null;
      }

      pairingState = 'pending';
      if (print) printPairingCode(code, botNumber);
      // Jadwalkan kode baru sebelum kode ini kedaluwarsa.
      schedulePairingCodeRefresh();
      return code;
    }

    console.error('[AUTH] Tidak bisa mendapatkan pairing code setelah 5 percobaan.');
    return null;
  } catch (err) {
    console.error('[AUTH] Gagal minta pairing code:', err.message);
    return null;
  } finally {
    pairingRequestInFlight = false;
  }
}

/**
 * Pasang listener ENTER: minta pairing code BARU tanpa restart bot.
 *
 * Dibatasi hanya aktif saat kode memang sudah kedaluwarsa/tidak terpakai,
 * sehingga tidak sengaja membatalkan kode yang sedang dimasukkan di HP.
 *
 * Hanya dipasang SEKALI. Tanpa guard ini, setiap reconnect akan menambah
 * listener baru sehingga satu ENTER memicu beberapa permintaan kode
 * sekaligus (saling menimpa `creds.pairingCode`).
 */
function attachPairingRetryListener() {
  if (!interactive) return;
  if (pairingState === 'done' || sock?.user) return;
  if (retryListenerAttached) return;
  retryListenerAttached = true;

  const waitForEnter = async () => {
    const answer = await ask('  ⌨️  Kode kedaluwarsa? Tekan ENTER untuk minta kode BARU: ');
    if (answer === null) return; // EOF / terminal ditutup

    if (pairingState === 'done' || sock?.user) {
      console.log('[AUTH] Sesi sudah aktif — ENTER tidak lagi diperlukan.');
      return;
    }

    console.log('\n[AUTH] Meminta pairing code baru...');
    const code = await requestPairingCode();
    if (code) {
      console.log('[AUTH] Gunakan kode BARU di atas (kode lama sudah tidak berlaku).');
    } else {
      console.error('[AUTH] Gagal meminta kode baru.');
    }
    waitForEnter(); // siap menerima ENTER berikutnya
  };

  waitForEnter();
}

/**
 * Deteksi "sesi sampah" (debris session).
 *
 * Sesi yang tidak selesai (registered=false) meninggalkan `creds.json` berisi
 * `creds.me` dan `pairingCode` lama, TAPI tanpa kunci noise/signal yang lengkap.
 * Bila dibiarkan, Baileys mengirim sesi mati ini ke WhatsApp -> server menolak
 * (401/loggedOut) -> lalu setiap kode pairing yang dimasukkan dianggap salah
 * ("pastikan nomor yang anda masukan benar").
 *
 * @param {object} creds isi creds.json
 * @returns {boolean} true bila sesi harus dianggap sampah
 */
function isDebrisSession(creds) {
  if (!creds || typeof creds !== 'object') return false;
  if (creds.registered) return false; // sesi sah (jalur pairing)
  // CATATAN: jalur QR **tidak pernah** mengeset `registered` (Baileys hanya
  // mengesetnya di `link_code_companion_reg`, yaitu jalur pairing code).
  // Karena itu keberadaan `me.id` yang lengkap HARUS dianggap sesi sah,
  // supaya sesi hasil scan QR tidak terhapus setiap kali bot dijalankan.
  const hasIdentity = Boolean(creds.me?.id && creds.account);
  if (hasIdentity) return false;

  // Belum terdaftar dan tanpa identitas lengkap, tetapi menyimpan sisa
  // percobaan pairing -> sesi sampah yang memicu 401 loggedOut.
  return Boolean(creds.pairingCode);
}

/**
 * Deteksi SESI TERCAMPUR (mixed session).
 *
 * Gejala di terminal: `Failed to decrypt message` / `Bad MAC` berulang untuk
 * satu JID, kadang disertai `440 connectionReplaced`.
 *
 * Penyebab: folder sesi berisi file `session-*.json` (kunci Signal per lawan
 * bicara) dari beberapa identitas BERBEDA — sisa dari beberapa kali
 * pairing/QR. Setiap identitas punya pasangan kunci sendiri, sehingga kunci
 * yang tidak cocok membuat dekripsi gagal.
 *
 * Sesi yang sehat hanya punya kunci milik SATU identitas: nomor bot (`me.id`)
 * dan/atau LID-nya (`me.lid`).
 *
 * @param {object} creds isi creds.json
 * @param {string[]} sessionFiles daftar nama file `session-*.json`
 * @returns {{mixed: boolean, identities: string[]}} hasil analisis
 */
function analyzeSessionMixing(creds, sessionFiles) {
  // Identitas sah: nomor bot dan LID-nya (digit awal nama file session).
  const allowed = new Set();
  const meId = creds?.me?.id || '';
  const meLid = creds?.me?.lid || '';
  for (const id of [meId, meLid]) {
    const digits = String(id).split('@')[0].split(':')[0];
    if (digits) allowed.add(digits);
  }

  // Setiap `session-<nomor>.json` harus mengarah ke identitas yang sah.
  const found = new Set();
  for (const f of sessionFiles) {
    const m = /^session-(\d+)[.\d]*\.json$/.exec(f);
    if (m) found.add(m[1]);
  }

  // Bila ada angka yang tidak dikenal -> sesi tercampur.
  const unknown = [...found].filter((n) => !allowed.has(n));

  // `me.lid` bisa kosong pada sesi lama; bila identitas sah tidak diketahui,
  // jangan menghapus sesi hanya karena itu.
  const mixed = allowed.size > 0 && unknown.length > 0;
  return { mixed, identities: unknown };
}

/**
 * Bersihkan sesi sampah sebelum connect, supaya pairing selalu mulai dari nol.
 *
 * HANYA dipanggil saat startup (bootstrap), BUKAN saat reconnect dalam proses:
 * menghapus sesi saat reconnect akan membuang `creds.pairingCode` yang masih
 * berlaku dan membatalkan kode yang sedang dimasukkan pengguna di HP.
 *
 * @returns {Promise<boolean>} true bila ada sesi yang dibersihkan
 */
async function clearDebrisSession() {
  // Sesuai permintaan: jangan hapus isi baileys_auth saat start.
  // Biarkan session yang ada dipakai apa adanya; reconnect hanya bila koneksi gagal.
  return false;
}

/** Membuat koneksi WhatsApp dan memasang seluruh event handler. */
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.resolve(CONFIG.sessionDir));

  // Versi Web di-pin (lihat CONFIG.waVersion). fetchLatestBaileysVersion hanya
  // dipakai sebagai cadangan bila .env memuat WA_VERSION yang tidak valid.
  let version = CONFIG.waVersion;
  let isLatest = false;
  if (version.length !== 3) {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
    isLatest = fetched.isLatest;
  }
  console.log(`[WA] WhatsApp Web v${version.join('.')} (pinned: ${!isLatest})`);

  // Sudah punya sesi tersimpan? Berarti tidak perlu pairing/QR sama sekali.
  // `registered` hanya di-set jalur pairing code, sedangkan jalur QR hanya
  // menyimpan `me.id` + `account` -> keduanya harus dianggap sesi siap pakai.
  const alreadyRegistered =
    Boolean(state.creds?.registered) || Boolean(state.creds?.me?.id && state.creds?.account);

  // Metode sudah ditentukan di bootstrap (hanya untuk sesi baru). Bila karena
  // satu dan lain hal belum ada, ambil dari .env / default.
  if (!connectionMethod) {
    connectionMethod = normalizeMethod(process.env.CONNECTION_METHOD) || 'pairing';
  }
  const usePairing = connectionMethod === 'pairing';
  void usePairing; // dipertahankan untuk keterbacaan alur pairing di bawah

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    // Identitas browser: ikuti neoxr-bot (macOS + Chrome). Bila WA_BROWSER di
    // .env tidak lengkap, jatuh ke default Browsers.macOS('Chrome').
    browser: CONFIG.browser.length === 3
      ? CONFIG.browser
      : Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true,
    // Abaikan JID yang tidak pernah perlu diproses (mengikuti neoxr-bot).
    // Mencegah bot mencoba membalas newsletter/channel & bot lain.
    shouldIgnoreJid: (jid) => /(newsletter|bot)/i.test(String(jid)),
    // QR TIDAK PERNAH dicetak Baileys (selalu false). Kita merender sendiri
    // lewat `connection.update.qr` agar tampilannya seragam & bisa dikontrol.
    printQRInTerminal: false,
  });
  /** Socket milik pemanggilan ini — dipakai untuk mengabaikan event socket lama. */
  const thisSock = sock;

  /** Simpan kredensial setiap kali berubah — WAJIB agar sesi tidak hilang. */
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, isNewLogin, qr } = update;

    // ---------------------------------------------------------------------
    // Abaikan event dari socket LAMA.
    //
    // Setiap reconnect membuat objek socket baru. Socket lama bisa masih
    // memancarkan `close` sesudah diganti; bila tidak diabaikan, event itu
    // memicu reconnect tambahan -> dua socket aktif -> kode pairing saling
    // menimpa dan pendaftaran gagal.
    // ---------------------------------------------------------------------
    if (thisSock !== sock) return;

    // -----------------------------------------------------------------------
    // PAIRING BERHASIL — server minta RESTART socket.
    //
    // Dari sumber Baileys (Socket/socket.js, handler "CB:iq,,pair-success"):
    //   "pairing configured successfully, expect to restart the connection"
    //   ev.emit('connection.update', { isNewLogin: true, qr: undefined })
    //
    // Jadi saat pengguna BERHASIL memasukkan kode di HP, Baileys memancarkan
    // `isNewLogin: true` dan mengharapkan kita menyambung ULANG. Bila event ini
    // diabaikan, sesi tidak pernah selesai terdaftar — dan pengguna melihat
    // "pastikan nomor yang anda masukan benar".
    // -----------------------------------------------------------------------
    if (isNewLogin) {
      console.log('[WA] 🔑 Kode diterima WhatsApp — menyelesaikan pendaftaran sesi...');
      pairingState = 'done';
      if (pairingCodeTimer) {
        clearTimeout(pairingCodeTimer);
        pairingCodeTimer = null;
      }
      if (pairingCountdownTimer) {
        clearInterval(pairingCountdownTimer);
        pairingCountdownTimer = null;
      }
      const old = sock;
      await sleep(1000);
      // Sambung ulang dengan kredensial hasil pairing.
      startWhatsApp()
        .then(() => {
          try {
            old?.end?.();
          } catch {
            /* abaikan */
          }
        })
        .catch((err) => console.error('[WA] Gagal menyelesaikan pairing:', err.message));
      return;
    }

    if (connection === 'connecting') {
      console.log('[WA] Menghubungkan ke WhatsApp...');
    }

    // ---------------------------------------------------------------------
    // QR BARU DARI WHATSAPP (hanya di metode QR).
    //
    // Baileys memancarkan `qr` setiap ±20 detik. QR lama otomatis tidak
    // berlaku; pengguna cukup memindai QR yang paling baru.
    // ---------------------------------------------------------------------
    if (qr) {
      if (connectionMethod === 'qr' && !alreadyRegistered) {
        renderQr(qr);
      }
      return;
    }

    if (connection === 'open') {
      pairingState = 'done';
      reconnecting = false;
      // Reset penghitung bentrok HANYA bila koneksi sebelumnya bertahan lama.
      // Kalau di-reset di setiap `open`, pola open->440->open->440 tidak akan
      // pernah terdeteksi dan bot loop tanpa henti.
      if (lastOpenAt && Date.now() - lastOpenAt >= HEALTHY_UPTIME_MS) {
        consecutive440 = 0;
      }
      lastOpenAt = Date.now();
      lastQr = null;
      // Segarkan nomor bot dari sesi yang benar-benar terhubung (bisa berbeda
      // dari BOT_NUMBER di .env bila pengguna memindai QR dari nomor lain).
      if (sock.user?.id) botNumber = phoneFromJid(sock.user.id);
      setBotState({ status: 'online', phone: botNumber, method: connectionMethod });
      try {
        await fs.writeFile(
          path.resolve(process.env.DATA_DIR || './data', 'bot_status.json'),
          JSON.stringify({ status: 'online', phone: botNumber, method: connectionMethod, updatedAt: new Date().toISOString() }, null, 2),
        );
      } catch { /* ignore */ }
      if (pairingCodeTimer) {
        clearTimeout(pairingCodeTimer);
        pairingCodeTimer = null;
      }
      if (pairingCountdownTimer) {
        clearInterval(pairingCountdownTimer);
        pairingCountdownTimer = null;
      }
      closeRl(); // terminal tidak lagi dibutuhkan untuk pairing/QR
      console.log(`[WA] ✅ Terhubung sebagai ${sock.user?.id}`);
      console.log(
        `[WA] Metode koneksi: ${connectionMethod === 'qr' ? 'QR CODE' : 'PAIRING CODE'}`,
      );
      console.log(`[WA] Bot siap menerima pesan. Prefix perintah: "${CONFIG.prefix}"`);
  console.log(`[WA] Prefix aktif: ${CONFIG.prefixes.map((p) => `"${p}"`).join(', ')}`);
      return;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(`[WA] ❌ Koneksi terputus (code: ${statusCode ?? 'unknown'})`);
      setBotState({ status: 'offline', lastError: `code ${statusCode ?? 'unknown'}` });
      try {
        await fs.writeFile(
          path.resolve(process.env.DATA_DIR || './data', 'bot_status.json'),
          JSON.stringify({ status: 'offline', lastError: `code ${statusCode ?? 'unknown'}`, updatedAt: new Date().toISOString() }, null, 2),
        );
      } catch { /* ignore */ }

      // ---------------------------------------------------------------------
      // 401 = LOGOUT — sesi dicabut WhatsApp dan TIDAK bisa dipulihkan.
      //
      // Reconnect mustahil berhasil; mencoba terus hanya akan menampilkan
      // error berulang. Hentikan proses supaya pengguna sadar perlu pairing
      // ulang, dan agar tidak ada dua proses yang berebut sesi (440).
      // ---------------------------------------------------------------------
      if (loggedOut) {
        console.error('');
        console.error('==================================================');
        console.error('  SESI LOGOUT (401) — sesi dicabut WhatsApp.');
        console.error('==================================================');
        console.error(`  1. Hentikan bot ini.`);
        console.error(`  2. Hapus folder sesi:  rm -rf ${CONFIG.sessionDir}`);
        console.error('  3. Jalankan ulang:     npm start');
        console.error('  4. Lakukan pairing/QR baru (jangan scan dari HP yang sama');
        console.error('     dengan sesi yang masih aktif di tempat lain).');
        console.error('==================================================\n');
        // Jangan hanya exit: matikan socket dulu agar tidak ada event lanjutan.
        try {
          await sock?.end?.();
        } catch {
          /* abaikan */
        }
        process.exit(1);
        return;
      }

      // ---------------------------------------------------------------------
      // 440 = connectionReplaced — kredensial yang sama dipakai di tempat lain.
      //
      // Penyebab tersering: bot dijalankan DUA kali, atau proses lama belum
      // benar-benar mati. Reconnect tanpa henti hanya memperparah (bola salju
      // 440 -> 401). Kita batasi percobaan beruntun, lalu berhenti dengan
      // instruksi jelas.
      // ---------------------------------------------------------------------
      if (statusCode === DisconnectReason.connectionReplaced) {
        consecutive440 += 1;
        console.error(
          `[WA] ⚠️  440 connectionReplaced (${consecutive440}x) — sesi ini dipakai proses/perangkat lain.`,
        );
        if (consecutive440 >= 3) {
          console.error('');
          console.error('==================================================');
          console.error('  SESI BENTROK (440) — berhenti agar tidak makin parah.');
          console.error('==================================================');
          console.error('  Kemungkinan penyebab:');
          console.error('   • Bot dijalankan dua kali (npm start ganda).');
          console.error('   • Proses bot lama masih hidup di terminal lain.');
          console.error('   • WhatsApp Web/Desktop lain memakai akun yang sama.');
          console.error('');
          console.error('  Cara memperbaiki:');
          console.error('   1. Tutup SEMUA proses bot:');
          console.error('        pkill -f "node src/index.js"');
          console.error('   2. Pastikan tidak ada proses tersisa:  ps aux | grep node');
          console.error('   3. Tutup WhatsApp Web/Desktop yang lain (opsional).');
          console.error('   4. Jalankan ulang:  npm start');
          console.error('==================================================\n');
          try {
            await sock?.end?.();
          } catch {
            /* abaikan */
          }
          process.exit(1);
          return;
        }
      }

      // Cegah beberapa event `close` beruntun memicu beberapa reconnect
      // sekaligus. Reconnect beruntun akan menimpa `creds.pairingCode`.
      if (reconnecting) {
        console.log('[WA] Reconnect sudah dijadwalkan — abaikan event close ini.');
        return;
      }
      reconnecting = true;

      // Socket harus hidup agar pengguna bisa memasukkan kode / memindai QR.
      // Bila socket tertutup (mis. 428 karena rasio handshake), sambung ulang
      // supaya WhatsApp bisa menyelesaikan registrasi.
      if (pairingState === 'pending') {
        console.log(
          connectionMethod === 'qr'
            ? '[AUTH] Socket tertutup saat menunggu QR — menyambung ulang...'
            : '[AUTH] Socket tertutup saat pairing — menyambung ulang agar kode tetap bisa dipakai...',
        );
      }

      // Jeda makin panjang bila 440 berulang, agar tidak membombardir server.
      const delay = consecutive440 > 0 ? reconnectDelayFor440() : 3000;
      console.log(`[WA] Reconnect dalam ${Math.round(delay / 1000)} detik...`);
      await sleep(delay);
      startWhatsApp()
        .catch((err) => console.error('[WA] Reconnect gagal:', err.message))
        .finally(() => {
          reconnecting = false;
        });
    }
  });

  // ==== LISTENER PESAN MASUK ====
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // hanya pesan baru (bukan histori sync)
    for (const msg of messages) {
      try {
        await processIncomingMessage(msg);
      } catch (err) {
        console.error('[MSG] Error memproses pesan:', err?.stack || err?.message);
      }
    }
  });

  // Ubah status ke 'pending' di QR mode supaya logika reconnect tahu bahwa
  // kita masih menunggu pengguna memindai (bukan sesi terdaftar).
  if (!alreadyRegistered && connectionMethod === 'qr') {
    pairingState = 'pending';
  }

  // ==== PAIRING CODE ====
  // Hanya jalan di metode PAIRING dan bila belum pernah terdaftar
  // (sesi lama -> langsung connect).
  //
  // PENTING: jangan panggil pairing ulang bila kode SUDAH TAMPIL dan belum
  // kedaluwarsa. Meminta kode baru akan menimpa `creds.pairingCode` dan
  // membatalkan kode yang sedang pengguna ketik di HP — inilah yang memicu
  // notifikasi "pastikan nomor yang anda masukan benar" di WhatsApp.
  //
  // CATATAN: `pairingState` TIDAK di-set 'pending' di sini. Status itu di-set
  // di dalam requestPairingCode() HANYA setelah kode benar-benar diperoleh.
  if (alreadyRegistered) {
    console.log('[AUTH] Sesi tersimpan valid — pairing/QR tidak diperlukan.');
  } else if (connectionMethod === 'qr') {
    console.log('[AUTH] Metode QR: menunggu QR dari WhatsApp...');
    console.log('[AUTH] (QR akan tampil otomatis di terminal sebentar lagi)');
  } else if (pairingState === 'pending') {
    // ---------------------------------------------------------------------
    // Socket baru hasil reconnect, dan kode lama SUDAH TIDAK BERLAKU.
    //
    // Kode pairing WhatsApp hanya valid ~60 detik dan terikat pada sesi
    // socket. Menampilkan ulang kode lama (seperti versi sebelumnya) membuat
    // pengguna memasukkan kode yang sudah kedaluwarsa -> WhatsApp menampilkan
    // "Gagal menautkan perangkat, dapatkan kode baru".
    //
    // Jadi: minta kode BARU, jangan pernah mencetak ulang kode lama.
    // ---------------------------------------------------------------------
    if (pairingRequestInFlight) return sock;
    console.log('[AUTH] Kode lama tidak berlaku lagi — membuat kode pairing BARU...');
    pairingState = false;
    const currentSocket = sock;
    requestPairingCode({ socket: currentSocket })
      .then((code) => {
        if (code) attachPairingRetryListener();
      })
      .catch((err) => console.error('[AUTH] Gagal membuat kode baru:', err.message));
  } else if (!alreadyRegistered) {
    // Percobaan pertama: minta pairing code.
    const currentSocket = sock;
    // Jangan await: event listener di atas harus tetap hidup.
    requestPairingCode({ socket: currentSocket })
      .then((code) => {
        if (code) {
          attachPairingRetryListener();
          return;
        }
        // Gagal mendapatkan kode pada socket ini. Jangan biarkan bot diam:
        // jadwalkan percobaan ulang selama belum terdaftar & belum dapat kode.
        if (sock === currentSocket && !sock?.user && pairingState !== 'pending') {
          console.log('[AUTH] Percobaan ulang pairing code dalam 5 detik...');
          setTimeout(() => {
            if (!sock?.user && pairingState !== 'pending' && !pairingRequestInFlight) {
              startWhatsApp().catch((err) =>
                console.error('[AUTH] Retry pairing gagal:', err.message),
              );
            }
          }, 5000);
        }
      })
      .catch((err) => {
        console.error('[AUTH]', err.message);
      });
  }

  return sock;
}

/* ==========================================================================
 *  BOOTSTRAP
 * ========================================================================== */

async function bootstrap() {
  console.log('\n🚀 WhatsApp Bot Pencatat Keuangan — starting...');
  console.log('   Metode koneksi: dipilih di terminal (Pairing Code / QR Code)\n');

  // 1. Validasi .env penting
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.includes('XXXX')) {
    console.warn('⚠️  GEMINI_API_KEY belum diisi — parsing AI tidak akan berfungsi.');
  }

  // 2. Pastikan struktur folder & file JSON utama sudah ada
  for (const dir of [CONFIG.dataDir, CONFIG.sessionDir, process.env.BACKUP_DIR || './backups']) {
    await fs.mkdir(path.resolve(dir), { recursive: true });
  }
  for (const collection of COLLECTIONS) {
    const file = path.resolve(CONFIG.dataDir, `${collection}.json`);
    try {
      await fs.access(file);
    } catch {
      await writeCollection(collection, []); // buat [] agar file selalu ada
    }
  }
  console.log(`[DB] Data dir siap: ${path.resolve(CONFIG.dataDir)}`);

  // 3. Jadwalkan cronjob
  startCronJobs();

  // 3b. Kunci sesi (multi-session safety): cegah dua proses bot memakai
  //     folder auth yang sama -> tabrakan (440 connectionReplaced).
  //     Untuk multi-session, jalankan instance terpisah dengan SESSION_DIR
  //     berbeda (mis. ./baileys_auth_2) agar tidak saling menimpa.
  const sessionLockPath = path.join(path.resolve(CONFIG.sessionDir), '.bot.lock');
  try {
    let stale = false;
    try {
      const raw = await fs.readFile(sessionLockPath, 'utf8');
      const pid = parseInt(raw.trim(), 10);
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0); // cek hidup
          console.error(
            `\\n[APP] Sesi sedang dipakai proses lain (PID ${pid}).\\n` +
              `      Hentikan proses tersebut atau gunakan SESSION_DIR berbeda untuk multi-session.\\n`,
          );
          process.exit(1);
        } catch {
          stale = true; // proses mati -> lock basi
        }
      }
    } catch {
      /* lock belum ada */
    }
    if (stale) await fs.rm(sessionLockPath, { force: true }).catch(() => {});
    await fs.writeFile(sessionLockPath, String(process.pid), 'utf8');
    const releaseLock = async () => {
      try {
        await fs.rm(sessionLockPath, { force: true });
      } catch {
        /* abaikan */
      }
    };
    process.on('exit', () => {
      try {
        rmSync(sessionLockPath, { force: true });
      } catch {
        /* abaikan */
      }
    });
    process.on('SIGINT', async () => {
      await releaseLock();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await releaseLock();
      process.exit(0);
    });
  } catch (err) {
    console.warn('[AUTH] Gagal membuat lock sesi:', err?.message || err);
  }

  // 4. Bersihkan sesi sampah (percobaan pairing yang gagal) sebelum apapun.
  //    Ini mencegah WhatsApp menolak sesi mati dengan 401/loggedOut, yang
  //    membuat kode pairing selalu dianggap salah.
  await clearDebrisSession();

  // 5. Tentukan metode koneksi SEBELUM apa pun dikoneksikan.
  //    Pada sesi baru, pengguna memilih: 1 = Pairing Code, 2 = QR Code.
  //    Sesi tersimpan -> langsung connect, metode tidak ditanyakan.
  const { state: existingSession } = await useMultiFileAuthState(
    path.resolve(CONFIG.sessionDir),
  );
  const hasSession =
    Boolean(existingSession.creds?.registered) ||
    Boolean(existingSession.creds?.me?.id && existingSession.creds?.account);

  // 6. Kumpulkan nomor + metode.
  if (hasSession) {
    console.log('[AUTH] Sesi tersimpan ditemukan — langsung connect, pairing/QR tidak diperlukan.');
    botNumber = normalizePhoneNumber(process.env.BOT_NUMBER) || '';
    connectionMethod = normalizeMethod(process.env.CONNECTION_METHOD) || 'pairing';
  } else {
    // Nomor hanya perlu untuk metode PAIRING. Untuk QR, nomor tidak dipakai
    // sama sekali (identitas didapat dari hasil pindai), tetapi kita tetap
    // menampilkannya bila tersedia agar pengguna yakin HP yang benar.
    connectionMethod = await resolveConnectionMethod('connect');

    botNumber = await resolveBotNumber();

    // Pairing code WAJIB punya nomor valid; QR boleh tanpa nomor.
    if (!botNumber && connectionMethod === 'pairing') {
      console.error(
        '\n[APP] Metode PAIRING CODE memerlukan nomor bot yang valid.\n' +
          '      Isi BOT_NUMBER di .env, jalankan ulang, atau pilih metode QR (2).',
      );
      process.exit(1);
    }
    if (!botNumber) {
      console.log('[AUTH] Metode QR: nomor bot tidak wajib — memakai hasil pindai.');
    }
  }
  CONFIG.botNumber = botNumber;
  CONFIG.connectionMethod = connectionMethod;

  // 7a. Web dashboard (aktif by default; nonaktifkan dengan WEB_ENABLED=false)
  if (process.env.WEB_ENABLED !== 'false') {
    try {
      await startWebServer(Number(process.env.WEB_PORT || 3000));
    } catch (e) {
      console.error('[WEB] Gagal menjalankan dashboard:', e?.message);
    }
  }

  // 7. Koneksi WhatsApp (pairing code ATAU QR, sesuai pilihan di atas)
  await startWhatsApp();

  // 6. Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[APP] Menerima ${signal}, menutup bot...`);
    closeRl();
    try {
      await sock?.end?.();
    } catch {
      /* abaikan */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Jangan biarkan error tak tertangkap mematikan bot
  process.on('unhandledRejection', (reason) =>
    console.error('[APP] Unhandled rejection:', reason?.message || reason),
  );
  process.on('uncaughtException', (err) =>
    console.error('[APP] Uncaught exception:', err?.stack || err?.message),
  );
}

bootstrap().catch((err) => {
  console.error('[APP] Gagal start:', err?.stack || err?.message);
  process.exit(1);
});
