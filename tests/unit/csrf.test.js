/**
 * Uji proteksi CSRF (double-submit cookie).
 *
 * Jalankan: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { csrfProtection, CSRF_COOKIE, CSRF_HEADER } from '../../src/web/csrf.js';

/** Simulasi request express minimal. */
function makeReq({ method = 'GET', path = '/api/transactions', cookies = {}, headers = {}, body = {} }) {
  const hdrs = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    path,
    cookies,
    body,
    get(name) {
      return hdrs[String(name).toLowerCase()];
    },
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    cookiesSet: {},
    body: null,
    locals: {},
    cookie(name, value, opts) {
      this.cookiesSet[name] = { value, opts };
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function run(req) {
  const res = makeRes();
  let nextCalled = false;
  csrfProtection()(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

test('GET selalu lolos dan selalu menyiapkan cookie token', () => {
  const { res, nextCalled } = run(makeReq({ method: 'GET' }));
  assert.equal(nextCalled, true);
  assert.ok(res.cookiesSet[CSRF_COOKIE], 'cookie csrf harus dipasang');
  assert.equal(res.cookiesSet[CSRF_COOKIE].opts.httpOnly, false, 'harus bisa dibaca JS');
  assert.equal(res.locals.csrfToken, res.cookiesSet[CSRF_COOKIE].value);
});

test('POST tanpa header CSRF ditolak 403', () => {
  const { res, nextCalled } = run(
    makeReq({ method: 'POST', cookies: { [CSRF_COOKIE]: 'tok123' } }),
  );
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'CSRF_INVALID');
});

test('POST dengan header sama dengan cookie diterima', () => {
  const { nextCalled } = run(
    makeReq({
      method: 'POST',
      cookies: { [CSRF_COOKIE]: 'tok123' },
      headers: { [CSRF_HEADER]: 'tok123' },
    }),
  );
  assert.equal(nextCalled, true);
});

test('POST dengan header berbeda dari cookie ditolak', () => {
  const { res, nextCalled } = run(
    makeReq({
      method: 'POST',
      cookies: { [CSRF_COOKIE]: 'tok123' },
      headers: { [CSRF_HEADER]: 'token-palsu' },
    }),
  );
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('endpoint login & public dikecualikan (belum punya sesi)', () => {
  for (const path of ['/api/auth/login', '/api/auth/refresh', '/api/public/contact']) {
    const { nextCalled } = run(makeReq({ method: 'POST', path }));
    assert.equal(nextCalled, true, `${path} harus dikecualikan`);
  }
});

test('PUT & DELETE juga diverifikasi', () => {
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const { res, nextCalled } = run(
      makeReq({ method, cookies: { [CSRF_COOKIE]: 'tok123' } }),
    );
    assert.equal(nextCalled, false, `${method} tanpa header harus ditolak`);
    assert.equal(res.statusCode, 403);
  }
});
