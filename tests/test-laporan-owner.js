/**
 * Uji fitur LAPORAN KE OWNER.
 *
 *   1. Normalisasi nomor owner (0852... -> JID 62...)
 *   2. Isi laporan (kuota habis & key tidak valid)
 *   3. Pengiriman ke owner + anti spam + lewati bila pemicu = owner
 *
 * Jalankan: node tests/test-laporan-owner.js
 */
import 'dotenv/config';

import { ownerJid, normalizePhoneNumber, phoneToJid } from '../src/utils/phone.js';
import {
  buildAiFailureReport,
  notifyOwner,
  reportAiFailureToOwner,
  getAlertCooldownMs,
} from '../src/services/owner.js';

const judul = (t) => console.log(`\n=========== ${t} ===========`);
const cek = (label, nilai, harus) => {
  const ok = nilai === harus;
  console.log(`  ${ok ? '✅' : '❌'} ${label}: ${nilai}${ok ? '' : ` (harus ${harus})`}`);
  if (!ok) process.exitCode = 1;
};

/* --------------------------------------------------------------------------
 * 1. Normalisasi nomor owner
 * ------------------------------------------------------------------------ */
judul('1. Normalisasi nomor owner');
cek('normalize("085242283425")', normalizePhoneNumber('085242283425'), '6285242283425');
cek('normalize("6285242283425")', normalizePhoneNumber('6285242283425'), '6285242283425');
cek('normalize("+62 852-4228-3425")', normalizePhoneNumber('+62 852-4228-3425'), '6285242283425');
cek('normalize("abc")', normalizePhoneNumber('abc'), null);
cek('phoneToJid', phoneToJid('085242283425'), '6285242283425@s.whatsapp.net');
cek('ownerJid dari .env', ownerJid(), '6285242283425@s.whatsapp.net');
cek('cooldown default (menit)', getAlertCooldownMs() / 60000, 15);

/* --------------------------------------------------------------------------
 * 2. Isi laporan
 * ------------------------------------------------------------------------ */
judul('2. Isi laporan ke owner');
const statusRotasi = {
  models: ['gemini-3.6-flash', 'gemini-3.8-flash'],
  keys: [
    { index: 1, masked: 'AQ.A…Pcbg', invalid: false, exhaustedModels: ['gemini-3.6-flash'] },
    { index: 2, masked: 'AIza…7fQz', invalid: true, exhaustedModels: ['gemini-3.6-flash', 'gemini-3.8-flash'] },
  ],
  exhaustedPairs: ['gemini-3.6-flash', 'gemini-3.8-flash'],
};

const errQuota = Object.assign(new Error('Kuota/limit Gemini habis untuk semua model & API key'), {
  code: 'GEMINI_QUOTA_EXCEEDED',
});
const laporan = buildAiFailureReport(errQuota, { phone: '628123456789' }, statusRotasi, {
  timezone: 'Asia/Jakarta',
});
console.log(laporan);
console.log('');
cek('judul kuota', laporan.includes('KUOTA GEMINI HABIS'), true);
cek('pemicu tampil', laporan.includes('628123456789'), true);
cek('daftar key limit', laporan.includes('key #1'), true);
cek('daftar key invalid', laporan.includes('tidak valid'), true);
cek('ada saran', laporan.includes('GEMINI_API_KEYS'), true);

const laporanGagal = buildAiFailureReport(
  Object.assign(new Error('Semua model/API key Gemini gagal'), { code: 'GEMINI_ALL_FAILED' }),
  { phone: '628123456789' },
  statusRotasi,
);
cek('judul gagal total', laporanGagal.includes('GEMINI GAGAL TOTAL'), true);

/* --------------------------------------------------------------------------
 * 3. Pengiriman + anti spam + lewati bila pemicu = owner
 * ------------------------------------------------------------------------ */
judul('3. Pengiriman ke owner');
const terkirim = [];
const sockPalsu = {
  async sendMessage(jid, payload) {
    terkirim.push({ jid, text: payload.text });
  },
};

const ok1 = await reportAiFailureToOwner(
  sockPalsu,
  errQuota,
  { phone: '628123456789' },
  statusRotasi,
);
cek('laporan terkirim', ok1, true);
cek('tujuan = owner', terkirim[0]?.jid, '6285242283425@s.whatsapp.net');

const ok2 = await reportAiFailureToOwner(
  sockPalsu,
  errQuota,
  { phone: '628123456789' },
  statusRotasi,
);
cek('laporan ke-2 di-skip (anti spam)', ok2, false);
cek('tidak terkirim 2x', terkirim.length, 1);

const ok3 = await reportAiFailureToOwner(
  sockPalsu,
  errQuota,
  { phone: '6285242283425' },
  statusRotasi,
);
cek('pemicu = owner -> dilewati', ok3, false);
cek('tidak terkirim ke owner sendiri', terkirim.length, 1);

// Jenis laporan berbeda -> terkirim (tidak kena cooldown jenis sebelumnya)
const ok4 = await notifyOwner(sockPalsu, {
  type: 'gagal',
  text: 'uji jenis lain',
  jid: '6285242283425@s.whatsapp.net',
});
cek('jenis laporan lain terkirim', ok4, true);
cek('total terkirim', terkirim.length, 2);
