/**
 * ==========================================================================
 *  src/services/receipt.js
 *  LOGIKA PEMBACA STRUK BELANJA (dipisah dari index.js agar bisa diuji)
 *
 *  Tanggung modul ini:
 *    - memetakan metode pembayaran pada struk -> nama wallet
 *    - merangkai deskripsi transaksi dari nama toko + item
 *    - menyusun data transaksi siap simpan (1 transaksi per struk)
 *
 *  PEMBACAAN GAMBARNYA sendiri ada di src/services/gemini.js
 *  (parseReceiptImage -> vision model -> data struk terstruktur).
 * ==========================================================================
 */

import {
  getTimezone,
  normalizeDate,
  normalizeTime,
  todayInZone,
  zonedToUtc,
} from '../utils/datetime.js';

/**
 * Kata kunci metode pembayaran -> nama wallet.
 * Cocok untuk "DEBIT BCA", "QRIS BCA", "TUNDAI", "GOPAY", dll.
 * @param {string} text
 * @returns {string} nama wallet
 */
export function mapPaymentToWallet(text = '') {
  const s = String(text).toUpperCase();
  const rules = [
    [/QRIS|QR\s?CODE/, 'QRIS'],
    [/SHOPEE/, 'ShopeePay'],
    [/GOPAY/, 'GoPay'],
    [/\bOVO\b/, 'OVO'],
    [/\bDANA\b/, 'DANA'],
    [/\bBCA\b/, 'BCA'],
    [/\bMANDIRI\b/, 'MANDIRI'],
    [/\bBRI\b/, 'BRI'],
    [/\bBNI\b/, 'BNI'],
    [/TUNDAI|CASH/, 'Cash'],
  ];
  for (const [re, wallet] of rules) {
    if (re.test(s)) return wallet;
  }
  return 'Cash';
}

/**
 * Ringkasan item struk: "Indomie Goreng (2), Telur (1)".
 * @param {Array<{name:string,qty:number}>} items
 * @param {number} [max] berapa item yang ditampilkan
 * @returns {string}
 */
export function buildItemSummary(items = [], max = 5) {
  const list = (items || []).slice(0, max).map((it) => {
    const qty = it.qty && it.qty > 1 ? ` (${it.qty})` : '';
    return `${it.name}${qty}`;
  });
  const more = (items || []).length > max ? `, +${items.length - max} item lain` : '';
  return list.join(', ') + more;
}

/**
 * Susun data transaksi dari hasil pembacaan struk.
 * Satu struk = SATU transaksi expense dengan nominal TOTAL struk
 * (paling aman: nominal selalu sama dengan yang tertulis di struk).
 *
 * Tanggal + jam diambil dari struk ("18/10/2026 19:32") dan dikonversi ke
 * timestamp UTC memakai zona waktu bot.
 *
 * @param {object} receipt hasil parseReceiptImage
 * @param {{caption?:string, timezone?:string}} [opts] caption user + zona waktu
 * @returns {{
 *   type:'expense', amount:number, category:string, wallet:string,
 *   description:string, date:string, items:Array
 * }}
 */
export function buildReceiptTransaction(receipt, { caption = '', timezone } = {}) {
  const tz = timezone || getTimezone();

  // Wallet: dari caption user kalau disebut (mis. "pakai BCA"),
  // kalau tidak -> dari metode pembayaran di struk.
  const fromCaption = mapPaymentToWallet(caption);
  const wallet = fromCaption !== 'Cash' ? fromCaption : mapPaymentToWallet(receipt.payment_method);

  const itemSummary = buildItemSummary(receipt.items);
  const description = [receipt.store, itemSummary].filter(Boolean).join(' — ').slice(0, 160);

  // Tanggal/jam struk -> ISO UTC.
  // Tanpa jam -> 00:00 pada tanggal itu. Tanpa tanggal -> waktu sekarang.
  let date = new Date();
  const strukDate = normalizeDate(receipt.date);
  const strukTime = normalizeTime(receipt.time);

  if (strukDate) {
    const parsed = zonedToUtc(strukDate, strukTime, tz);
    if (parsed) date = parsed;
  } else if (strukTime) {
    const parsed = zonedToUtc(todayInZone(tz), strukTime, tz);
    if (parsed) date = parsed;
  }

  return {
    type: 'expense',
    amount: Math.round(receipt.total),
    category: receipt.category || 'Belanja',
    wallet,
    description,
    date: date.toISOString(),
    items: receipt.items || [],
  };
}
