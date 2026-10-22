/**
 * ==========================================================================
 *  src/services/backup.js
 *  Logika PEMBUAT & PENGIRIM file backup Excel via WhatsApp.
 *
 *  Alur:
 *    1. baca users / transactions / wallets / budgets dari JSON lokal
 *    2. konversi menjadi .xlsx rapi (src/services/excel.js)
 *    3. kirim sebagai DOKUMEN lampiran lewat Baileys:
 *         sock.sendMessage(jid, {
 *           document : fs.readFileSync(path),
 *           mimetype : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 *           fileName : 'Backup_Keuangan.xlsx'
 *         })
 *    4. bersihkan file sementara + prune file backup lama (cron harian)
 *
 *  Dipakai oleh:
 *    - command chat `!backup` / intent AI "get_backup"  (manual)
 *    - cronjob mingguan & bulanan                        (otomatis)
 * ==========================================================================
 */

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { createExcelReport } from './excel.js';
import {
  formatMonthLabel,
  formatRupiah,
  getBudgets,
  getStats,
  getUser,
  getWallets,
  listTransactions,
} from '../config/database.js';

/** MIME resmi file Office Open XML (Excel). */
export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** MIME resmi file PDF. */
export const PDF_MIME = 'application/pdf';
export const JSON_MIME = 'application/json';

export function getBackupDir() {
  return path.resolve(process.env.BACKUP_DIR || './backups');
}

/** Timestamp aman untuk nama file (tanpa karakter ilegal). */
function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}

/**
 * Membuat file backup .xlsx untuk satu user.
 *
 * @param {string} phone  nomor user (primary key)
 * @param {{month?:string|null}} [options]
 *        month: 'YYYY-MM' -> hanya transaksi bulan itu.
 *               null      -> semua transaksi (default).
 * @returns {Promise<{filePath:string, fileName:string, rowCount:number}>}
 */
export async function createBackupFile(phone, { month = null } = {}) {
  const [user, transactions, wallets, budgets] = await Promise.all([
    getUser(phone),
    listTransactions(phone, { month }),
    getWallets(phone),
    getBudgets(phone),
  ]);

  // Nama file unik per user + per periode + per waktu generate
  const scope = month ? month.replace('-', '') : 'semua';
  const fileName = `Backup_Keuangan_${String(phone).replace(/\D/g, '')}_${scope}_${fileStamp()}.xlsx`;
  const filePath = path.join(getBackupDir(), fileName);

  await createExcelReport({ filePath, user, transactions, wallets, budgets });

  return { filePath, fileName, rowCount: transactions.length };
}

/**
 * Membuat file backup .pdf untuk satu user.
 *
 * @param {string} phone
 * @param {{month?:string|null}} [options]
 * @returns {Promise<{filePath:string, fileName:string, rowCount:number}>}
 */
export async function createBackupPdfFile(phone, { month = null } = {}) {
  const [user, transactions, wallets] = await Promise.all([
    getUser(phone),
    listTransactions(phone, { month }),
    getWallets(phone),
  ]);

  const scope = month ? month.replace('-', '') : 'semua';
  const fileName = `Backup_Keuangan_${String(phone).replace(/\\D/g, '')}_${scope}_${fileStamp()}.pdf`;
  const filePath = path.join(getBackupDir(), fileName);

  const stats = await getStats(phone, month);
  const tz = process.env.TIMEZONE || 'Asia/Jakarta';
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const stream = createWriteStream(filePath);
  doc.pipe(stream);

  doc.fontSize(18).font('Helvetica-Bold').text('Backup Keuangan', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica');
  doc.text(`Pengguna : ${user?.name || phone} (${phone})`);
  doc.text(`Periode  : ${month ? formatMonthLabel(month) : 'Semua data'}`);
  doc.text(`Jumlah transaksi : ${transactions.length}`);
  doc.text(`Pemasukan : ${formatRupiah(stats.income)}   |   Pengeluaran : ${formatRupiah(stats.expense)}   |   Selisih : ${formatRupiah(stats.net)}`);
  doc.moveDown();

  doc.fontSize(12).font('Helvetica-Bold').text('Saldo Wallet');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica');
  if (wallets?.length) {
    for (const w of wallets) {
      doc.text(`- ${w.name}: ${formatRupiah(w.balance)}`);
    }
  } else {
    doc.text('Belum ada wallet.');
  }
  doc.moveDown();

  doc.fontSize(12).font('Helvetica-Bold').text('Daftar Transaksi');
  doc.moveDown(0.3);

  const headers = ['Tanggal', 'Jam', 'Tipe', 'Kategori', 'Wallet', 'Jumlah'];
  const xs = [40, 110, 175, 260, 330, 410];
  let y = doc.y;
  doc.fontSize(9).font('Helvetica-Bold');
  headers.forEach((h, i) => doc.text(h, xs[i], y, { width: 65 }));
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(9);

  for (const t of transactions) {
    if (doc.y > 740) {
      doc.addPage();
      doc.fontSize(9).font('Helvetica');
    }
    const d = new Date(t.date);
    const dateStr = Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('id-ID', { timeZone: tz });
    const timeStr = Number.isNaN(d.getTime()) ? '-' : d.toLocaleTimeString('id-ID', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const vals = [dateStr, timeStr, t.type || '-', t.category || '-', t.wallet || '-', formatRupiah(t.amount)];
    const yy = doc.y;
    vals.forEach((v, i) => doc.text(String(v).slice(0, 22), xs[i], yy, { width: i === 5 ? 120 : 65 }));
    doc.moveDown(0.35);
  }

  if (!transactions.length) {
    doc.text('Tidak ada transaksi pada periode ini.');
  }

  doc.moveDown();
  doc.fontSize(8).fillColor('gray').text('by: ampang dev', { align: 'center' });

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { filePath, fileName, rowCount: transactions.length };
}

/**
 * Membuat file backup lalu MENGIRIMKANNYA ke WhatsApp pengguna
 * sebagai dokumen lampiran (.xlsx / .pdf).
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} jid     JID tujuan, mis. '62812...@s.whatsapp.net'
 * @param {string} phone   nomor user (primary key di JSON)
 * @param {{month?:string|null, quoted?:object|null, keepFile?:boolean}} [options]
 * @returns {Promise<{fileName:string, rowCount:number}>}
 */
export async function createBackupJsonFile(phone, { month = null } = {}) {
  const [user, transactions, wallets, budgets] = await Promise.all([
    getUser(phone),
    listTransactions(phone, { month }),
    getWallets(phone),
    getBudgets(phone),
  ]);
  const scope = month ? month.replace('-', '') : 'semua';
  const fileName = `Backup_Keuangan_${String(phone).replace(/\\D/g, '')}_${scope}_${fileStamp()}.json`;
  const filePath = path.join(getBackupDir(), fileName);
  const payload = {
    meta: { phone, exported_at: new Date().toISOString(), period: month || 'all' },
    user,
    transactions,
    wallets,
    budgets,
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return { filePath, fileName, rowCount: transactions.length };
}

export async function sendBackup(sock, jid, phone, { month = null, format = 'xlsx', quoted = null, keepFile = false } = {}) {
  if (!sock?.user) throw new Error('Koneksi WhatsApp belum siap');

  const fmt = String(format || 'xlsx').toLowerCase();
  const isPdf = fmt === 'pdf';
  const isJson = fmt === 'json';
  const { filePath, fileName, rowCount } = isJson
    ? await createBackupJsonFile(phone, { month })
    : isPdf
      ? await createBackupPdfFile(phone, { month })
      : await createBackupFile(phone, { month });

  try {
    // Statistik ringkas untuk caption lampiran
    const stats = await getStats(phone, month);
    const { formatRupiah, formatMonthLabel } = await import('../config/database.js');
    const caption = [
      '📊 *BACKUP KEUANGAN*',
      `🗓 Periode: *${month ? formatMonthLabel(month) : 'Semua data'}*`,
      `📦 Jumlah transaksi: *${rowCount}*`,
      `💚 Total pemasukan: *${formatRupiah(stats.income)}*`,
      `🧡 Total pengeluaran: *${formatRupiah(stats.expense)}*`,
      '',
      isJson
        ? '_Format: JSON (data mentah untuk restore)_'
        : isPdf
          ? '_Format: PDF (ringkasan + daftar transaksi)_'
          : '_Sheet: Transaksi • Ringkasan • Budget_',
      '',
      'by: ampang dev',
    ].join('\n');

    // ==== Pengiriman lampiran dokumen Excel via Baileys ====
    const buffer = await fs.readFile(filePath);
    await sock.sendMessage(
      jid,
      {
        document: buffer,
        mimetype: isJson ? JSON_MIME : isPdf ? PDF_MIME : XLSX_MIME,
        fileName,
        caption: caption.replace('BACKUP KEUANGAN', isJson ? 'BACKUP KEUANGAN (JSON)' : isPdf ? 'BACKUP KEUANGAN (PDF)' : 'BACKUP KEUANGAN (EXCEL)'),
      },
      quoted ? { quoted } : {},
    );

    console.log(`[BACKUP] Terkirim -> ${jid} (${fileName}, ${rowCount} baris)`);
    return { fileName, rowCount };
  } finally {
    // Rapikan folder backup agar tidak menumpuk.
    // (set KEEP_BACKUP_FILE=true di .env bila ingin menyimpannya)
    const shouldKeep = keepFile || process.env.KEEP_BACKUP_FILE === 'true';
    if (!shouldKeep) await fs.unlink(filePath).catch(() => {});
  }
}

/**
 * Hapus file backup yang lebih tua dari N hari.
 * Dipanggil cronjob harian (default 7 hari, atur via BACKUP_MAX_AGE_DAYS).
 *
 * @param {number} [maxAgeDays]
 * @returns {Promise<number>} jumlah file yang dihapus
 */
export async function pruneOldBackups(maxAgeDays = Number(process.env.BACKUP_MAX_AGE_DAYS || 7)) {
  try {
    const dir = getBackupDir();
    const files = await fs.readdir(dir);
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const name of files) {
      if (!name.endsWith('.xlsx')) continue;
      const full = path.join(dir, name);
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(full);
        removed += 1;
      }
    }

    if (removed) console.log(`[BACKUP] Prune: ${removed} file lama dihapus`);
    return removed;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[BACKUP] Prune gagal:', err.message);
    return 0;
  }
}
