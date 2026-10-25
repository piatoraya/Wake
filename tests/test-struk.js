/**
 * Uji coba pembaca struk: buat struk sintetis (SVG -> JPEG) lalu kirim ke
 * Gemini untuk checking hasil parsingnya.
 *
 * Jalankan: node backups/test-struk.js
 */
import 'dotenv/config';
import sharp from 'sharp';
import { parseReceiptImage } from '../src/services/gemini.js';

const lines = [
  ['ALFA MART', 26],
  ['JL. MERDEKA NO. 12', 22],
  ['JAKARTA PUSAT', 22],
  ['------------------------', 26],
  ['TANGGAL  18/10/2026 19:32', 26],
  ['KASIR : RINA', 26],
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
  ['------------------------', 26],
  ['BAYAR QRIS BCA     104.340', 26],
  ['KEMBALI                   0', 26],
  ['TERIMA KASIH', 26],
];

const width = 560;
const rowH = 34;
const height = 60 + lines.length * rowH;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${lines
    .map(([text], i) => {
      const y = 50 + i * rowH;
      return `<text x="20" y="${y}" font-family="monospace" font-size="22" fill="#000000">${text}</text>`;
    })
    .join('\n  ')}
</svg>`;

const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
await sharp(jpeg).toFile('/tmp/struk-alfamart.jpg');
console.log('Struk sintetis dibuat: /tmp/struk-alfamart.jpg (', jpeg.length, 'bytes )');

const receipt = await parseReceiptImage(jpeg, 'image/jpeg');
console.log('\n=== HASIL PARSING ===');
console.log(JSON.stringify(receipt, null, 2));
