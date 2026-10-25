/**
 * Uji konfigurasi keamanan: penolakan placeholder, panjang minimum secret,
 * dan deteksi password admin default.
 *
 * Jalankan: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isPlaceholder,
  requireJwtSecret,
  assertAdminPasswords,
  assertWebSecurity,
  DEFAULT_ADMIN_PASSWORDS,
  MIN_JWT_SECRET_LENGTH,
} from '../../src/config/envCheck.js';

/** Jalankan fn dengan env sementara, lalu pulihkan. */
function withEnv(patch, fn) {
  const backup = {};
  for (const [k, v] of Object.entries(patch)) {
    backup[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const STRONG_JWT = 'a1b2c3d4'.repeat(6); // 48 karakter

test('isPlaceholder mendeteksi nilai contoh .env', () => {
  assert.equal(isPlaceholder(''), true);
  assert.equal(isPlaceholder('   '), true);
  assert.equal(isPlaceholder('ganti_dengan_secret_panjang'), true);
  assert.equal(isPlaceholder('isi_api_key_anda'), true);
  assert.equal(isPlaceholder('owner123'), true);
  assert.equal(isPlaceholder('admin123'), true);
  assert.equal(isPlaceholder('changeme'), true);
  assert.equal(isPlaceholder('xxxxyyyy'), true); // pola xxxx
  assert.equal(isPlaceholder(STRONG_JWT), false);
});

test('requireJwtSecret menolak secret kosong / placeholder / terlalu pendek', () => {
  assert.throws(() => withEnv({ JWT_SECRET: '' }, requireJwtSecret), /JWT_SECRET/);
  assert.throws(
    () => withEnv({ JWT_SECRET: 'ganti_dengan_secret_panjang' }, requireJwtSecret),
    /JWT_SECRET/,
  );
  assert.throws(() => withEnv({ JWT_SECRET: 'pendek' }, requireJwtSecret), /JWT_SECRET/);
  assert.throws(
    () => withEnv({ JWT_SECRET: 'a'.repeat(MIN_JWT_SECRET_LENGTH - 1) }, requireJwtSecret),
    /JWT_SECRET/,
  );
});

test('requireJwtSecret menerima secret acak yang valid', () => {
  assert.equal(withEnv({ JWT_SECRET: STRONG_JWT }, requireJwtSecret), STRONG_JWT);
  const exact = 'f3a9c1'.repeat(6); // 36 char heksadesimal
  assert.equal(withEnv({ JWT_SECRET: exact }, requireJwtSecret), exact);
});

test('assertAdminPasswords menolak password default', () => {
  for (const pwd of DEFAULT_ADMIN_PASSWORDS) {
    assert.throws(
      () =>
        withEnv(
          { WEB_OWNER_PASSWORD: pwd, WEB_ADMIN_PASSWORD: 'RahasiaKuat123' },
          assertAdminPasswords,
        ),
      /password/i,
    );
    assert.throws(
      () =>
        withEnv(
          { WEB_OWNER_PASSWORD: 'RahasiaKuat123', WEB_ADMIN_PASSWORD: pwd },
          assertAdminPasswords,
        ),
      /password/i,
    );
  }
});

test('assertAdminPasswords menolak password kosong / terlalu pendek', () => {
  assert.throws(
    () =>
      withEnv({ WEB_OWNER_PASSWORD: '', WEB_ADMIN_PASSWORD: 'RahasiaKuat123' }, assertAdminPasswords),
    /password/i,
  );
  assert.throws(
    () =>
      withEnv({ WEB_OWNER_PASSWORD: 'RahasiaKuat123', WEB_ADMIN_PASSWORD: 'pendek' }, assertAdminPasswords),
    /password/i,
  );
});

test('assertAdminPasswords menerima password kuat', () => {
  assert.doesNotThrow(() =>
    withEnv(
      { WEB_OWNER_PASSWORD: 'OwnerKuat#2026', WEB_ADMIN_PASSWORD: 'AdminKuat#2026' },
      assertAdminPasswords,
    ),
  );
});

test('assertWebSecurity lolos pada konfigurasi aman', () => {
  assert.doesNotThrow(() =>
    withEnv(
      {
        JWT_SECRET: STRONG_JWT,
        WEB_OWNER_PASSWORD: 'OwnerKuat#2026',
        WEB_ADMIN_PASSWORD: 'AdminKuat#2026',
        WEB_ORIGIN: 'https://catataja.id',
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
      },
      assertWebSecurity,
    ),
  );
});

test('assertWebSecurity menolak kombinasi tidak aman', () => {
  assert.throws(
    () =>
      withEnv(
        {
          JWT_SECRET: 'ganti_dengan_secret_panjang',
          WEB_OWNER_PASSWORD: 'owner123',
          WEB_ADMIN_PASSWORD: 'admin123',
        },
        assertWebSecurity,
      ),
    /tidak aman/,
  );
});
