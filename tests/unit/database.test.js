/**
 * Uji ketahanan database JSON terhadap file korup.
 *
 * Regresi yang dijaga: dulu file korup di-rename lalu `readCollection`
 * mengembalikan `[]`. Pemanggil berikutnya (mis. `withCollection`) menulis
 * array kosong itu kembali sehingga SELURUH data lama hilang tanpa peringatan.
 * Sekarang: baca tetap toleran (bot tidak mati), tetapi penulisan DITOLAK.
 *
 * Jalankan: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Siapkan DATA_DIR sementara; `files` = { 'users.json': 'isi mentah' }. */
async function withTempData(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-db-'));
  const prevDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content, 'utf8');
    }
    return await fn(dir);
  } finally {
    if (prevDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const CORRUPT = '[{"phone":"628111111111","name":"Budi"},{"phone":"628222"';

test('readCollection mengembalikan [] untuk file korup (bot tetap jalan)', async () => {
  await withTempData({ 'users.json': CORRUPT }, async () => {
    const { readCollection } = await import('../../src/config/database.js');
    const list = await readCollection('users');
    assert.deepEqual(list, [], 'pembacaan toleran agar bot tidak crash');
  });
});

test('withCollection MENOLAK menulis di atas koleksi korup', async () => {
  await withTempData({ 'users.json': CORRUPT }, async (dir) => {
    const { withCollection } = await import('../../src/config/database.js');

    await assert.rejects(
      () => withCollection('users', (arr) => arr.push({ phone: '628999999999' })),
      /rusak|corrupt/i,
      'penulisan harus gagal, bukan menghapus data lama',
    );

    const onDisk = await fs.readFile(path.join(dir, 'users.json'), 'utf8');
    assert.equal(onDisk, CORRUPT, 'file asli harus utuh apa adanya');
  });
});

test('file korup disalin ke *.corrupt-<ts> sebagai arsip', async () => {
  await withTempData({ 'users.json': CORRUPT }, async (dir) => {
    const { readCollection, listCorruptCollections } = await import('../../src/config/database.js');
    await readCollection('users');

    const entries = await fs.readdir(dir);
    const archives = entries.filter((f) => /\.corrupt-\d+$/.test(f));
    assert.equal(archives.length, 1, 'harus ada tepat satu arsip');

    const archived = await fs.readFile(path.join(dir, archives[0]), 'utf8');
    assert.equal(archived, CORRUPT, 'arsip berisi isi asli');

    const corrupt = listCorruptCollections();
    assert.equal(corrupt.length, 1);
    assert.equal(corrupt[0].name, 'users');
    assert.match(corrupt[0].error, /JSON|array/i);
  });
});

test('setelah file diperbaiki manual, penulisan kembali normal', async () => {
  await withTempData({ 'users.json': CORRUPT }, async (dir) => {
    const { readCollection, withCollection, listCorruptCollections } = await import(
      '../../src/config/database.js'
    );

    await readCollection('users'); // tandai korup
    assert.equal(listCorruptCollections().length, 1);

    // Admin memperbaiki file.
    const fixed = JSON.stringify([{ phone: '628111111111', name: 'Budi' }], null, 2);
    await fs.writeFile(path.join(dir, 'users.json'), fixed, 'utf8');

    assert.equal((await readCollection('users')).length, 1);
    assert.equal(listCorruptCollections().length, 0, 'status korup harus dilepas');

    await withCollection('users', (arr) => arr.push({ phone: '628999999999', name: 'Baru' }));
    const after = JSON.parse(await fs.readFile(path.join(dir, 'users.json'), 'utf8'));
    assert.equal(after.length, 2);
    assert.ok(after.some((u) => u.name === 'Baru'));
  });
});

test('setelah file korup dipindahkan, koleksi boleh dimulai kosong', async () => {
  await withTempData({ 'users.json': CORRUPT }, async (dir) => {
    const { readCollection, withCollection } = await import('../../src/config/database.js');
    await readCollection('users'); // tandai korup
    await fs.rm(path.join(dir, 'users.json'));

    assert.deepEqual(await readCollection('users'), []);
    await withCollection('users', (arr) => arr.push({ phone: '628123', name: 'Fresh' }));
    const after = JSON.parse(await fs.readFile(path.join(dir, 'users.json'), 'utf8'));
    assert.equal(after.length, 1);
  });
});

test('file kosong / belum ada dianggap koleksi kosong, bukan korup', async () => {
  await withTempData({ 'users.json': '   \n' }, async (dir) => {
    const { readCollection, withCollection, listCorruptCollections } = await import(
      '../../src/config/database.js'
    );
    assert.deepEqual(await readCollection('users'), []);
    assert.deepEqual(await readCollection('transactions'), [], 'file belum ada -> []');
    assert.equal(listCorruptCollections().length, 0);

    await withCollection('users', (arr) => arr.push({ phone: '6281' }));
    const after = JSON.parse(await fs.readFile(path.join(dir, 'users.json'), 'utf8'));
    assert.equal(after.length, 1);
  });
});

test('JSON valid tapi bukan array dianggap korup', async () => {
  await withTempData({ 'users.json': '{"users":[]}' }, async () => {
    const { readCollection, withCollection } = await import('../../src/config/database.js');
    assert.deepEqual(await readCollection('users'), []);
    await assert.rejects(() => withCollection('users', () => {}), /rusak|corrupt/i);
  });
});
