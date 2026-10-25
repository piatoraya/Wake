/**
 * ==========================================================================
 *  src/web/csrf.js
 *  Proteksi CSRF dengan pola double-submit cookie.
 *
 *  Cara kerja:
 *    1. Setiap request diberi cookie `csrf_token` (non-httpOnly) yang
 *       nilainya acak per sesi browser.
 *    2. Frontend (api-client.js) menyalin nilai cookie itu ke header
 *       `X-CSRF-Token` pada semua request non-GET.
 *    3. Server menolak request non-GET bila header != cookie.
 *
 *  Request tanpa cookie sesi (belum login) juga ditolak untuk endpoint
 *  mutasi, sehingga form login tetap aman (login memakai endpoint sendiri
 *  yang dikecualikan karena belum ada sesi).
 * ==========================================================================
 */

import crypto from 'node:crypto';

export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

/** Metode yang tidak mengubah state. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Path yang dikecualikan (belum punya sesi / dipanggil pihak ketiga). */
const EXEMPT_PATHS = ['/api/auth/login', '/api/auth/refresh', '/api/public'];

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Pasang cookie CSRF bila belum ada, lalu verifikasi header pada request mutasi.
 * @returns {import('express').RequestHandler}
 */
export function csrfProtection() {
  return function csrfMiddleware(req, res, next) {
    // 1. Pastikan cookie tersedia.
    let token = req.cookies?.[CSRF_COOKIE];
    if (!token) {
      token = newToken();
      res.cookie(CSRF_COOKIE, token, {
        httpOnly: false, // harus bisa dibaca JS untuk double-submit
        sameSite: 'lax',
        secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
        path: '/',
      });
    }
    res.locals.csrfToken = token;

    // 2. Request aman / dikecualikan -> lanjut.
    if (SAFE_METHODS.has(req.method)) return next();
    if (EXEMPT_PATHS.some((p) => req.path.startsWith(p))) return next();

    // 3. Verifikasi double-submit.
    const sent = req.get(CSRF_HEADER) || req.body?._csrf || '';
    if (!sent || sent !== token) {
      return res.status(403).json({
        success: false,
        error: { code: 'CSRF_INVALID', message: 'Token CSRF tidak valid. Muat ulang halaman.' },
      });
    }
    return next();
  };
}
