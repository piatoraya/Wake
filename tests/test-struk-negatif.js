/**
 * Uji skenario negatif & caption override:
 *   1. Foto BUKAN struk -> is_receipt false, tidak boleh dicatat
 *   2. Caption user jadi override wallet
 *   3. Struk blur (total tak terbaca) -> fallback, bukan nominal 0
 *
 * Jalankan: node backups/test-struk-negatif.js
 */
import 'dotenv/config';
import sharp from 'sharp';

import { parseReceiptImage } from '../src/services/gemini.js';
import { buildReceiptTransaction } from '../src/services/receipt.js';

console.log('--- 1. Foto bukan struk (gradien warna + lingkaran) ---');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#ff0000"/><stop offset="100%" stop-color="#0000ff"/>
  </linearGradient></defs>
  <rect width="400" height="300" fill="url(#g)"/>
  <circle cx="200" cy="150" r="90" fill="none" stroke="#ffffff" stroke-width="12"/>
</svg>`;
const bukanStruk = await sharp(Buffer.from(svg)).jpeg().toBuffer();
const r1 = await parseReceiptImage(bukanStruk, 'image/jpeg');
console.log('is_receipt:', r1.is_receipt, '(harus false)');
console.log('total:', r1.total, '(harus 0)');

console.log('\n--- 2. Caption jadi override wallet ---');
const receiptDummy = {
  is_receipt: true,
  store: 'TOKO KOPI',
  total: 25000,
  subtotal: 25000,
  tax: 0,
  payment_method: 'TUNDAI',
  date: '2026-10-20',
  category: 'Makanan & Minuman',
  items: [{ name: 'KOPI', qty: 1, price: 25000, category: 'Makanan & Minuman' }],
  notes: '',
};
console.log('tanpa caption  ->', buildReceiptTransaction(receiptDummy).wallet);
console.log('caption BCA    ->', buildReceiptTransaction(receiptDummy, { caption: 'pakai debit BCA' }).wallet);
console.log('caption QRIS   ->', buildReceiptTransaction(receiptDummy, { caption: 'bayar qriss' }).wallet);
console.log('struk QRIS BCA ->', buildReceiptTransaction({ ...receiptDummy, payment_method: 'QRIS BCA' }).wallet);

console.log('\n--- 3. Total 0 -> tidak boleh jadi transaksi ---');
const kosong = { ...receiptDummy, total: 0, subtotal: 0 };
console.log('amount:', buildReceiptTransaction(kosong).amount, '(harus 0 -> dicoret oleh handleReceiptResult)');
