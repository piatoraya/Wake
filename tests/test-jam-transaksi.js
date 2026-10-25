/**
 * Uji fitur PENCATATAN JAM TRANSAKSI.
 *
 *   1. Utilitas jam (normalizeTime, combineDateTime, zonedToUtc)
 *   2. Struk belanja: jam yang tercetak ikut tercatat
 *   3. (opsional) Uji live ke Gemini: "Beli kopi 25rb jam 10"
 *
 * Jalankan:
 *   node tests/test-jam-transaksi.js          -> uji lokal (tanpa API)
 *   node tests/test-jam-transaksi.js --live   -> uji lokal +parsing Gemini sungguhan
 */
import 'dotenv/config';

import {
  clockInZone,
  combineDateTime,
  getTimezone,
  normalizeDate,
  normalizeTime,
  todayInZone,
  tzOffsetMinutes,
  zonedParts,
  zonedToUtc,
} from '../src/utils/datetime.js';
import { buildReceiptTransaction } from '../src/services/receipt.js';

const judul = (t) => console.log(`\n=========== ${t} ===========`);
const cek = (label, nilai, harus) => {
  const ok = nilai === harus;
  console.log(`  ${ok ? '✅' : '❌'} ${label}: ${nilai}${ok ? '' : ` (harus ${harus})`}`);
  if (!ok) process.exitCode = 1;
};

const TZ = getTimezone();
const HARI_INI = todayInZone(TZ);

/** "YYYY-MM-DD HH:MM" sesuai zona waktu bot (tanpa format tanggal per-locale). */
const jamLokal = (iso) => {
  const p = zonedParts(new Date(iso), TZ);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
};

console.log(`Zona waktu bot: ${TZ}`);
console.log(`Hari ini       : ${HARI_INI}`);
console.log(`Jam sekarang   : ${clockInZone(TZ)}`);

/* -------------------------------------------------------------------------- *
 * 1. Normalisasi jam
 * ------------------------------------------------------------------------ */
judul('1. Normalisasi jam (normalizeTime)');
cek('"10"', normalizeTime('10'), '10:00');
cek('"9:30"', normalizeTime('9:30'), '09:30');
cek('"10.00"', normalizeTime('10.00'), '10:00');
cek('"10:00:00"', normalizeTime('10:00:00'), '10:00');
cek('"jam 10"', normalizeTime('jam 10'), '10:00');
cek('"pukul 14"', normalizeTime('pukul 14'), '14:00');
cek('"10 PM"', normalizeTime('10 PM'), '22:00');
cek('"10:30 malam"', normalizeTime('10:30 malam'), '22:30');
cek('"jam 10 pagi"', normalizeTime('jam 10 pagi'), '10:00');
cek('"jam 10 malam"', normalizeTime('jam 10 malam'), '22:00');
cek('"jam 12 siang"', normalizeTime('jam 12 siang'), '12:00');
cek('"jam 12 malam"', normalizeTime('jam 12 malam'), '00:00');
cek('"jam 1 siang"', normalizeTime('jam 1 siang'), '13:00');
cek('"" (tidak ada jam)', normalizeTime(''), '');
cek('"abc" (tidak terbaca)', normalizeTime('abc'), '');
cek('"25:00" (tidak valid)', normalizeTime('25:00'), '');

/* -------------------------------------------------------------------------- *
 * 2. Gabung tanggal + jam -> timestamp UTC
 * ------------------------------------------------------------------------ */
judul('2. Gabung tanggal + jam (combineDateTime)');

// Helper: tanggal + jam lokal -> jam lokal saat itu (untuk pengecekan).
// (pakai jamLokal yang sudah didefinisikan di atas)

const t1 = combineDateTime(HARI_INI, '10:00');
cek('jam saja (tanpa tanggal) -> pakai hari ini', t1?.slice(0, 10), `${HARI_INI}T02:00:00.000Z`.slice(0, 10));
cek('jam 10 -> jam lokal 10:00', jamLokal(t1).endsWith('10:00'), true);

const t2 = combineDateTime('2026-10-18', '19:32');
cek('tanggal + jam -> 18/10 19:32 lokal', jamLokal(t2).endsWith('19:32'), true);
cek('tanggal + jam -> tanggalnya benar', jamLokal(t2).startsWith('2026-10-18'), true);

const t3 = combineDateTime('2026-10-18', '');
cek('tanggal saja -> 00:00 lokal', jamLokal(t3).endsWith('00:00'), true);

const t4 = combineDateTime('', '22:00');
cek('jam saja -> 22:00 lokal', jamLokal(t4).endsWith('22:00'), true);

cek('tidak ada tanggal & jam -> null', combineDateTime('', ''), null);

// Model kadang mengirim ISO lengkap -> dipakai apa adanya.
cek('ISO lengkap dipakai apa adanya', combineDateTime('2026-10-21T03:00:00.000Z', ''), '2026-10-21T03:00:00.000Z');

// Format tanggal Indonesia (model kadang mengirim "18/10/2026").
cek('normalizeDate "18/10/2026"', normalizeDate('18/10/2026'), '2026-10-18');
cek('normalizeDate "2026-10-18"', normalizeDate('2026-10-18'), '2026-10-18');
cek('normalizeDate "18.10.2026"', normalizeDate('18.10.2026'), '2026-10-18');
cek('normalizeDate ngawur -> ""', normalizeDate('nonsense'), '');
const t5 = combineDateTime('18/10/2026', '19:32');
cek('tanggal 18/10/2026 + jam', jamLokal(t5), '2026-10-18 19:32');

/* -------------------------------------------------------------------------- *
 * 3. Zona waktu & konversi
 * ------------------------------------------------------------------------ */
judul('3. Zona waktu (zonedToUtc / tzOffsetMinutes)');
cek('offset Asia/Jakarta = 420 menit', tzOffsetMinutes(new Date(), 'Asia/Jakarta'), 420);
cek('offset Asia/Makassar = 480 menit', tzOffsetMinutes(new Date(), 'Asia/Makassar'), 480);
cek('offset UTC = 0 menit', tzOffsetMinutes(new Date(), 'UTC'), 0);
cek('10:00 Jakarta = 03:00 UTC', zonedToUtc('2026-10-21', '10:00', 'Asia/Jakarta').toISOString(), '2026-10-21T03:00:00.000Z');
cek('10:00 Makassar = 02:00 UTC', zonedToUtc('2026-10-21', '10:00', 'Asia/Makassar').toISOString(), '2026-10-21T02:00:00.000Z');
cek('tanggal ngawur -> null', zonedToUtc('nope', '10:00', 'Asia/Jakarta'), null);

/* -------------------------------------------------------------------------- *
 * 4. Struk belanja: jam tercetak ikut tercatat
 * ------------------------------------------------------------------------ */
judul('4. Struk belanja (jam di struk)');
const receipt = {
  is_receipt: true,
  store: 'ALFA MART',
  total: 104340,
  subtotal: 94000,
  tax: 10340,
  payment_method: 'QRIS BCA',
  date: '2026-10-18',
  time: '19:32',
  category: 'Belanja',
  items: [{ name: 'INDOMIE GORENG', qty: 2, price: 28000, category: 'Makanan & Minuman' }],
  notes: '',
};

const txStruk = buildReceiptTransaction(receipt, { timezone: TZ });
cek('tanggal struk -> 2026-10-18', jamLokal(txStruk.date).startsWith('2026-10-18'), true);
cek('jam struk -> 19:32', jamLokal(txStruk.date), '2026-10-18 19:32');
cek('nominal tetap sama', txStruk.amount, 104340);
cek('wallet dari QRIS BCA', txStruk.wallet, 'QRIS');

const receiptTanpaJam = { ...receipt, time: '' };
const txTanpaJam = buildReceiptTransaction(receiptTanpaJam, { timezone: TZ });
cek('struk tanpa jam -> 00:00', jamLokal(txTanpaJam.date).endsWith('00:00'), true);

/* -------------------------------------------------------------------------- *
 * 5. Uji live ke Gemini (opsional)
 * ------------------------------------------------------------------------ */
if (process.argv.includes('--live')) {
  judul('5. Uji LIVE parsing Gemini');
  const { parseTextMessage } = await import('../src/services/gemini.js');

  const kasus = [
    { teks: 'Beli kopi 25rb jam 10', jam: '10:00' },
    { teks: 'makan siang 35 ribu jam 12 siang', jam: '12:00' },
    { teks: 'bensin 50rb jam 21.30', jam: '21:30' },
  ];

  for (const k of kasus) {
    const ai = await parseTextMessage(k.teks);
    const tgl = ai?.data?.date;
    const lokal = tgl ? jamLokal(tgl) : '(tidak ada tanggal/jam)';
    console.log(`  "${k.teks}"`);
    console.log(`     -> date=${tgl} | lokal=${lokal} | time=${ai?.data?.time}`);
    const ok = tgl && jamLokal(tgl).endsWith(k.jam);
    console.log(`     ${ok ? '✅' : '❌'} jam yang diharapkan ${k.jam}`);
    if (!ok) process.exitCode = 1;
  }
} else {
  console.log('\n(lewati uji live — jalankan dengan `--live` untuk mengetes ke Gemini)');
}
