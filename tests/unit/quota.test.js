/**
 * Uji kuota tier: pemakaian kuota harus ATOMIK.
 *
 * Regresi yang dijaga: dulu `checkAndConsumeQuota` membaca user, menghitung
 * di memori, lalu menulis terpisah. N request paralel bisa membaca angka
 * yang sama sehingga kuota terpakai melebihi batas. Sekarang seluruh
 * baca-hitung-tulis berada dalam satu `withCollection`.
 *
 * Jalankan: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Siapkan DATA_DIR sementara berisi config + satu user tier tertentu. */
async function withTempData(tier, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-quota-'));
  const prevDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ footer: 'test', tier_enabled: true }, null, 2),
    );
    await fs.writeFile(
      path.join(dir, 'users.json'),
      JSON.stringify(
        [
          {
            phone: '628111111111',
            name: 'Tester',
            tier,
            text_quota_used: 0,
            media_quota_used: 0,
            quota_reset_date: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`,
            last_media_reset_daily: '',
            sultan_bot_limit: 1,
            active_bot_instances: [],
            tier_expired_at: null,
          },
        ],
        null,
        2,
      ),
    );
    return await fn(dir);
  } finally {
    if (prevDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('kuota free dibatasi 50 teks walau 70 request paralel', async () => {
  await withTempData('free', async () => {
    const { checkAndConsumeQuota } = await import('../../src/services/quota.js');
    const { getUser } = await import('../../src/config/database.js');

    const phone = '628111111111';
    const results = await Promise.all(
      Array.from({ length: 70 }, () => checkAndConsumeQuota(phone, 'text')),
    );

    const allowed = results.filter((r) => r.allowed).length;
    const user = await getUser(phone);

    assert.equal(allowed, 50, 'tepat 50 request boleh lewat');
    assert.equal(user.text_quota_used, 50, 'counter tersimpan tepat 50 (tidak ada lost update)');
    assert.equal(results.filter((r) => !r.allowed).length, 20);
  });
});

test('tier basic: total teks + media dibatasi 100/bulan', async () => {
  await withTempData('basic', async () => {
    const { checkAndConsumeQuota } = await import('../../src/services/quota.js');
    const { getUser } = await import('../../src/config/database.js');

    const phone = '628111111111';
    const results = await Promise.all(
      Array.from({ length: 120 }, () => checkAndConsumeQuota(phone, 'text')),
    );
    const user = await getUser(phone);

    assert.equal(results.filter((r) => r.allowed).length, 100);
    assert.equal(user.text_quota_used + user.media_quota_used, 100);
  });
});

test('tier premium: teks unlimited, media dibatasi 100/bulan', async () => {
  await withTempData('premium', async () => {
    const { checkAndConsumeQuota } = await import('../../src/services/quota.js');
    const { getUser } = await import('../../src/config/database.js');

    const phone = '628111111111';
    const texts = await Promise.all(
      Array.from({ length: 60 }, () => checkAndConsumeQuota(phone, 'text')),
    );
    assert.equal(texts.every((r) => r.allowed), true, 'teks premium tidak dibatasi');

    const media = await Promise.all(
      Array.from({ length: 110 }, () => checkAndConsumeQuota(phone, 'media')),
    );
    assert.equal(media.filter((r) => r.allowed).length, 100);

    const user = await getUser(phone);
    assert.equal(user.media_quota_used, 100);
  });
});

test('tier sultan: teks & media unlimited', async () => {
  await withTempData('sultan', async () => {
    const { checkAndConsumeQuota } = await import('../../src/services/quota.js');
    const phone = '628111111111';

    const texts = await Promise.all(
      Array.from({ length: 40 }, () => checkAndConsumeQuota(phone, 'text')),
    );
    const media = await Promise.all(
      Array.from({ length: 40 }, () => checkAndConsumeQuota(phone, 'media')),
    );
    assert.equal(texts.every((r) => r.allowed), true);
    assert.equal(media.every((r) => r.allowed), true);
  });
});

test('user tidak terdaftar ditolak dengan pesan DAFTAR', async () => {
  await withTempData('free', async () => {
    const { checkAndConsumeQuota } = await import('../../src/services/quota.js');
    const r = await checkAndConsumeQuota('628999999999', 'text');
    assert.equal(r.allowed, false);
    assert.match(r.reason, /DAFTAR/i);
  });
});

test('tier_enabled=false: semua diizinkan tanpa menulis counter', async () => {
  await withTempData('free', async () => {
    const dir = process.env.DATA_DIR;
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ footer: 'test', tier_enabled: false }, null, 2),
    );

    const { checkAndConsumeQuota } = await import('../../src/services/quota.js');
    const { getUser } = await import('../../src/config/database.js');

    const phone = '628111111111';
    const results = await Promise.all(
      Array.from({ length: 10 }, () => checkAndConsumeQuota(phone, 'text')),
    );
    assert.equal(results.every((r) => r.allowed), true);

    const user = await getUser(phone);
    assert.equal(user.text_quota_used, 0, 'counter tidak bertambah saat limit dimatikan');
  });
});
