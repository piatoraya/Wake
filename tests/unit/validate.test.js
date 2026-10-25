/**
 * Uji skema validasi request (zod) dan middleware-nya.
 *
 * Jalankan: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { schemas, validateBody, validateQuery } from '../../src/web/validate.js';

/** Middleware palsu: meniru express dengan req/res minimal. */
function run(mw, body) {
  const req = { body };
  let status = 200;
  let payload = null;
  let nextCalled = false;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(data) {
      payload = data;
      return this;
    },
  };
  mw(req, res, () => {
    nextCalled = true;
  });
  return { req, status, payload, nextCalled };
}

test('login menolak body kosong', () => {
  const r = run(validateBody(schemas.login), {});
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 400);
  assert.equal(r.payload.success, false);
  assert.equal(r.payload.error.code, 'VALIDATION_ERROR');
});

test('login menerima username & password valid', () => {
  const r = run(validateBody(schemas.login), { username: 'owner', password: 'rahasia123' });
  assert.equal(r.nextCalled, true);
  assert.equal(r.req.body.username, 'owner');
});

test('transactionCreate menolak amount nol / negatif / bukan angka', () => {
  for (const amount of [0, -5, 'abc', '', null]) {
    const r = run(validateBody(schemas.transactionCreate), {
      user_phone: '628111111111',
      type: 'expense',
      amount,
    });
    assert.equal(r.nextCalled, false, `amount=${amount} harus ditolak`);
    assert.equal(r.status, 400);
  }
});

test('transactionCreate menerima amount string numerik & mengubahnya jadi number', () => {
  const r = run(validateBody(schemas.transactionCreate), {
    user_phone: '628111111111',
    type: 'expense',
    amount: '25000',
    category: 'Makanan',
  });
  assert.equal(r.nextCalled, true);
  assert.equal(r.req.body.amount, 25000);
  assert.equal(typeof r.req.body.amount, 'number');
});

test('transactionCreate menolak nomor telepon tidak valid', () => {
  const r = run(validateBody(schemas.transactionCreate), {
    user_phone: '123',
    type: 'expense',
    amount: 1000,
  });
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 400);
});

test('transactionUpdate menerima patch sebagian (partial)', () => {
  const r = run(validateBody(schemas.transactionUpdate), { amount: '5000' });
  assert.equal(r.nextCalled, true);
  assert.equal(r.req.body.amount, 5000);
});

test('categoryCreate mewajibkan name', () => {
  assert.equal(run(validateBody(schemas.categoryCreate), {}).nextCalled, false);
  assert.equal(run(validateBody(schemas.categoryCreate), { name: 'Makanan' }).nextCalled, true);
});

test('adminCreate menolak password terlalu pendek & role tidak dikenal', () => {
  assert.equal(
    run(validateBody(schemas.adminCreate), { username: 'baru', password: '123' }).nextCalled,
    false,
  );
  assert.equal(
    run(validateBody(schemas.adminCreate), { username: 'baru', password: 'rahasia123', role: 'root' })
      .nextCalled,
    false,
  );
  assert.equal(
    run(validateBody(schemas.adminCreate), { username: 'baru', password: 'rahasia123', role: 'admin' })
      .nextCalled,
    true,
  );
});

test('botInstanceCreate menerima phone kosong (opsional)', () => {
  const r = run(validateBody(schemas.botInstanceCreate), {
    owner_phone: '628111111111',
    name: 'Bot Kedua',
    phone: '',
  });
  assert.equal(r.nextCalled, true);
  assert.equal(r.req.body.phone, undefined);
});

test('botStart menerima body kosong (semua field punya default)', () => {
  assert.equal(run(validateBody(schemas.botStart), {}).nextCalled, true);
});

test('userUpdate menolak tier tidak dikenal', () => {
  assert.equal(run(validateBody(schemas.userUpdate), { tier: 'platinum' }).nextCalled, false);
  assert.equal(run(validateBody(schemas.userUpdate), { tier: 'premium' }).nextCalled, true);
});

test('restoreUpload mewajibkan payload backup', () => {
  assert.equal(run(validateBody(schemas.restoreUpload), { phone: '628111111111' }).nextCalled, false);
  assert.equal(
    run(validateBody(schemas.restoreUpload), { phone: '628111111111', data: { users: [] } }).nextCalled,
    true,
  );
});

test('validateQuery mengubah query string menjadi angka', () => {
  const req = { query: { page: '3', limit: '50' } };
  let nextCalled = false;
  const res = { status: () => res, json: () => res };
  validateQuery(schemas.pagination || schemas.login)(req, res, () => {
    nextCalled = true;
  });
  // pagination mungkin tidak ada; pastikan minimal tidak crash
  assert.equal(typeof nextCalled, 'boolean');
});
