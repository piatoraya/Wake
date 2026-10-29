/**
 * Uji mesin harga & validasi voucher (src/services/pricing.js).
 *
 * Fungsi di pricing.js sengaja MURNI (tanpa I/O) supaya angka yang
 * ditampilkan ke user bisa dihitung ulang di server saat pembuatan
 * transaksi. Tes ini menjaga urutan perhitungan dan semua jalur penolakan
 * voucher, karena kesalahan di sini langsung berarti kerugian uang.
 *
 * Jalankan: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  roundRp,
  computeDurationDiscount,
  computeVoucherDiscount,
  getDurationOption,
  calculatePrice,
  validateVoucher,
  buildCheckoutQuote,
  buildMerchantRef,
  buildPricingTable,
} from '../../src/services/pricing.js';
import { buildDefaultPlanRecord } from '../../src/config/plans.js';

/** Paket uji: 100.000/bulan supaya angkanya mudah diperiksa. */
function makePlan(overrides = {}) {
  return {
    ...buildDefaultPlanRecord('pro'),
    monthly_price: 100000,
    durations: [
      { months: 1, discount_type: 'percent', discount_value: 0 },
      { months: 3, discount_type: 'percent', discount_value: 10 },
      { months: 6, discount_type: 'fixed', discount_value: 50000 },
      { months: 12, discount_type: 'percent', discount_value: 25 },
    ],
    ...overrides,
  };
}

function makeVoucher(overrides = {}) {
  return {
    id: 'v1',
    code: 'HEMAT',
    discount_type: 'percent',
    discount_value: 10,
    max_discount_amount: null,
    min_transaction_amount: 0,
    applicable_plans: [],
    applicable_durations: [],
    quota: null,
    used_count: 0,
    max_per_user: 1,
    starts_at: null,
    expires_at: null,
    is_active: true,
    ...overrides,
  };
}

test('roundRp membulatkan dan tidak pernah negatif', () => {
  assert.equal(roundRp(1000.4), 1000);
  assert.equal(roundRp(1000.6), 1001);
  assert.equal(roundRp(-500), 0);
  assert.equal(roundRp('abc'), 0);
  assert.equal(roundRp(null), 0);
});

test('diskon durasi persen dihitung dari harga dasar', () => {
  assert.equal(computeDurationDiscount(300000, { discount_type: 'percent', discount_value: 10 }), 30000);
  assert.equal(computeDurationDiscount(300000, { discount_type: 'percent', discount_value: 0 }), 0);
});

test('diskon durasi nominal tidak melebihi harga dasar', () => {
  assert.equal(computeDurationDiscount(300000, { discount_type: 'fixed', discount_value: 50000 }), 50000);
  assert.equal(computeDurationDiscount(30000, { discount_type: 'fixed', discount_value: 50000 }), 30000);
});

test('diskon persen di atas 100 dijinakkan menjadi 100', () => {
  assert.equal(computeDurationDiscount(100000, { discount_type: 'percent', discount_value: 150 }), 100000);
});

test('diskon voucher menghormati plafon maksimum', () => {
  const v = makeVoucher({ discount_type: 'percent', discount_value: 10, max_discount_amount: 20000 });
  assert.equal(computeVoucherDiscount(400000, v), 20000, '10% dari 400rb = 40rb, dibatasi 20rb');
  assert.equal(computeVoucherDiscount(100000, v), 10000, 'di bawah plafon, dipakai apa adanya');
});

test('diskon voucher nominal tidak melebihi harga', () => {
  const v = makeVoucher({ discount_type: 'fixed', discount_value: 999999 });
  assert.equal(computeVoucherDiscount(50000, v), 50000);
});

test('getDurationOption mengembalikan durasi 1 bulan walau admin menghapusnya', () => {
  const plan = makePlan({ durations: [] });
  assert.deepEqual(getDurationOption(plan, 1), {
    months: 1,
    discount_type: 'percent',
    discount_value: 0,
  });
  assert.equal(getDurationOption(plan, 5), null, 'durasi tidak sah ditolak');
});

test('calculatePrice: urutan base -> diskon durasi -> diskon voucher', () => {
  const plan = makePlan();
  const voucher = makeVoucher({ discount_type: 'percent', discount_value: 10 });

  const p = calculatePrice({ plan, months: 3, voucher });
  assert.equal(p.base_amount, 300000);
  assert.equal(p.duration_discount_amount, 30000, '10% dari 300rb');
  assert.equal(p.subtotal, 270000);
  // Voucher dihitung dari SUBTOTAL (270rb), bukan dari harga dasar (300rb).
  assert.equal(p.voucher_discount_amount, 27000);
  assert.equal(p.final_amount, 243000);
});

test('calculatePrice: durasi 6 bulan dengan diskon nominal 50rb', () => {
  const p = calculatePrice({ plan: makePlan(), months: 6 });
  assert.equal(p.base_amount, 600000);
  assert.equal(p.duration_discount_amount, 50000);
  assert.equal(p.final_amount, 550000);
});

test('calculatePrice: tanpa voucher tidak ada potongan voucher', () => {
  const p = calculatePrice({ plan: makePlan(), months: 12 });
  assert.equal(p.base_amount, 1200000);
  assert.equal(p.duration_discount_amount, 300000);
  assert.equal(p.voucher_discount_amount, 0);
  assert.equal(p.final_amount, 900000);
});

test('validateVoucher menolak voucher tidak aktif', () => {
  const r = validateVoucher({
    voucher: makeVoucher({ is_active: false }),
    planSlug: 'pro',
    months: 1,
    amount: 100000,
  });
  assert.equal(r.valid, false);
  assert.match(r.reason, /tidak aktif/i);
});

test('validateVoucher menolak kuota habis', () => {
  const r = validateVoucher({
    voucher: makeVoucher({ quota: 5, used_count: 5 }),
    planSlug: 'pro',
    months: 1,
    amount: 100000,
  });
  assert.equal(r.valid, false);
  assert.match(r.reason, /kuota/i);
});

test('validateVoucher menolak sebelum mulai dan sesudah kedaluwarsa', () => {
  const now = new Date('2026-06-15T00:00:00.000Z');

  const belum = validateVoucher({
    voucher: makeVoucher({ starts_at: '2026-07-01T00:00:00.000Z' }),
    planSlug: 'pro',
    months: 1,
    amount: 100000,
    now,
  });
  assert.equal(belum.valid, false);
  assert.match(belum.reason, /belum berlaku/i);

  const lewat = validateVoucher({
    voucher: makeVoucher({ expires_at: '2026-06-01T00:00:00.000Z' }),
    planSlug: 'pro',
    months: 1,
    amount: 100000,
    now,
  });
  assert.equal(lewat.valid, false);
  assert.match(lewat.reason, /kedaluwarsa/i);
});

test('validateVoucher menolak bila batas per akun terlampaui', () => {
  const r = validateVoucher({
    voucher: makeVoucher({ max_per_user: 2 }),
    planSlug: 'pro',
    months: 1,
    amount: 100000,
    userUsage: 2,
  });
  assert.equal(r.valid, false);
  assert.match(r.reason, /2x per akun/i);
});

test('validateVoucher menolak paket yang tidak berlaku', () => {
  const r = validateVoucher({
    voucher: makeVoucher({ applicable_plans: ['starter'] }),
    planSlug: 'pro',
    months: 1,
    amount: 100000,
  });
  assert.equal(r.valid, false);
  assert.match(r.reason, /tidak berlaku untuk paket pro/i);
});

test('validateVoucher menolak durasi yang tidak berlaku', () => {
  const r = validateVoucher({
    voucher: makeVoucher({ applicable_durations: [6, 12] }),
    planSlug: 'pro',
    months: 3,
    amount: 300000,
  });
  assert.equal(r.valid, false);
  assert.match(r.reason, /durasi/i);
});

test('validateVoucher menolak bila minimal transaksi belum tercapai', () => {
  const r = validateVoucher({
    voucher: makeVoucher({ min_transaction_amount: 500000 }),
    planSlug: 'pro',
    months: 1,
    amount: 100000,
  });
  assert.equal(r.valid, false);
  assert.match(r.reason, /minimal transaksi/i);
});

test('validateVoucher menerima voucher yang sah', () => {
  const r = validateVoucher({
    voucher: makeVoucher(),
    planSlug: 'pro',
    months: 3,
    amount: 270000,
    userUsage: 0,
  });
  assert.equal(r.valid, true);
  assert.equal(r.code, 'HEMAT');
});

test('buildCheckoutQuote menolak paket gratis', () => {
  const r = buildCheckoutQuote({ plan: buildDefaultPlanRecord('free'), months: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /gratis/i);
});

test('buildCheckoutQuote menolak paket nonaktif', () => {
  const r = buildCheckoutQuote({ plan: makePlan({ is_active: false }), months: 3 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tidak dijual/i);
});

test('buildCheckoutQuote menolak durasi tidak sah', () => {
  const r = buildCheckoutQuote({ plan: makePlan(), months: 5 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Durasi harus/i);
});

test('buildCheckoutQuote menolak total di bawah minimum Tripay', () => {
  const murah = makePlan({
    monthly_price: 500,
    durations: [{ months: 1, discount_type: 'percent', discount_value: 0 }],
  });
  const r = buildCheckoutQuote({ plan: murah, months: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /minimal/i);
});

test('buildCheckoutQuote: voucher 100% ditolak karena total nol', () => {
  const r = buildCheckoutQuote({
    plan: makePlan(),
    months: 1,
    voucher: makeVoucher({ discount_type: 'percent', discount_value: 100 }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /minimal/i);
});

test('buildCheckoutQuote menghitung harga lengkap dengan voucher', () => {
  const r = buildCheckoutQuote({
    plan: makePlan(),
    months: 3,
    voucher: makeVoucher({ discount_type: 'percent', discount_value: 10 }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.pricing.base_amount, 300000);
  assert.equal(r.pricing.duration_discount_amount, 30000);
  assert.equal(r.pricing.voucher_discount_amount, 27000);
  assert.equal(r.pricing.final_amount, 243000);
  assert.equal(r.voucher.code, 'HEMAT');
});

test('buildCheckoutQuote menolak voucher tidak sah dan tidak mengembalikan harga', () => {
  const r = buildCheckoutQuote({
    plan: makePlan(),
    months: 1,
    voucher: makeVoucher({ quota: 1, used_count: 1 }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.pricing, undefined, 'harga tidak boleh dibocorkan saat voucher ditolak');
});

test('buildMerchantRef berformat WAKE-<PLAN>-<tanggal>-<hex> dan unik', () => {
  const now = new Date('2026-03-04T10:00:00.000Z');
  const ref = buildMerchantRef('pro', now);
  assert.match(ref, /^WAKE-PRO-20260304-[0-9A-F]{6}$/);

  const many = new Set(Array.from({ length: 200 }, () => buildMerchantRef('starter', now)));
  assert.ok(many.size > 190, `harus praktis unik, dapat ${many.size} nilai berbeda`);
});

test('buildPricingTable hanya memuat paket berbayar aktif', () => {
  const plans = [
    buildDefaultPlanRecord('free'),
    buildDefaultPlanRecord('starter'),
    { ...buildDefaultPlanRecord('pro'), is_active: false },
  ];
  const table = buildPricingTable(plans);
  assert.equal(table.length, 1);
  assert.equal(table[0].slug, 'starter');
  assert.equal(table[0].options.length, 4, 'empat opsi durasi');
  assert.equal(table[0].options[0].months, 1);
});

test('buildPricingTable menghitung harga per bulan tiap durasi', () => {
  const plan = makePlan();
  const [row] = buildPricingTable([plan]);
  const tiga = row.options.find((o) => o.months === 3);
  assert.equal(tiga.final_amount, 270000);
  assert.equal(tiga.per_month, 90000, '270rb / 3 bulan');
  assert.equal(tiga.savings, 30000);

  const dua_belas = row.options.find((o) => o.months === 12);
  assert.equal(dua_belas.per_month, 75000, '900rb / 12 bulan');
});
