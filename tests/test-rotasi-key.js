/**
 * Uji ROTASI API KEY Gemini.
 *
 * Skenario:
 *   1. Key pertama TIDAK VALID -> bot harus menandainya invalid lalu pindah
 *      ke key kedua (yang valid) dan tetap berhasil mem-parsing pesan.
 *   2. Semua key kena kuota (429) -> pasangan (model,key) masuk cooldown
 *      dan request berikutnya melompat ke pasangan lain.
 *
 * Jalankan: node tests/test-rotasi-key.js
 */
import 'dotenv/config';

import { parseTextMessage, getRotationStatus } from '../src/services/gemini.js';

const REAL_KEY = process.env.GEMINI_API_KEY;
const FAKE_KEY = 'AIzaSyFAKE_KEY_0000000000000000000000000';

const judul = (t) => console.log(`\n=========== ${t} ===========`);

/* --------------------------------------------------------------------------
 * 1. Key tidak valid -> rotasi ke key berikutnya
 * ------------------------------------------------------------------------ */
judul('1. Key pertama tidak valid (rotasi ke key kedua)');
process.env.GEMINI_API_KEYS = `${FAKE_KEY},${REAL_KEY}`;
process.env.GEMINI_MODEL = 'gemini-3.6-flash,gemini-3.5-flash-lite';

const hasil = await parseTextMessage('Beli kopi 25rb pakai QRIS');
console.log('hasil parse :', JSON.stringify(hasil));
console.log('status rotasi:', JSON.stringify(getRotationStatus(), null, 2));

const st1 = getRotationStatus();
console.log('\ncek:');
console.log('  key #1 ditandai invalid   :', st1.keys[0].invalid, '(harus true)');
console.log('  key #2 tidak invalid      :', !st1.keys[1].invalid, '(harus true)');
console.log('  parse tetap berhasil      :', hasil?.intent === 'add_transaction', '(harus true)');
console.log('  nominal ter-parse          :', hasil?.data?.amount, '(harus 25000)');

/* --------------------------------------------------------------------------
 * 2. Semua key kena kuota (429) -> cooldown per pasangan (model,key)
 * ------------------------------------------------------------------------ */
judul('2. Semua key kena kuota (429 -> cooldown per pasangan)');
process.env.GEMINI_API_KEYS = REAL_KEY;
process.env.GEMINI_MODEL = 'gemini-3.6-flash,gemini-3.5-flash-lite';

try {
  const r = await parseTextMessage('Beli nasi goreng 20rb cash');
  console.log('tidak error, hasil:', JSON.stringify(r));
} catch (err) {
  console.log('error code :', err.code);
  console.log('error msg  :', err.message.slice(0, 300));
}

const st2 = getRotationStatus();
console.log('\nstatus rotasi:', JSON.stringify(st2, null, 2));
console.log('\ncek:');
console.log('  ada pasangan cooldown  :', st2.exhaustedPairs.length > 0, `(harus true, ada: ${st2.exhaustedPairs.join(', ')})`);
console.log('  key utama masih dipakai:', !st2.keys[0].invalid, '(true = bukan key rusak, cuma limit)');
