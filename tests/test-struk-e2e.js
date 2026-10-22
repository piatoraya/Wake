/**
 * Uji integrasi fitur STRUK:
 *   gambar struk -> parseReceiptImage -> buildReceiptTransaction -> simpan
 *
 * Jalankan: node backups/test-struk-e2e.js
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import sharp from 'sharp';

import { parseReceiptImage } from '../src/services/gemini.js';
import { buildReceiptTransaction, mapPaymentToWallet } from '../src/services/receipt.js';
import { addTransaction, listTransactions, getWalletBalances } from '../src/config/database.js';

const lines = [
  ['ALFA MART', 26],
  ['JL. MERDEKA NO. 12', 22],
  ['TANGGAL  18/10/2026 19:32', 26],
  ['------------------------', 26],
  ['INDOMIE GORENG      2  14.000', 26],
  ['TELUR AYAM 1KG     1  32.500', 26],
  ['MINUMAN AIR 600ML  3   9.000', 26],
  ['ROTI TAWAR         1  17.000', 26],
  ['SABUN MANDI        1  21.500', 26],
  ['------------------------', 26],
  ['SUBTOTAL            94.000', 26],
  ['PPN 11%             10.340', 26],
  ['------------------------', 26],
  ['TOTAL             104.340', 26],
  ['BAYAR QRIS BCA     104.340', 26],
];

const rowH = 34;
const height = 60 + lines.length * rowH;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${lines
    .map(([text], i) => `<text x="20" y="${50 + i * rowH}" font-family="monospace" font-size="22" fill="#000000">${text}</text>`)
    .join('\n  ')}
</svg>`;

const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
await fs.writeFile('/tmp/struk-e2e.jpg', jpeg);

console.log('--- 1. Baca struk via vision ---');
const receipt = await parseReceiptImage(jpeg, 'image/jpeg', { caption: '' });
console.log('is_receipt:', receipt.is_receipt, '| store:', receipt.store);
console.log('total:', receipt.total, '| tanggal:', receipt.date, '| bayar:', receipt.payment_method);
console.log('items:', receipt.items.map((i) => `${i.name} x${i.qty} = ${i.price}`).join(', '));

console.log('\n--- 2. Susun transaksi ---');
const fields = buildReceiptTransaction(receipt, { caption: '' });
console.log(fields);

console.log('\n--- 3. Simpan ke database ---');
const phone = '628999999999';
const tx = await addTransaction({ user_phone: phone, ...fields, source: 'receipt' });
console.log('tersimpan:', JSON.stringify(tx, null, 2));

const txs = await listTransactions(phone);
console.log('\ntransaksi user:', txs.length, '| terakhir:', txs.at(-1)?.amount, txs.at(-1)?.description);
console.log('saldo wallet:', JSON.stringify(await getWalletBalances(phone)));

console.log('\n--- 4. Uji pemetaan wallet ---');
for (const m of ['QRIS BCA', 'DEBIT BCA', 'TUNDAI', 'GOPAY', 'KREDIT MANDIRI', 'OVO', 'SHOPEEPAY', 'BRI', '']) {
  console.log(`  ${(m || '(kosong)').padEnd(16)} -> ${mapPaymentToWallet(m)}`);
}
