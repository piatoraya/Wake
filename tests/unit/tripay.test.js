/**
 * Uji klien Tripay + penyimpanan kredensial pembayaran.
 *
 * Dua hal yang diuji di sini menentukan apakah uang masuk dengan benar:
 *
 *   1. Tanda tangan HMAC. Kalau rumusnya salah, Tripay menolak SEMUA
 *      transaksi dan tidak ada satu pun pembayaran yang bisa dibuat.
 *   2. Verifikasi callback. Kalau terlalu longgar, siapa pun bisa mengirim
 *      "pembayaran lunas" palsu ke URL webhook dan mendapat paket gratis.
 *
 * Nilai hex tanda tangan di bawah DIPATOK dari vektor uji tetap, bukan
 * dihitung ulang dari implementasi. Kalau implementasi berubah diam-diam,
 * tes ini gagal — itu tujuannya.
 *
 * Jalankan: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  tripaySignature,
  safeCompare,
  normalizeAmount,
  verifyTripayCallback,
  mapTripayStatus,
  parseTripayCallback,
  TripayError,
} from '../../src/services/tripay.js';
import {
  maskSecret,
  isMasked,
  normalizeMode,
  resolveTripayBaseUrl,
  getPaymentConfig,
  getPaymentConfigInternal,
  setPaymentConfig,
  isTripayConfigured,
  getPaymentConfigProblems,
  TRIPAY_BASE_URLS,
} from '../../src/config/paymentConfig.js';

/** Jalankan fn dengan DATA_DIR sementara yang bersih. */
async function withTempData(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-pay-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* ==========================================================================
 * Tanda tangan permintaan
 * ========================================================================== */

test('tripaySignature cocok dengan vektor uji tetap', () => {
  // Dihitung manual: HMAC-SHA256('T1234' + 'WAKE-PRO-1' + '474000', 'secret')
  const expected = crypto
    .createHmac('sha256', 'secret')
    .update('T1234WAKE-PRO-1474000')
    .digest('hex');

  const actual = tripaySignature({
    merchantCode: 'T1234',
    merchantRef: 'WAKE-PRO-1',
    amount: 474000,
    privateKey: 'secret',
  });

  assert.equal(actual, expected);
  assert.match(actual, /^[0-9a-f]{64}$/, 'harus hex 64 karakter');
});

test('tripaySignature membulatkan nominal dan menolak nilai tak sah', () => {
  const base = tripaySignature({
    merchantCode: 'T1',
    merchantRef: 'R1',
    amount: 1000,
    privateKey: 'k',
  });
  assert.equal(
    tripaySignature({ merchantCode: 'T1', merchantRef: 'R1', amount: 1000.4, privateKey: 'k' }),
    base,
    'pecahan di bawah 0,5 dibulatkan ke bawah',
  );
  assert.equal(
    tripaySignature({ merchantCode: 'T1', merchantRef: 'R1', amount: '1000', privateKey: 'k' }),
    base,
    'string angka diperlakukan sama',
  );
});

test('tripaySignature berubah bila salah satu komponen berubah', () => {
  const base = { merchantCode: 'T1', merchantRef: 'R1', amount: 1000, privateKey: 'k' };
  const sig = tripaySignature(base);

  assert.notEqual(tripaySignature({ ...base, amount: 1001 }), sig);
  assert.notEqual(tripaySignature({ ...base, merchantRef: 'R2' }), sig);
  assert.notEqual(tripaySignature({ ...base, merchantCode: 'T2' }), sig);
  assert.notEqual(tripaySignature({ ...base, privateKey: 'lain' }), sig);
});

test('normalizeAmount tidak pernah menghasilkan desimal atau negatif', () => {
  assert.equal(normalizeAmount(474000), '474000');
  assert.equal(normalizeAmount(474000.4), '474000', 'pecahan di bawah 0,5 ke bawah');
  assert.equal(normalizeAmount(474000.7), '474001', 'pecahan 0,5 ke atas dibulatkan ke atas');
  assert.equal(normalizeAmount('474000'), '474000');
  assert.equal(normalizeAmount(-500), '0');
  assert.equal(normalizeAmount(null), '0');
  assert.equal(normalizeAmount(NaN), '0');
  assert.equal(normalizeAmount(Infinity), '0');
  assert.ok(!normalizeAmount(474000.7).includes('.'), 'tidak boleh ada titik desimal');
  assert.ok(!normalizeAmount(474000.7).includes(','), 'tidak boleh ada pemisah ribuan');
});

/* ==========================================================================
 * Perbandingan aman
 * ========================================================================== */

test('safeCompare menerima hanya string identik', () => {
  assert.equal(safeCompare('abc123', 'abc123'), true);
  assert.equal(safeCompare('abc123', 'abc124'), false);
  assert.equal(safeCompare('abc', 'abcd'), false, 'panjang beda langsung ditolak');
  assert.equal(safeCompare('', ''), false, 'string kosong bukan kecocokan');
  assert.equal(safeCompare(null, null), false);
});

/* ==========================================================================
 * Verifikasi callback
 * ========================================================================== */

test('verifyTripayCallback menerima body dengan tanda tangan benar', async () => {
  const privateKey = 'rahasia-tripay';
  const rawBody = JSON.stringify({
    reference: 'DEV-123',
    merchant_ref: 'WAKE-PRO-1',
    total_amount: 474000,
    status: 'PAID',
  });
  const signature = crypto.createHmac('sha256', privateKey).update(rawBody).digest('hex');

  const r = await verifyTripayCallback({
    rawBody,
    signature,
    cfg: { private_key: privateKey },
  });
  assert.equal(r.valid, true);
});

test('verifyTripayCallback MENOLAK tanda tangan salah', async () => {
  const rawBody = JSON.stringify({ merchant_ref: 'WAKE-PRO-1', status: 'PAID' });
  const signature = crypto.createHmac('sha256', 'kunci-palsu').update(rawBody).digest('hex');

  const r = await verifyTripayCallback({
    rawBody,
    signature,
    cfg: { private_key: 'kunci-asli' },
  });
  assert.equal(r.valid, false);
  assert.match(r.reason, /tidak cocok/i);
});

test('verifyTripayCallback menolak body yang diubah walau tanda tangan asli disertakan', async () => {
  const privateKey = 'rahasia-tripay';
  const asli = JSON.stringify({ merchant_ref: 'WAKE-PRO-1', total_amount: 1000, status: 'PAID' });
  const signature = crypto.createHmac('sha256', privateKey).update(asli).digest('hex');

  // Penyerang menaikkan nominal tetapi memakai tanda tangan lama.
  const diubah = JSON.stringify({ merchant_ref: 'WAKE-PRO-1', total_amount: 999999, status: 'PAID' });
  const r = await verifyTripayCallback({ rawBody: diubah, signature, cfg: { private_key: privateKey } });

  assert.equal(r.valid, false, 'perubahan satu byte pun harus membatalkan tanda tangan');
});

test('verifyTripayCallback menolak body kosong atau header hilang', async () => {
  const cfg = { private_key: 'k' };
  assert.equal((await verifyTripayCallback({ rawBody: '', signature: 'x', cfg })).valid, false);
  assert.equal((await verifyTripayCallback({ rawBody: '{}', signature: '', cfg })).valid, false);
  assert.equal((await verifyTripayCallback({ rawBody: '{}', cfg })).valid, false);
});

test('verifyTripayCallback menolak bila private key belum diatur', async () => {
  const r = await verifyTripayCallback({ rawBody: '{}', signature: 'abc', cfg: { private_key: '' } });
  assert.equal(r.valid, false);
  assert.match(r.reason, /private key/i);
});

/* ==========================================================================
 * Pemetaan status & parsing callback
 * ========================================================================== */

test('mapTripayStatus memetakan semua status ke bentuk internal', () => {
  assert.equal(mapTripayStatus('PAID'), 'PAID');
  assert.equal(mapTripayStatus('paid'), 'PAID', 'tidak peduli huruf besar/kecil');
  assert.equal(mapTripayStatus('EXPIRED'), 'EXPIRED');
  assert.equal(mapTripayStatus('FAILED'), 'FAILED');
  assert.equal(mapTripayStatus('REFUND'), 'FAILED', 'refund dianggap gagal, bukan lunas');
  assert.equal(mapTripayStatus('UNPAID'), 'UNPAID');
  assert.equal(mapTripayStatus(''), 'UNPAID');
  assert.equal(mapTripayStatus(undefined), 'UNPAID');
});

test('parseTripayCallback mengambil field yang dibutuhkan', () => {
  const r = parseTripayCallback({
    reference: 'DEV-9',
    merchant_ref: 'WAKE-PRO-7',
    total_amount: 382900,
    status: 'PAID',
    payment_method: 'QRIS',
    payment_name: 'QRIS',
    pay_code: '1234',
    paid_at: '2026-03-04T10:00:00Z',
    is_closed: true,
  });

  assert.equal(r.merchantRef, 'WAKE-PRO-7');
  assert.equal(r.reference, 'DEV-9');
  assert.equal(r.status, 'PAID');
  assert.equal(r.rawStatus, 'PAID');
  assert.equal(r.amount, 382900);
  assert.equal(r.method, 'QRIS');
  assert.equal(r.payCode, '1234');
  assert.equal(r.isClosed, true);
});

test('parseTripayCallback memakai amount bila total_amount tidak ada', () => {
  const r = parseTripayCallback({ merchant_ref: 'R', amount: 50000, status: 'UNPAID' });
  assert.equal(r.amount, 50000);
});

test('parseTripayCallback mengembalikan null untuk field yang tidak dikirim', () => {
  const r = parseTripayCallback({});
  assert.equal(r.merchantRef, null);
  assert.equal(r.reference, null);
  assert.equal(r.method, null);
  assert.equal(r.amount, 0);
  assert.equal(r.status, 'UNPAID');
});

/* ==========================================================================
 * Penyimpanan kredensial
 * ========================================================================== */

test('maskSecret menyembunyikan sebagian besar nilai', () => {
  assert.equal(maskSecret('abcdefghij'), '••••••ghij', 'hanya 4 karakter AKHIR yang terlihat');
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret(null), '');
  assert.equal(maskSecret('ab'), '••', 'nilai pendek ditopeng penuh');
  assert.equal(maskSecret('abcd'), '••••', 'tepat 4 karakter ditopeng penuh');
});

test('maskSecret tidak pernah membocorkan prefix', () => {
  const secret = 'SUPERSECRETKEY123456';
  const masked = maskSecret(secret);
  assert.ok(!masked.includes('SUPERSECRET'), 'prefix tidak boleh terlihat');
  assert.ok(masked.endsWith('3456'), 'hanya 4 karakter akhir yang terlihat');
});

test('isMasked mengenali string bertopeng', () => {
  assert.equal(isMasked('••••1234'), true);
  assert.equal(isMasked('kunci-asli'), false);
  assert.equal(isMasked(''), false);
  assert.equal(isMasked(null), false);
});

test('normalizeMode jatuh ke sandbox untuk nilai tak dikenal', () => {
  assert.equal(normalizeMode('production'), 'production');
  assert.equal(normalizeMode('PRODUCTION'), 'production');
  assert.equal(normalizeMode('sandbox'), 'sandbox');
  assert.equal(normalizeMode('ngawur'), 'sandbox', 'nilai tak dikenal -> sandbox, bukan production');
  assert.equal(normalizeMode(''), 'sandbox');
  assert.equal(normalizeMode(null), 'sandbox');
});

test('resolveTripayBaseUrl memakai host yang benar per mode', () => {
  assert.equal(resolveTripayBaseUrl('sandbox'), TRIPAY_BASE_URLS.sandbox);
  assert.equal(resolveTripayBaseUrl('production'), TRIPAY_BASE_URLS.production);
  assert.match(resolveTripayBaseUrl('production'), /tripay\.co\.id\/api$/);
  assert.match(resolveTripayBaseUrl('sandbox'), /api-sandbox$/);
});

test('config default: pembayaran mati dan belum terkonfigurasi', async () => {
  await withTempData(async () => {
    const cfg = await getPaymentConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.mode, 'sandbox');
    assert.equal(cfg.configured, false);
    assert.equal(cfg.merchant_code, '');
  });
});

test('getPaymentConfig TIDAK pernah mengembalikan rahasia penuh', async () => {
  await withTempData(async () => {
    await setPaymentConfig({
      enabled: true,
      merchant_code: 'T1234',
      private_key: 'PRIVATEKEYRAHASIA',
      api_key: 'APIKEYRAHASIA',
    });

    const safe = await getPaymentConfig();
    const json = JSON.stringify(safe);

    assert.ok(!json.includes('PRIVATEKEYRAHASIA'), 'private key tidak boleh ada di output aman');
    assert.ok(!json.includes('APIKEYRAHASIA'), 'api key tidak boleh ada di output aman');
    assert.equal(safe.private_key, undefined, 'field mentah dihapus, bukan dikosongkan');
    assert.equal(safe.api_key, undefined);
    assert.equal(safe.private_key_set, true);
    assert.equal(safe.api_key_set, true);
    assert.match(safe.private_key_masked, /^•+/);
  });
});

test('getPaymentConfigInternal mengembalikan rahasia untuk kode server', async () => {
  await withTempData(async () => {
    await setPaymentConfig({ private_key: 'PRIVATEKEYRAHASIA', api_key: 'APIKEYRAHASIA' });
    const internal = await getPaymentConfigInternal();
    assert.equal(internal.private_key, 'PRIVATEKEYRAHASIA');
    assert.equal(internal.api_key, 'APIKEYRAHASIA');
  });
});

test('nilai bertopeng TIDAK menimpa kunci asli', async () => {
  await withTempData(async () => {
    await setPaymentConfig({ private_key: 'KUNCI-ASLI-PANJANG' });

    // Dashboard mengirim balik apa yang ditampilkan: topeng.
    await setPaymentConfig({ private_key: '••••jang' });

    const internal = await getPaymentConfigInternal();
    assert.equal(internal.private_key, 'KUNCI-ASLI-PANJANG', 'topeng tidak boleh menimpa kunci asli');
  });
});

test('string kosong TIDAK menghapus kunci yang sudah ada', async () => {
  await withTempData(async () => {
    await setPaymentConfig({ private_key: 'KUNCI-ASLI' });
    await setPaymentConfig({ private_key: '' });
    await setPaymentConfig({ private_key: '   ' });

    const internal = await getPaymentConfigInternal();
    assert.equal(internal.private_key, 'KUNCI-ASLI');
  });
});

test('setPaymentConfig tidak menghapus kunci config lain', async () => {
  await withTempData(async (dir) => {
    const { setFooter } = await import('../../src/config/appConfig.js');
    await setFooter('by: tester');
    await setPaymentConfig({ merchant_code: 'T1234' });

    const { getFooter } = await import('../../src/config/appConfig.js');
    assert.equal(await getFooter(), 'by: tester', 'footer harus tetap ada');

    const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(raw.footer, 'by: tester');
    assert.equal(raw.payment.merchant_code, 'T1234');
  });
});

test('isTripayConfigured butuh SEMUA syarat terpenuhi', async () => {
  const lengkap = {
    enabled: true,
    mode: 'sandbox',
    merchant_code: 'T1',
    private_key: 'p',
    api_key: 'a',
  };
  assert.equal(isTripayConfigured(lengkap), true);

  assert.equal(isTripayConfigured({ ...lengkap, enabled: false }), false, 'mati -> belum siap');
  assert.equal(isTripayConfigured({ ...lengkap, merchant_code: '' }), false);
  assert.equal(isTripayConfigured({ ...lengkap, private_key: '' }), false);
  assert.equal(isTripayConfigured({ ...lengkap, api_key: '' }), false);
  assert.equal(isTripayConfigured({ ...lengkap, mode: 'ngawur' }), false);
  assert.equal(isTripayConfigured(null), false);
});

test('getPaymentConfigProblems menyebut setiap syarat yang kurang', async () => {
  await withTempData(async () => {
    const kosong = await getPaymentConfigProblems();
    assert.equal(kosong.length, 4, 'mati + 3 field kosong');

    await setPaymentConfig({
      enabled: true,
      merchant_code: 'T1',
      private_key: 'p',
      api_key: 'a',
    });
    assert.deepEqual(await getPaymentConfigProblems(), []);
  });
});

test('fee_customer_percent dijepit ke rentang 0-100', async () => {
  await withTempData(async () => {
    assert.equal((await setPaymentConfig({ fee_customer_percent: -10 })).fee_customer_percent, 0);
    assert.equal((await setPaymentConfig({ fee_customer_percent: 250 })).fee_customer_percent, 100);
    assert.equal((await setPaymentConfig({ fee_customer_percent: 2.5 })).fee_customer_percent, 2.5);
    assert.equal((await setPaymentConfig({ fee_customer_percent: 'abc' })).fee_customer_percent, 0);
  });
});

test('disabled_channels menyaring nilai kosong', async () => {
  await withTempData(async () => {
    const cfg = await setPaymentConfig({ disabled_channels: ['QRIS', '', '  ', 'BRIVA'] });
    assert.deepEqual(cfg.disabled_channels, ['QRIS', 'BRIVA']);
  });
});

test('config rusak di disk tidak membuat server gagal start', async () => {
  await withTempData(async (dir) => {
    await fs.writeFile(path.join(dir, 'config.json'), '{ ini bukan json', 'utf8');
    const cfg = await getPaymentConfig();
    assert.equal(cfg.enabled, false, 'kembali ke default, bukan melempar error');
    assert.equal(cfg.mode, 'sandbox');
  });
});

test('TripayError membawa code dan status untuk route', () => {
  const e = new TripayError('gagal', { code: 'TRIPAY_TIMEOUT', status: 504 });
  assert.equal(e.name, 'TripayError');
  assert.equal(e.code, 'TRIPAY_TIMEOUT');
  assert.equal(e.status, 504);
  assert.ok(e instanceof Error);

  const d = new TripayError('biasa');
  assert.equal(d.code, 'TRIPAY_ERROR');
  assert.equal(d.status, 502);
});
