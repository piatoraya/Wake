/**
 * Uji koleksi langganan: subscription_plans, vouchers, payments.
 *
 * Regresi yang dijaga:
 *   1. Seeder paket IDEMPOTEN dan tidak menimpa pengaturan admin.
 *   2. Kuota voucher dinaikkan secara ATOMIK — dua redeem paralel tidak
 *      boleh melampaui kuota.
 *   3. `markPaymentPaid` idempoten: webhook Tripay yang dikirim ulang tidak
 *      boleh menaikkan masa aktif dua kali.
 *   4. Migrasi tier lama (sultan/premium/basic) memetakan ke paket baru
 *      tanpa kehilangan tanggal kedaluwarsa.
 *
 * Jalankan: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function withTempData(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-subs-'));
  const prevDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const db = await import('../../src/config/database.js');
    await db.seedDefaultPlans();
    return await fn(dir, db);
  } finally {
    if (prevDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('seeder membuat tiga paket dan bersifat idempoten', async () => {
  await withTempData(async (dir, db) => {
    const plans = await db.listPlans();
    assert.deepEqual(
      plans.map((p) => p.slug),
      ['free', 'starter', 'pro'],
    );

    const again = await db.seedDefaultPlans();
    assert.equal(again.created.length, 0, 'seed kedua tidak membuat apa pun');
    assert.deepEqual(again.existing.sort(), ['free', 'pro', 'starter']);
  });
});

test('seeder TIDAK menimpa pengaturan admin yang sudah ada', async () => {
  await withTempData(async (dir, db) => {
    await db.updatePlan('starter', { monthly_price: 12345 });
    await db.seedDefaultPlans();

    const starter = await db.getPlan('starter');
    assert.equal(starter.monthly_price, 12345, 'harga hasil edit admin dipertahankan');
  });
});

test('updatePlan mengabaikan field yang tidak dikenal', async () => {
  await withTempData(async (dir, db) => {
    await db.updatePlan('pro', { slug: 'diubah', is_admin: true, label: 'Pro Max' });
    const pro = await db.getPlan('pro');
    assert.equal(pro.slug, 'pro', 'slug tidak boleh diubah');
    assert.equal(pro.is_admin, undefined);
    assert.equal(pro.label, 'Pro Max');
  });
});

test('updatePlan mengembalikan null untuk paket yang tidak ada', async () => {
  await withTempData(async (dir, db) => {
    assert.equal(await db.updatePlan('tidak_ada', { label: 'X' }), null);
  });
});

test('kode voucher dinormalisasi dan duplikat ditolak', async () => {
  await withTempData(async (dir, db) => {
    const v = await db.addVoucher({ code: '  hemat50  ', discount_value: 50 });
    assert.equal(v.code, 'HEMAT50');

    await assert.rejects(
      () => db.addVoucher({ code: 'HEMAT50' }),
      /sudah dipakai/i,
    );
    await assert.rejects(
      () => db.addVoucher({ code: 'hemat 50' }),
      /sudah dipakai/i,
      'spasi diabaikan saat membandingkan',
    );
  });
});

test('getVoucher tidak peduli huruf besar/kecil', async () => {
  await withTempData(async (dir, db) => {
    await db.addVoucher({ code: 'PROMO' });
    assert.ok(await db.getVoucher('promo'));
    assert.ok(await db.getVoucher('PrOmO'));
    assert.equal(await db.getVoucher('tidakada'), null);
  });
});

test('addVoucher menolak kode kosong', async () => {
  await withTempData(async (dir, db) => {
    await assert.rejects(() => db.addVoucher({ code: '   ' }), /wajib diisi/i);
  });
});

test('kuota voucher tidak bisa dilampaui walau redeem paralel', async () => {
  await withTempData(async (dir, db) => {
    await db.addVoucher({ code: 'LIMIT5', quota: 5, discount_value: 10 });

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        db.redeemVoucher({ code: 'LIMIT5', phone: `62800000${i}`, amount: 1000 }),
      ),
    );

    const ok = results.filter((r) => r.ok).length;
    assert.equal(ok, 5, 'tepat 5 redeem berhasil, tidak lebih');

    const v = await db.getVoucher('LIMIT5');
    assert.equal(v.used_count, 5);
  });
});

test('redeemVoucher menolak kode tidak dikenal', async () => {
  await withTempData(async (dir, db) => {
    const r = await db.redeemVoucher({ code: 'TIDAKADA', phone: '628111' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /tidak ditemukan/i);
  });
});

test('pemakaian voucher dicatat per user', async () => {
  await withTempData(async (dir, db) => {
    await db.addVoucher({ code: 'SEKALI', quota: null, discount_value: 10 });
    await db.redeemVoucher({ code: 'SEKALI', phone: '628111', amount: 5000 });
    await db.redeemVoucher({ code: 'SEKALI', phone: '628111', amount: 5000 });
    await db.redeemVoucher({ code: 'SEKALI', phone: '628222', amount: 5000 });

    // Pencatatan berjalan di microtask terpisah; beri kesempatan selesai.
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(await db.countVoucherUsageByUser('628111', 'SEKALI'), 2);
    assert.equal(await db.countVoucherUsageByUser('628222', 'SEKALI'), 1);
    assert.equal(await db.countVoucherUsageByUser('628333', 'SEKALI'), 0);
  });
});

test('updateVoucher menolak kode yang bertabrakan dengan voucher lain', async () => {
  await withTempData(async (dir, db) => {
    const a = await db.addVoucher({ code: 'AAA' });
    await db.addVoucher({ code: 'BBB' });

    await assert.rejects(() => db.updateVoucher(a.id, { code: 'BBB' }), /sudah dipakai/i);
    // Mengubah ke kode sendiri harus boleh.
    const updated = await db.updateVoucher(a.id, { code: 'AAA', discount_value: 25 });
    assert.equal(updated.discount_value, 25);
  });
});

test('deleteVoucher menghapus berdasarkan id', async () => {
  await withTempData(async (dir, db) => {
    const v = await db.addVoucher({ code: 'HAPUS' });
    assert.equal(await db.deleteVoucher(v.id), true);
    assert.equal(await db.getVoucher('HAPUS'), null);
    assert.equal(await db.deleteVoucher(v.id), false, 'hapus dua kali mengembalikan false');
  });
});

test('markPaymentPaid idempoten: webhook ulang tidak menaikkan masa aktif dua kali', async () => {
  await withTempData(async (dir, db) => {
    await db.upsertUser('628111', 'Budi');
    await db.createPayment({
      merchant_ref: 'WAKE-PRO-1',
      user_phone: '628111',
      plan_slug: 'pro',
      duration_months: 6,
      base_amount: 474000,
      final_amount: 402900,
    });

    const first = await db.markPaymentPaid('WAKE-PRO-1', { tripay_reference: 'T1' });
    assert.equal(first.ok, true);
    assert.equal(first.payment.status, 'PAID');

    const second = await db.markPaymentPaid('WAKE-PRO-1', { tripay_reference: 'T1' });
    assert.equal(second.ok, false);
    assert.equal(second.alreadyPaid, true, 'pembayaran kedua dikenali sebagai duplikat');
  });
});

test('markPaymentPaid paralel hanya satu yang berhasil', async () => {
  await withTempData(async (dir, db) => {
    await db.createPayment({
      merchant_ref: 'WAKE-PRO-2',
      user_phone: '628111',
      plan_slug: 'pro',
      duration_months: 1,
      base_amount: 79000,
      final_amount: 79000,
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => db.markPaymentPaid('WAKE-PRO-2')),
    );
    assert.equal(results.filter((r) => r.ok).length, 1, 'tepat satu transisi ke PAID');
  });
});

test('markPaymentPaid mengembalikan ok:false untuk ref tidak dikenal', async () => {
  await withTempData(async (dir, db) => {
    const r = await db.markPaymentPaid('TIDAKADA');
    assert.equal(r.ok, false);
    assert.equal(r.payment, undefined);
  });
});

test('createPayment menyimpan rincian potongan harga', async () => {
  await withTempData(async (dir, db) => {
    const p = await db.createPayment({
      merchant_ref: 'WAKE-PRO-3',
      user_phone: '628111',
      plan_slug: 'pro',
      duration_months: 6,
      base_amount: 474000,
      duration_discount_amount: 71100,
      voucher_code: ' hemat50 ',
      voucher_discount_amount: 20000,
      final_amount: 382900,
    });

    assert.equal(p.status, 'UNPAID');
    assert.equal(p.voucher_code, 'HEMAT50', 'kode voucher dinormalisasi');
    assert.equal(p.base_amount - p.duration_discount_amount - p.voucher_discount_amount, p.final_amount);
  });
});

test('extendUserPlan mengakumulasi hanya untuk paket yang sama dan masih aktif', async () => {
  await withTempData(async (dir, db) => {
    await db.upsertUser('628111', 'Budi');

    const first = await db.extendUserPlan('628111', 'pro', 6);
    assert.equal(first.accumulated, false, 'pembelian pertama tidak mengakumulasi');

    const second = await db.extendUserPlan('628111', 'pro', 3);
    assert.equal(second.accumulated, true, 'paket sama + masih aktif -> ditambah');

    const third = await db.extendUserPlan('628111', 'starter', 1);
    assert.equal(third.accumulated, false, 'ganti paket -> dihitung dari sekarang');
  });
});

test('extendUserPlan menolak paket gratis', async () => {
  await withTempData(async (dir, db) => {
    await db.upsertUser('628111', 'Budi');
    await assert.rejects(() => db.extendUserPlan('628111', 'free', 1), /tidak punya masa aktif/i);
  });
});

test('migrasi tier lama: sultan -> pro, premium -> pro, basic -> starter', async () => {
  const cases = [
    ['sultan', 'pro'],
    ['premium', 'pro'],
    ['basic', 'starter'],
    ['free', 'free'],
  ];

  for (const [legacy, expected] of cases) {
    await withTempData(async (dir, db) => {
      await db.upsertUser('628111', 'Budi');

      // Tulis record gaya lama langsung ke file, seolah data dari versi sebelumnya.
      const file = path.join(dir, 'users.json');
      const users = JSON.parse(await fs.readFile(file, 'utf8'));
      delete users[0].plan_slug;
      delete users[0].plan_expires_at;
      users[0].tier = legacy;
      users[0].tier_expired_at = '2030-01-01T00:00:00.000Z';
      await fs.writeFile(file, JSON.stringify(users, null, 2));

      const migrated = await db.getUser('628111');
      assert.equal(migrated.plan_slug, expected, `tier ${legacy} -> ${expected}`);

      if (expected === 'free') {
        assert.equal(migrated.plan_expires_at, null, 'paket gratis tidak punya masa aktif');
      } else {
        assert.equal(
          migrated.plan_expires_at,
          '2030-01-01T00:00:00.000Z',
          'tanggal kedaluwarsa ikut terbawa agar user tidak kehilangan sisa durasi',
        );
      }
    });
  }
});

test('mengubah ke paket gratis menghapus masa aktif', async () => {
  await withTempData(async (dir, db) => {
    await db.upsertUser('628111', 'Budi');
    await db.setUserPlan('628111', 'pro', '2030-01-01T00:00:00.000Z');
    assert.equal((await db.getUser('628111')).plan_expires_at, '2030-01-01T00:00:00.000Z');

    await db.setUserPlan('628111', 'free');
    const after = await db.getUser('628111');
    assert.equal(after.plan_slug, 'free');
    assert.equal(after.plan_expires_at, null);
  });
});

test('findExpiredPlanUsers hanya mengembalikan paket berbayar yang lewat', async () => {
  await withTempData(async (dir, db) => {
    await db.upsertUser('628111', 'Lewat');
    await db.upsertUser('628222', 'Aktif');
    await db.upsertUser('628333', 'Gratis');

    await db.setUserPlan('628111', 'pro', '2020-01-01T00:00:00.000Z');
    await db.setUserPlan('628222', 'starter', '2030-01-01T00:00:00.000Z');

    const expired = await db.findExpiredPlanUsers();
    assert.deepEqual(
      expired.map((e) => e.phone),
      ['628111'],
    );
  });
});

test('updateUserFields bisa mengubah tanggal reset kuota', async () => {
  await withTempData(async (dir, db) => {
    await db.upsertUser('628111', 'Budi');
    await db.updateUserFields('628111', { quota_reset_date: '2000-01-01' });
    const u = await db.getUser('628111');
    assert.equal(u.quota_reset_date, '2000-01-01');
  });
});
