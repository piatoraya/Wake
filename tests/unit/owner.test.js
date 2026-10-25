/**
 * Uji helper owner: normalisasi nomor & pengecekan owner.
 * Ini menyatukan perilaku yang sebelumnya tersebar di banyak tempat
 * di src/index.js dengan format yang tidak konsisten.
 *
 * Jalankan: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePhoneNumber, ownerPhone, isOwner } from '../../src/utils/phone.js';

test('normalizePhoneNumber merapikan format lokal & internasional', () => {
  assert.equal(normalizePhoneNumber('0852-1234-5678'), '6285212345678');
  assert.equal(normalizePhoneNumber('+62 852 1234 5678'), '6285212345678');
  assert.equal(normalizePhoneNumber('6285212345678'), '6285212345678');
  assert.equal(normalizePhoneNumber('6285212345678@s.whatsapp.net'), '6285212345678');
  assert.equal(normalizePhoneNumber(''), null);
  assert.equal(normalizePhoneNumber(null), null);
  assert.equal(normalizePhoneNumber('bukan-nomor'), null);
});

test('ownerPhone menormalkan OWNER_NUMBER dari env', () => {
  const prev = process.env.OWNER_NUMBER;
  try {
    process.env.OWNER_NUMBER = '0852-1234-5678';
    assert.equal(ownerPhone(), '6285212345678');

    process.env.OWNER_NUMBER = '';
    assert.equal(ownerPhone(), null);

    delete process.env.OWNER_NUMBER;
    assert.equal(ownerPhone(), null);
  } finally {
    if (prev === undefined) delete process.env.OWNER_NUMBER;
    else process.env.OWNER_NUMBER = prev;
  }
});

test('isOwner cocok untuk berbagai format nomor owner yang sama', () => {
  const prev = process.env.OWNER_NUMBER;
  try {
    process.env.OWNER_NUMBER = '085212345678';
    assert.equal(isOwner('6285212345678'), true);
    assert.equal(isOwner('+62 852 1234 5678'), true);
    assert.equal(isOwner('6285212345678@s.whatsapp.net'), true);
    assert.equal(isOwner('6289999999999'), false);
    assert.equal(isOwner(''), false);
    assert.equal(isOwner(null), false);
  } finally {
    if (prev === undefined) delete process.env.OWNER_NUMBER;
    else process.env.OWNER_NUMBER = prev;
  }
});

test('isOwner selalu false bila OWNER_NUMBER kosong (tidak ada owner default)', () => {
  const prev = process.env.OWNER_NUMBER;
  try {
    process.env.OWNER_NUMBER = '';
    assert.equal(isOwner('6285212345678'), false);
    assert.equal(isOwner(''), false);
  } finally {
    if (prev === undefined) delete process.env.OWNER_NUMBER;
    else process.env.OWNER_NUMBER = prev;
  }
});

test('isOwner membaca env terbaru (mendukung perintah !reload)', () => {
  const prev = process.env.OWNER_NUMBER;
  try {
    process.env.OWNER_NUMBER = '628111111111';
    assert.equal(isOwner('628111111111'), true);
    process.env.OWNER_NUMBER = '628222222222';
    assert.equal(isOwner('628111111111'), false);
    assert.equal(isOwner('628222222222'), true);
  } finally {
    if (prev === undefined) delete process.env.OWNER_NUMBER;
    else process.env.OWNER_NUMBER = prev;
  }
});
