/**
 * Uji aktivasi langganan (src/services/subscription.js).
 *
 * FOKUS UTAMA: IDEMPOTENSI.
 *
 * Webhook gateway pembayaran tidak pernah dikirim tepat sekali. Tripay
 * mengirim ulang callback yang sama bila server lambat membalas, dan owner
 * bisa memicu cek status manual. Semua jalur itu masuk ke activatePayment().
 *
 * Kalau aktivasi tidak idempoten, satu pembayaran 6 bulan bisa menjadi 12
 * bulan atau lebih. Tes di bawah ini adalah jaring pengamannya.
 *
 * Jalankan: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Siapkan DATA_DIR bersih + database yang sudah di-seed.
 * Modul di-import ulang dengan cache-buster supaya tiap tes berdiri sendiri.
 */
async function withTempData(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-sub-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;

  const bust = `?t=${Date.now()}-${Math.random()}`;
  try {
    const db = await import(`../../src/config/database.js${bust}`);
    await db.seedDefaultPlans();
    const sub = await import(`../../src/services/subscription.js${bust}`);
    return await fn({ dir, db, sub });
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Buat pembayaran UNPAID untuk paket pro 6 bulan (474.000). */
async function makeUnpaidPayment(db, overrides = {}) {
  await db.upsertUser('628111', 'Budi');
  return db.createPayment({
    merchant_ref: 'WAKE-PRO-TEST1',
    user_phone: '628111',
    plan_slug: 'pro',
    duration_months: 6,
    base_amount: 474000,
    duration_discount_amount: 71100,
    final_amount: 402900,
    ...overrides,
  });
}

/** Hitung bulan antara dua tanggal ISO (dibulatkan). */
function monthsBetween(fromIso, toIso) {
  const a = new Date(fromIso);
  const b = new Date(toIso);
  return Math.round((b - a) / (1000 * 60 * 60 * 24 * 30.44));
}

/* ==========================================================================
 * preparePayment — harga dihitung di server
 * ========================================================================== */

test('preparePayment membuat transaksi UNPAID dengan harga dari server', async () => {
  await withTempData(async ({ db, sub }) => {
    const r = await sub.preparePayment({ phone: '628111', planSlug: 'pro', months: 6, name: 'Budi' });

    assert.equal(r.ok, true);
    assert.equal(r.payment.status, 'UNPAID');
    assert.equal(r.payment.final_amount, 402900, '474.000 - 15% = 402.900');
    assert.equal(r.payment.base_amount, 474000);
    assert.equal(r.payment.duration_discount_amount, 71100);
    assert.match(r.payment.merchant_ref, /^WAKE-PRO-\d{8}-[0-9A-F]{6}$/);
  });
});

test('preparePayment mengabaikan nominal apa pun dari client', async () => {
  await withTempData(async ({ sub }) => {
    // Client mencoba mengirim amount=1; fungsi tidak menerima parameter itu.
    const r = await sub.preparePayment({
      phone: '628111',
      planSlug: 'pro',
      months: 6,
      amount: 1,
      final_amount: 1,
      base_amount: 1,
    });
    assert.equal(r.payment.final_amount, 402900, 'harga tetap dari database');
  });
});

test('preparePayment menolak paket gratis', async () => {
  await withTempData(async ({ sub }) => {
    const r = await sub.preparePayment({ phone: '628111', planSlug: 'free', months: 1 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /gratis/i);
  });
});

test('preparePayment menolak paket tidak dikenal', async () => {
  await withTempData(async ({ sub }) => {
    const r = await sub.preparePayment({ phone: '628111', planSlug: 'tidak_ada', months: 1 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /tidak ditemukan/i);
  });
});

test('preparePayment menolak durasi tidak sah', async () => {
  await withTempData(async ({ sub }) => {
    const r = await sub.preparePayment({ phone: '628111', planSlug: 'pro', months: 5 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /Durasi harus/i);
  });
});

test('preparePayment menolak nomor kosong', async () => {
  await withTempData(async ({ sub }) => {
    const r = await sub.preparePayment({ phone: '  ', planSlug: 'pro', months: 1 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /wajib diisi/i);
  });
});

test('preparePayment menerapkan voucher dan mencatatnya di pembayaran', async () => {
  await withTempData(async ({ db, sub }) => {
    await db.addVoucher({ code: 'HEMAT10', discount_type: 'percent', discount_value: 10 });

    const r = await sub.preparePayment({
      phone: '628111',
      planSlug: 'pro',
      months: 6,
      voucherCode: 'hemat10',
    });

    assert.equal(r.ok, true);
    assert.equal(r.payment.voucher_code, 'HEMAT10', 'kode dinormalisasi ke huruf besar');
    assert.equal(r.payment.voucher_discount_amount, 40290, '10% dari subtotal 402.900');
    assert.equal(r.payment.final_amount, 362610);
  });
});

test('preparePayment menolak voucher tidak dikenal', async () => {
  await withTempData(async ({ sub }) => {
    const r = await sub.preparePayment({
      phone: '628111',
      planSlug: 'pro',
      months: 6,
      voucherCode: 'TIDAKADA',
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /tidak ditemukan/i);
  });
});

test('preparePayment TIDAK memakai kuota voucher saat transaksi dibuat', async () => {
  await withTempData(async ({ db, sub }) => {
    await db.addVoucher({ code: 'SEKALI', quota: 1, discount_value: 10 });
    await sub.preparePayment({ phone: '628111', planSlug: 'pro', months: 6, voucherCode: 'SEKALI' });

    const v = await db.getVoucher('SEKALI');
    assert.equal(v.used_count, 0, 'kuota baru dipakai setelah pembayaran LUNAS');
  });
});

/* ==========================================================================
 * activatePayment — idempotensi
 * ========================================================================== */

test('activatePayment mengaktifkan paket dan memperpanjang masa aktif', async () => {
  await withTempData(async ({ db, sub }) => {
    await makeUnpaidPayment(db);

    const r = await sub.activatePayment({ merchantRef: 'WAKE-PRO-TEST1', amount: 402900 });

    assert.equal(r.ok, true);
    assert.equal(r.payment.status, 'PAID');
    assert.equal(r.planSlug, 'pro');
    assert.equal(r.months, 6);

    const user = await db.getUser('628111');
    assert.equal(user.plan_slug, 'pro');
    assert.equal(monthsBetween(new Date().toISOString(), user.plan_expires_at), 6);
  });
});

test('activatePayment IDEMPOTEN: callback kedua tidak menambah masa aktif', async () => {
  await withTempData(async ({ db, sub }) => {
    await makeUnpaidPayment(db);

    const first = await sub.activatePayment({ merchantRef: 'WAKE-PRO-TEST1', amount: 402900 });
    assert.equal(first.ok, true);
    const afterFirst = (await db.getUser('628111')).plan_expires_at;

    const second = await sub.activatePayment({ merchantRef: 'WAKE-PRO-TEST1', amount: 402900 });
    assert.equal(second.ok, false);
    assert.equal(second.alreadyPaid, true, 'dikenali sebagai duplikat');

    const afterSecond = (await db.getUser('628111')).plan_expires_at;
    assert.equal(afterSecond, afterFirst, 'tanggal kedaluwarsa TIDAK berubah');
  });
});

test('activatePayment IDEMPOTEN: 10 callback paralel hanya menambah 6 bulan', async () => {
  await withTempData(async ({ db, sub }) => {
    await makeUnpaidPayment(db);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        sub.activatePayment({ merchantRef: 'WAKE-PRO-TEST1', amount: 402900 }),
      ),
    );

    assert.equal(results.filter((r) => r.ok).length, 1, 'tepat satu aktivasi berhasil');

    const user = await db.getUser('628111');
    assert.equal(
      monthsBetween(new Date().toISOString(), user.plan_expires_at),
      6,
      'masa aktif tetap 6 bulan, bukan 60',
    );
  });
});

test('activatePayment menolak nominal yang tidak cocok', async () => {
  await withTempData(async ({ db, sub }) => {
    await makeUnpaidPayment(db);

    const r = await sub.activatePayment({ merchantRef: 'WAKE-PRO-TEST1', amount: 1000 });

    assert.equal(r.ok, false);
    assert.match(r.reason, /Nominal tidak cocok/i);

    const payment = await db.getPaymentByRef('WAKE-PRO-TEST1');
    assert.equal(payment.status, 'UNPAID', 'status tidak boleh berubah saat nominal salah');

    const user = await db.getUser('628111');
    assert.equal(user.plan_slug, 'free', 'paket tidak boleh aktif');
  });
});

test('activatePayment menerima nominal yang sama walau dikirim sebagai string', async () => {
  await withTempData(async ({ db, sub }) => {
    await makeUnpaidPayment(db);
    const r = await sub.activatePayment({ merchantRef: 'WAKE-PRO-TEST1', amount: '402900' });
    assert.equal(r.ok, true);
  });
});

test('activatePayment melewati cek nominal bila amount tidak dikirim', async () => {
  await withTempData(async ({ db, sub }) => {
    await makeUnpaidPayment(db);
    const r = await sub.activatePayment({ merchantRef: 'WAKE-PRO-TEST1' });
    assert.equal(r.ok, true, 'dipakai untuk aktivasi manual owner');
  });
});

test('activatePayment menolak referensi kosong atau tidak dikenal', async () => {
  await withTempData(async ({ sub }) => {
    assert.equal((await sub.activatePayment({ merchantRef: '' })).ok, false);
    assert.equal((await sub.activatePayment({ merchantRef: 'TIDAKADA' })).ok, false);
    assert.match((await sub.activatePayment({ merchantRef: 'TIDAKADA' })).reason, /tidak ditemukan/i);
  });
});

test('activatePayment menolak transaksi yang sudah EXPIRED', async () => {
  await withTempData(async ({ db, sub }) => {
    const p = await makeUnpaidPayment(db);
    await db.updatePayment(p.id, { status: 'EXPIRED' });

    const r = await sub.activatePayment({ merchantRef: 'WAKE-PRO-TEST1', amount: 402900 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /EXPIRED/);
  });
});

test('activatePayment memakai kuota voucher tepat sekali', async () => {
  await withTempData(async ({ db, sub }) => {
    await db.addVoucher({ code: 'SEKALI', quota: 1, discount_value: 10 });
    const prep = await sub.preparePayment({
      phone: '628111',
      planSlug: 'pro',
      months: 6,
      voucherCode: 'SEKALI',
    });

    await sub.activatePayment({ merchantRef: prep.payment.merchant_ref, amount: 362610 });
    // Callback ulang.
    await sub.activatePayment({ merchantRef: prep.payment.merchant_ref, amount: 362610 });
    await new Promise((r) => setTimeout(r, 200));

    const v = await db.getVoucher('SEKALI');
    assert.equal(v.used_count, 1, 'kuota tidak boleh terpakai dua kali');
    assert.equal(await db.countVoucherUsageByUser('628111', 'SEKALI'), 1);
  });
});

test('activatePayment mencatat referensi Tripay dan waktu bayar', async () => {
  await withTempData(async ({ db, sub }) => {
    await makeUnpaidPayment(db);
    await sub.activatePayment({
      merchantRef: 'WAKE-PRO-TEST1',
      amount: 402900,
      tripayReference: 'DEV-999',
      paidAt: '2026-03-04T10:00:00.000Z',
    });

    const p = await db.getPaymentByRef('WAKE-PRO-TEST1');
    assert.equal(p.tripay_reference, 'DEV-999');
    assert.equal(p.paid_at, '2026-03-04T10:00:00.000Z');
  });
});

test('pembelian paket sama saat masih aktif menumpuk masa aktif', async () => {
  await withTempData(async ({ db, sub }) => {
    await makeUnpaidPayment(db);
    await sub.activatePayment({ merchantRef: 'WAKE-PRO-TEST1', amount: 402900 });

    const p2 = await db.createPayment({
      merchant_ref: 'WAKE-PRO-TEST2',
      user_phone: '628111',
      plan_slug: 'pro',
      duration_months: 3,
      base_amount: 237000,
      final_amount: 213300,
    });
    await sub.activatePayment({ merchantRef: 'WAKE-PRO-TEST2', amount: 213300 });

    const user = await db.getUser('628111');
    assert.equal(
      monthsBetween(new Date().toISOString(), user.plan_expires_at),
      9,
      '6 bulan + 3 bulan ditumpuk menjadi 9',
    );
  });
});

/* ==========================================================================
 * sweepExpiredPlans
 * ========================================================================== */

test('sweepExpiredPlans menurunkan paket yang sudah lewat ke gratis', async () => {
  await withTempData(async ({ db, sub }) => {
    await db.upsertUser('628111', 'Lewat');
    await db.upsertUser('628222', 'Aktif');
    await db.setUserPlan('628111', 'pro', '2020-01-01T00:00:00.000Z');
    await db.setUserPlan('628222', 'pro', '2030-01-01T00:00:00.000Z');

    const r = await sub.sweepExpiredPlans();

    assert.equal(r.checked, 1);
    assert.deepEqual(r.downgraded, [{ phone: '628111', from: 'pro' }]);

    const lewat = await db.getUser('628111');
    assert.equal(lewat.plan_slug, 'free');
    assert.equal(lewat.plan_expires_at, null);

    const aktif = await db.getUser('628222');
    assert.equal(aktif.plan_slug, 'pro', 'yang masih aktif tidak tersentuh');
  });
});

test('sweepExpiredPlans aman dipanggil berulang', async () => {
  await withTempData(async ({ db, sub }) => {
    await db.upsertUser('628111', 'Lewat');
    await db.setUserPlan('628111', 'pro', '2020-01-01T00:00:00.000Z');

    const first = await sub.sweepExpiredPlans();
    assert.equal(first.downgraded.length, 1);

    const second = await sub.sweepExpiredPlans();
    assert.equal(second.downgraded.length, 0, 'yang sudah gratis tidak muncul lagi');
  });
});

/* ==========================================================================
 * syncPaymentStatus
 * ========================================================================== */

test('syncPaymentStatus mengembalikan alreadyPaid untuk transaksi lunas', async () => {
  await withTempData(async ({ db, sub }) => {
    await makeUnpaidPayment(db);
    await sub.activatePayment({ merchantRef: 'WAKE-PRO-TEST1', amount: 402900 });

    const r = await sub.syncPaymentStatus('WAKE-PRO-TEST1');
    assert.equal(r.ok, true);
    assert.equal(r.alreadyPaid, true);
  });
});

test('syncPaymentStatus menolak referensi tidak dikenal', async () => {
  await withTempData(async ({ sub }) => {
    const r = await sub.syncPaymentStatus('TIDAKADA');
    assert.equal(r.ok, false);
    assert.match(r.reason, /tidak ditemukan/i);
  });
});

/* ==========================================================================
 * Ringkasan & koreksi manual
 * ========================================================================== */

test('getSubscriptionSummary merangkum paket, pembayaran, dan total belanja', async () => {
  await withTempData(async ({ db, sub }) => {
    await makeUnpaidPayment(db);
    await sub.activatePayment({ merchantRef: 'WAKE-PRO-TEST1', amount: 402900 });

    const s = await sub.getSubscriptionSummary('628111');
    assert.equal(s.plan_slug, 'pro');
    assert.equal(s.plan_label, 'Pro');
    assert.equal(s.total_paid, 402900);
    assert.equal(s.payment_count, 1);
    assert.equal(s.last_payment.status, 'PAID');
  });
});

test('getSubscriptionSummary mengembalikan null untuk user tidak dikenal', async () => {
  await withTempData(async ({ sub }) => {
    assert.equal(await sub.getSubscriptionSummary('628999'), null);
  });
});

test('setUserPlanManually bisa menaikkan dan menurunkan paket', async () => {
  await withTempData(async ({ db, sub }) => {
    await db.upsertUser('628111', 'Budi');

    const naik = await sub.setUserPlanManually({ phone: '628111', planSlug: 'pro', months: 3 });
    assert.equal(naik.ok, true);
    assert.equal((await db.getUser('628111')).plan_slug, 'pro');

    const turun = await sub.setUserPlanManually({ phone: '628111', planSlug: 'free' });
    assert.equal(turun.ok, true);
    const user = await db.getUser('628111');
    assert.equal(user.plan_slug, 'free');
    assert.equal(user.plan_expires_at, null);
  });
});

test('setUserPlanManually menolak user yang tidak ada', async () => {
  await withTempData(async ({ sub }) => {
    const r = await sub.setUserPlanManually({ phone: '628999', planSlug: 'pro', months: 1 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /tidak ditemukan/i);
  });
});

test('overrideUserPlan menyetel tanggal kedaluwarsa persis', async () => {
  await withTempData(async ({ db, sub }) => {
    await db.upsertUser('628111', 'Budi');

    const r = await sub.overrideUserPlan({
      phone: '628111',
      planSlug: 'starter',
      expiresAt: '2027-01-15T00:00:00.000Z',
    });

    assert.equal(r.ok, true);
    const user = await db.getUser('628111');
    assert.equal(user.plan_slug, 'starter');
    assert.equal(user.plan_expires_at, '2027-01-15T00:00:00.000Z');
  });
});

test('overrideUserPlan memaksa paket gratis tanpa masa aktif', async () => {
  await withTempData(async ({ db, sub }) => {
    await db.upsertUser('628111', 'Budi');
    await db.setUserPlan('628111', 'pro', '2030-01-01T00:00:00.000Z');

    await sub.overrideUserPlan({
      phone: '628111',
      planSlug: 'free',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });

    const user = await db.getUser('628111');
    assert.equal(user.plan_slug, 'free');
    assert.equal(user.plan_expires_at, null, 'paket gratis tidak menyimpan tanggal');
  });
});

test('isFinalStatus mengenali status yang tidak boleh diubah', async () => {
  await withTempData(async ({ sub }) => {
    assert.equal(sub.isFinalStatus('PAID'), true);
    assert.equal(sub.isFinalStatus('paid'), true);
    assert.equal(sub.isFinalStatus('EXPIRED'), true);
    assert.equal(sub.isFinalStatus('FAILED'), true);
    assert.equal(sub.isFinalStatus('UNPAID'), false);
    assert.equal(sub.isFinalStatus(''), false);
  });
});
