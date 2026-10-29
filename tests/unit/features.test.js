/**
 * Uji gerbang fitur berbasis PAKET (src/services/features.js).
 *
 * Regresi yang dijaga:
 *   1. Kuota tetap ATOMIK. Dulu `checkAndConsumeQuota` membaca user,
 *      menghitung di memori, lalu menulis terpisah — N request paralel bisa
 *      membaca angka yang sama sehingga kuota terpakai melebihi batas.
 *      Sekarang seluruh baca-hitung-tulis berada dalam satu `withCollection`.
 *   2. Batas fitur dibaca dari DATABASE, bukan dari konstanta di kode.
 *      Mengubah `subscription_plans` harus langsung mengubah perilaku.
 *   3. Paket berbayar yang kedaluwarsa turun ke gratis, dan user tidak
 *      kehilangan akses lebih dari yang seharusnya.
 *
 * Jalankan: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PHONE = '628111111111';

function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Siapkan DATA_DIR sementara, seed paket default, lalu buat satu user.
 * @param {object} opts
 * @param {'free'|'starter'|'pro'} [opts.plan]
 * @param {string|null} [opts.expiresAt]
 * @param {boolean} [opts.gating] apakah `tier_enabled` dinyalakan
 */
async function withTempData(opts, fn) {
  const { plan = 'free', expiresAt = null, gating = true } = opts || {};
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-features-'));
  const prevDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ footer: 'test', tier_enabled: gating }, null, 2),
    );
    await fs.writeFile(
      path.join(dir, 'users.json'),
      JSON.stringify(
        [
          {
            phone: PHONE,
            name: 'Tester',
            plan_slug: plan,
            plan_expires_at: expiresAt,
            text_quota_used: 0,
            media_quota_used: 0,
            quota_reset_date: monthStart(),
            last_media_reset_daily: '',
            active_bot_instances: [],
          },
        ],
        null,
        2,
      ),
    );

    const db = await import('../../src/config/database.js');
    await db.seedDefaultPlans();
    return await fn(dir, db);
  } finally {
    if (prevDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function futureIso(days = 30) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

function pastIso(days = 1) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

test('kuota teks free dibatasi 50 walau 70 request paralel', async () => {
  await withTempData({ plan: 'free' }, async () => {
    const { checkAndConsumeQuota } = await import('../../src/services/features.js');
    const results = await Promise.all(
      Array.from({ length: 70 }, () => checkAndConsumeQuota(PHONE, 'text')),
    );
    const allowed = results.filter((r) => r.allowed).length;
    assert.equal(allowed, 50, 'tepat 50 request boleh lolos, tidak lebih');
  });
});

test('media ditolak untuk paket gratis dengan alasan yang jelas', async () => {
  await withTempData({ plan: 'free' }, async () => {
    const { checkAndConsumeQuota } = await import('../../src/services/features.js');
    const r = await checkAndConsumeQuota(PHONE, 'media');
    assert.equal(r.allowed, false);
    assert.match(r.reason, /Media/i);
  });
});

test('paket pro: teks tanpa batas, media dan bot tersedia', async () => {
  await withTempData({ plan: 'pro', expiresAt: futureIso() }, async (dir, db) => {
    const f = await import('../../src/services/features.js');
    const user = await db.getUser(PHONE);

    assert.equal(await f.canAccessFeature(user, 'backup'), true);
    assert.equal(await f.canAccessFeature(user, 'report_export'), true);

    const text = await f.checkFeatureLimit(user, 'text_input');
    assert.equal(text.allowed, true);
    assert.equal(text.limit, -1, 'tak terbatas dilambangkan -1');

    const media = await f.checkFeatureLimit(user, 'media_input');
    assert.equal(media.allowed, true);

    const bot = await f.canCreateBotInstance(user);
    assert.equal(bot.allowed, true);
    assert.equal(bot.limit, 3);

    // 200 request paralel harus semuanya lolos untuk paket tak terbatas.
    const results = await Promise.all(
      Array.from({ length: 200 }, () => f.checkAndConsumeQuota(PHONE, 'text')),
    );
    assert.equal(results.filter((r) => r.allowed).length, 200);
  });
});

test('batas fitur dibaca dari DATABASE, bukan konstanta di kode', async () => {
  await withTempData({ plan: 'free' }, async (dir, db) => {
    const f = await import('../../src/services/features.js');

    let user = await db.getUser(PHONE);
    let limit = await f.checkFeatureLimit(user, 'text_input');
    assert.equal(limit.limit, 50, 'nilai awal dari seeder');

    // Admin mengubah kuota teks paket gratis menjadi 5 lewat dashboard.
    await db.updatePlan('free', { features: { ...(await db.getPlan('free')).features, text_input: 5 } });

    user = await db.getUser(PHONE);
    limit = await f.checkFeatureLimit(user, 'text_input');
    assert.equal(limit.limit, 5, 'perubahan DB langsung berlaku tanpa deploy ulang');

    const results = await Promise.all(
      Array.from({ length: 20 }, () => f.checkAndConsumeQuota(PHONE, 'text')),
    );
    assert.equal(results.filter((r) => r.allowed).length, 5);
  });
});

test('admin bisa menyalakan fitur backup untuk paket gratis', async () => {
  await withTempData({ plan: 'free' }, async (dir, db) => {
    const f = await import('../../src/services/features.js');
    let user = await db.getUser(PHONE);
    assert.equal(await f.canAccessFeature(user, 'backup'), false);

    const free = await db.getPlan('free');
    await db.updatePlan('free', { features: { ...free.features, backup: true } });

    user = await db.getUser(PHONE);
    assert.equal(await f.canAccessFeature(user, 'backup'), true);
  });
});

test('paket berbayar kedaluwarsa turun ke gratis', async () => {
  await withTempData({ plan: 'pro', expiresAt: pastIso() }, async (dir, db) => {
    const f = await import('../../src/services/features.js');
    const user = await db.getUser(PHONE);

    assert.equal(await f.canAccessFeature(user, 'backup'), false, 'backup dicabut');
    const bot = await f.canCreateBotInstance(user);
    assert.equal(bot.allowed, false);
    assert.equal(await f.canAccessFeature(user, 'report_export'), false);
  });
});

test('paket berbayar tanpa tanggal kedaluwarsa dianggap kedaluwarsa', async () => {
  await withTempData({ plan: 'starter', expiresAt: null }, async (dir, db) => {
    const f = await import('../../src/services/features.js');
    const user = await db.getUser(PHONE);
    assert.equal(await f.canAccessFeature(user, 'backup'), false);
  });
});

test('paket yang dinonaktifkan admin dianggap gratis', async () => {
  await withTempData({ plan: 'pro', expiresAt: futureIso() }, async (dir, db) => {
    const f = await import('../../src/services/features.js');
    await db.updatePlan('pro', { is_active: false });

    const user = await db.getUser(PHONE);
    assert.equal(await f.canAccessFeature(user, 'backup'), false);
  });
});

test('gating dimatikan: semua fitur terbuka tanpa menulis kuota', async () => {
  await withTempData({ plan: 'free', gating: false }, async (dir, db) => {
    const f = await import('../../src/services/features.js');
    const user = await db.getUser(PHONE);

    assert.equal(await f.canAccessFeature(user, 'backup'), true);
    const text = await f.checkFeatureLimit(user, 'text_input');
    assert.equal(text.limit, -1);
    assert.equal((await f.canCreateBotInstance(user)).allowed, true);

    await f.checkAndConsumeQuota(PHONE, 'text');
    const after = await db.getUser(PHONE);
    assert.equal(after.text_quota_used, 0, 'gating mati tidak boleh menaikkan counter');
  });
});

test('penyapu menurunkan paket kedaluwarsa dan menyimpan yang masih aktif', async () => {
  await withTempData({ plan: 'free' }, async (dir, db) => {
    const f = await import('../../src/services/features.js');

    // Tambah user kedua dengan paket kedaluwarsa.
    await db.upsertUser('628222222222', 'Kedaluwarsa');
    await db.setUserPlan('628222222222', 'pro', pastIso());

    const { downgraded } = await f.sweepExpiredPlans();
    assert.ok(downgraded.includes('628222222222'));

    const after = await db.getUser('628222222222');
    assert.equal(after.plan_slug, 'free');
    assert.equal(after.plan_expires_at, null);

    // User yang masih aktif tidak ikut diturunkan.
    await db.setUserPlan(PHONE, 'pro', futureIso());
    const { downgraded: second } = await f.sweepExpiredPlans();
    assert.equal(second.includes(PHONE), false);
  });
});

test('ringkasan paket melaporkan pemakaian dan sisa kuota', async () => {
  await withTempData({ plan: 'free' }, async (dir, db) => {
    const f = await import('../../src/services/features.js');
    await f.checkAndConsumeQuota(PHONE, 'text');
    await f.checkAndConsumeQuota(PHONE, 'text');

    const s = await f.getPlanSummary(PHONE);
    assert.equal(s.slug, 'free');
    assert.equal(s.usage.text_input.used, 2);
    assert.equal(s.usage.text_input.limit, 50);
    assert.equal(s.usage.text_input.remaining, 48);
    assert.equal(s.features.backup, false);
    assert.equal(s.gating_enabled, true);
  });
});

test('kuota bulanan direset saat bulan berganti', async () => {
  await withTempData({ plan: 'free' }, async (dir, db) => {
    const f = await import('../../src/services/features.js');
    await f.checkAndConsumeQuota(PHONE, 'text');

    // Paksa tanggal reset kuota ke bulan sebelumnya.
    await db.updateUserFields(PHONE, { quota_reset_date: '2000-01-01' });

    const r = await f.checkAndConsumeQuota(PHONE, 'text');
    assert.equal(r.allowed, true);
    assert.equal(r.user.text_quota_used, 1, 'counter kembali ke 1 setelah reset');
  });
});

test('user belum terdaftar ditolak dengan pesan daftar', async () => {
  await withTempData({ plan: 'free' }, async () => {
    const f = await import('../../src/services/features.js');
    const r = await f.checkAndConsumeQuota('628999999999', 'text');
    assert.equal(r.allowed, false);
    assert.match(r.reason, /DAFTAR/i);
  });
});

test('fitur yang tidak dikenal selalu ditolak', async () => {
  await withTempData({ plan: 'pro', expiresAt: futureIso() }, async (dir, db) => {
    const f = await import('../../src/services/features.js');
    const user = await db.getUser(PHONE);
    assert.equal(await f.canAccessFeature(user, 'tidak_ada_fitur_ini'), false);
    const limit = await f.checkFeatureLimit(user, 'tidak_ada_fitur_ini');
    assert.equal(limit.allowed, false);
  });
});
