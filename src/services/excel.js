/**
 * ==========================================================================
 *  src/services/excel.js
 *  Konversi data JSON (transactions.json + wallets.json + budgets.json)
 *  menjadi file spreadsheet `.xlsx` rapi memakai ExcelJS.
 *
 *  Isi workbook:
 *    1. "Transaksi"  -> kolom: Tanggal | Jam | Tipe | Kategori | Wallet |
 *                       Deskripsi | Jumlah  (+ warna, auto-filter, total)
 *    2. "Ringkasan"  -> saldo awal / pemasukan / pengeluaran / saldo akhir
 *                       per wallet + total keseluruhan
 *    3. "Budget"     -> (opsional) limit vs realisasi per kategori
 * ==========================================================================
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { computeWalletBalances } from '../config/database.js';

/** Format Rupiah ala Indonesia: Rp 1.250.000 */
const MONEY_FMT = '"Rp" #,##0';
const DATE_FMT = 'dd/mm/yyyy';

/**
 * Ambil komponen tanggal pada zona waktu bot (default Asia/Jakarta) sebagai
 * objek Date "polos" tanpa jam. Ini mencegah tanggal bergeser sehari karena
 * konversi timezone server (mis. transaksi 05:00 WIB = 22:00 UTC hari sebelumnya).
 */
function toLocalDateParts(isoString) {
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) return null;

  const tz = process.env.TIMEZONE || 'Asia/Jakarta';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);

  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(get('year'), get('month') - 1, get('day'));
}

/**
 * Jam transaksi pada zona waktu bot -> "HH:MM".
 * Contoh: transaksi pukul 10:00 WIB -> "10:00".
 * @param {string} isoString
 * @returns {string} "HH:MM" atau '-' bila tidak valid
 */
function toLocalClock(isoString) {
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) return '-';

  const tz = process.env.TIMEZONE || 'Asia/Jakarta';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(parsed);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('hour').padStart(2, '0')}:${get('minute').padStart(2, '0')}`;
}

/** Palet warna profesional. */
const C = {
  headerBg: 'FF1F4E79', // biru tua
  headerFg: 'FFFFFFFF', // putih
  bandBg: 'FFF2F6FB', // zebra baris
  totalBg: 'FFE8EEF7', // ringkasan
  border: 'FFD0D7E2',
  income: 'FF1B7F3B', // hijau
  expense: 'FFC62828', // merah
  text: 'FF1F2937',
};

const THIN = ['thin', { color: C.border }];

/** Styling standar untuk baris header. */
function styleHeader(row) {
  row.height = 22;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: C.headerFg }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  });
}

/** Styling sel biasa (border + zebra). */
function styleCell(cell, { banded = false } = {}) {
  cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  cell.alignment = { vertical: 'middle' };
  if (banded) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.bandBg } };
  }
}

/* -------------------------------------------------------------------------
 *  SHEET 1 — Daftar Transaksi
 * ---------------------------------------------------------------------- */
function buildTransactionSheet(workbook, transactions) {
  const ws = workbook.addWorksheet('Transaksi', {
    views: [{ state: 'frozen', ySplit: 1 }], // header selalu terlihat
    properties: { tabColor: { argb: C.headerBg } },
  });

  ws.columns = [
    { header: 'Tanggal', key: 'date', width: 14 },
    { header: 'Jam', key: 'time', width: 9 },
    { header: 'Tipe', key: 'type', width: 13 },
    { header: 'Kategori', key: 'category', width: 22 },
    { header: 'Wallet', key: 'wallet', width: 12 },
    { header: 'Deskripsi', key: 'description', width: 46 },
    { header: 'Jumlah', key: 'amount', width: 18 },
  ];
  styleHeader(ws.getRow(1));

  // Urutkan berdasarkan waktu input transaksi: yang terbaru dulu
  // (jam terbaru -> tanggal terbaru).
  const sorted = [...transactions].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  sorted.forEach((t, index) => {
    const isIncome = t.type === 'income';
    const row = ws.addRow({
      // Tanggal tanpa jam pada zona waktu bot agar tidak bergeser sehari.
      date: toLocalDateParts(t.date) ?? '-',
      // Jam transaksi pada zona waktu bot ("10:00").
      time: toLocalClock(t.date),
      type: isIncome ? 'Pemasukan' : 'Pengeluaran',
      category: t.category || 'Lainnya',
      wallet: t.wallet || 'Cash',
      description: t.description || '-',
      amount: Math.abs(Number(t.amount) || 0),
    });

    const banded = index % 2 === 1; // zebra biar enak dibaca
    row.eachCell((cell) => styleCell(cell, { banded }));

    const dateCell = row.getCell('date');
    dateCell.numFmt = DATE_FMT;
    dateCell.alignment = { horizontal: 'center', vertical: 'middle' };

    const typeCell = row.getCell('type');
    typeCell.alignment = { horizontal: 'center', vertical: 'middle' };
    typeCell.font = { bold: true, color: { argb: isIncome ? C.income : C.expense } };

    const timeCell = row.getCell('time');
    timeCell.alignment = { horizontal: 'center', vertical: 'middle' };

    const amountCell = row.getCell('amount');
    amountCell.numFmt = MONEY_FMT;
    amountCell.alignment = { horizontal: 'right', vertical: 'middle' };
    amountCell.font = { bold: true, color: { argb: isIncome ? C.income : C.expense } };
  });

  // Auto-filter pada header (Excel: dropdown penyaring)
  ws.autoFilter = 'A1:G1';

  // Baris total (formula SUMIF agar ikut terhitung bila baris ditambah manual)
  if (sorted.length) {
    ws.addRow({});
    const totalRows = [
      { label: 'TOTAL PEMASUKAN', formula: 'SUMIF(C:C,"Pemasukan",G:G)', color: C.income },
      { label: 'TOTAL PENGELUARAN', formula: 'SUMIF(C:C,"Pengeluaran",G:G)', color: C.expense },
    ];
    for (const t of totalRows) {
      const row = ws.addRow({ description: t.label });
      row.getCell('amount').value = { formula: t.formula };
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.totalBg } };
        cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
        cell.font = { bold: true, color: { argb: t.color } };
      });
      row.getCell('amount').numFmt = MONEY_FMT;
      row.getCell('amount').alignment = { horizontal: 'right' };
    }
  }

  return ws;
}

/* -------------------------------------------------------------------------
 *  SHEET 2 — Ringkasan per Wallet
 * ---------------------------------------------------------------------- */
function buildSummarySheet(workbook, { wallets, transactions }) {
  const ws = workbook.addWorksheet('Ringkasan', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { tabColor: { argb: 'FF1B7F3B' } },
  });

  ws.columns = [
    { header: 'Wallet', key: 'wallet', width: 18 },
    { header: 'Saldo Awal', key: 'initial', width: 17 },
    { header: 'Pemasukan', key: 'income', width: 17 },
    { header: 'Pengeluaran', key: 'expense', width: 17 },
    { header: 'Saldo Akhir', key: 'balance', width: 17 },
  ];
  styleHeader(ws.getRow(1));

  const balances = computeWalletBalances(wallets, transactions);
  let totalInitial = 0;
  let totalIncome = 0;
  let totalExpense = 0;
  let totalBalance = 0;

  balances.forEach((w, index) => {
    const row = ws.addRow({
      wallet: w.name,
      initial: w.initial_balance,
      income: w.income,
      expense: w.expense,
      balance: w.balance,
    });
    const banded = index % 2 === 1;
    row.eachCell((cell) => styleCell(cell, { banded }));

    ['initial', 'income', 'expense', 'balance'].forEach((key) => {
      const cell = row.getCell(key);
      cell.numFmt = MONEY_FMT;
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
    });

    row.getCell('income').font = { color: { argb: C.income } };
    row.getCell('expense').font = { color: { argb: C.expense } };
    row.getCell('balance').font = { bold: true, color: { argb: C.text } };

    totalInitial += w.initial_balance;
    totalIncome += w.income;
    totalExpense += w.expense;
    totalBalance += w.balance;
  });

  // Baris TOTAL
  const totalRow = ws.addRow({
    wallet: 'TOTAL',
    initial: totalInitial,
    income: totalIncome,
    expense: totalExpense,
    balance: totalBalance,
  });
  totalRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.totalBg } };
    cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
    cell.font = { bold: true };
  });
  ['initial', 'income', 'expense', 'balance'].forEach((key) => {
    const cell = totalRow.getCell(key);
    cell.numFmt = MONEY_FMT;
    cell.alignment = { horizontal: 'right' };
  });

  return ws;
}

/* -------------------------------------------------------------------------
 *  SHEET 3 — Budget bulanan (opsional, hanya bila ada data budget)
 * ---------------------------------------------------------------------- */
function buildBudgetSheet(workbook, budgets, transactions) {
  const ws = workbook.addWorksheet('Budget', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { tabColor: { argb: 'FFB45309' } },
  });

  ws.columns = [
    { header: 'Kategori', key: 'category', width: 24 },
    { header: 'Limit Bulanan', key: 'limit', width: 18 },
    { header: 'Terpakai', key: 'used', width: 18 },
    { header: 'Sisa', key: 'remaining', width: 18 },
    { header: 'Pemakaian', key: 'percent', width: 14 },
  ];
  styleHeader(ws.getRow(1));

  // Total pengeluaran per kategori dari data transaksi
  const usedByCategory = {};
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    const key = t.category || 'Lainnya';
    usedByCategory[key] = (usedByCategory[key] || 0) + t.amount;
  }

  budgets.forEach((b, index) => {
    const used = usedByCategory[b.category] || 0;
    const limit = Number(b.limit) || 0;
    const percent = limit > 0 ? used / limit : 0;

    const row = ws.addRow({
      category: b.category,
      limit,
      used,
      remaining: limit - used,
      percent,
    });
    const banded = index % 2 === 1;
    row.eachCell((cell) => styleCell(cell, { banded }));

    ['limit', 'used', 'remaining'].forEach((key) => {
      const cell = row.getCell(key);
      cell.numFmt = MONEY_FMT;
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
    });

    const pctCell = row.getCell('percent');
    pctCell.numFmt = '0%';
    pctCell.alignment = { horizontal: 'center', vertical: 'middle' };
    pctCell.font = { bold: true, color: { argb: percent >= 1 ? C.expense : C.income } };
    row.getCell('remaining').font = {
      color: { argb: limit - used < 0 ? C.expense : C.text },
    };
  });

  return ws;
}

/* -------------------------------------------------------------------------
 *  API utama
 * ---------------------------------------------------------------------- */

/**
 * Membuat file `.xlsx` dari data user.
 *
 * @param {object}   params
 * @param {string}   params.filePath      lokasi file tujuan (*.xlsx)
 * @param {object}   params.user          record user (opsional, untuk meta)
 * @param {Array}    params.transactions  daftar transaksi user
 * @param {Array}    params.wallets       daftar wallet user
 * @param {Array}    [params.budgets]     daftar budget user
 * @returns {Promise<string>} filePath hasil
 */
export async function createExcelReport({
  filePath,
  user = null,
  transactions = [],
  wallets = [],
  budgets = [],
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WhatsApp Bot Pencatat Keuangan';
  workbook.lastModifiedBy = 'WhatsApp Bot Pencatat Keuangan';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.properties = { ...(workbook.properties || {}), title: 'Backup Keuangan' };

  buildTransactionSheet(workbook, transactions);
  buildSummarySheet(workbook, { wallets, transactions });
  if (budgets.length) buildBudgetSheet(workbook, budgets, transactions);

  // Metadata dokumen (terlihat di detail file Excel)
  workbook.eachSheet((sheet) => {
    sheet.pageSetup = { orientation: 'landscape', fitToPage: true };
  });
  if (user?.name) {
    workbook.subject = `Keuangan ${user.name}`;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}
