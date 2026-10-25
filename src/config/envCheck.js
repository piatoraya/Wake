/**
 * ==========================================================================
 *  src/config/envCheck.js
 *  VALIDASI KONFIGURASI (.env) — fail-fast sebelum aplikasi berjalan
 *
 *  Tujuan:
 *    - Menolak secret/password default bawaan repo.
 *    - Menolak secret yang terlalu pendek.
 *    - Memastikan konfigurasi web aman saat WEB_ENABLED aktif.
 *
 *  Dipakai oleh:
 *    - src/index.js        -> bootstrap() (bot + web)
 *    - src/web/server.js   -> startWebServer() (mode web-only)
 *
 *  Perilaku:
 *    - `assertWebSecurity()`  -> throw bila konfigurasi berbahaya.
 *    - `warnInsecureConfig()` -> console.warn untuk hal yang "sebaiknya" diperbaiki.
 *    - `isProduction()`       -> NODE_ENV === 'production'
 * ==========================================================================
 */

/** Nilai yang jelas-jelas placeholder / default bawaan repo. */
const PLACEHOLDER_PATTERNS = [
  /change[-_ ]?me/i,
  /ganti[-_ ]?(dengan|ini|secret)/i,
  /^(owner123|admin123|password|secret|123456|rahasia)$/i,
  /isi_api_key/i,
  /xxxx/i,
];

/** Password default hasil seed admin (auth.js). */
export const DEFAULT_ADMIN_PASSWORDS = ['owner123', 'admin123'];

export const MIN_JWT_SECRET_LENGTH = 32;

export function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

/**
 * @param {string} value
 * @returns {boolean} true bila nilai adalah placeholder/default
 */
export function isPlaceholder(value) {
  const v = String(value ?? '').trim();
  if (!v) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(v));
}

/**
 * Ambil JWT_SECRET dan pastikan aman dipakai.
 * @throws {Error} bila secret kosong / placeholder / terlalu pendek
 * @returns {string}
 */
export function requireJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret) {
    throw new Error(
      'JWT_SECRET belum diisi di .env.\n' +
        '  Buat secret acak, contoh:\n' +
        "    node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"",
    );
  }
  if (isPlaceholder(secret)) {
    throw new Error(
      'JWT_SECRET masih memakai nilai contoh dari .env.example.\n' +
        '  Ganti dengan secret acak (minimal 32 karakter).',
    );
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET terlalu pendek (${secret.length} karakter). Minimal ${MIN_JWT_SECRET_LENGTH} karakter.`,
    );
  }
  return secret;
}

/**
 * Pastikan password admin yang di-seed bukan default repo.
 * @throws {Error} bila password default / terlalu pendek
 */
export function assertAdminPasswords() {
  const pairs = [
    ['WEB_OWNER_PASSWORD', process.env.WEB_OWNER_PASSWORD],
    ['WEB_ADMIN_PASSWORD', process.env.WEB_ADMIN_PASSWORD],
  ];
  for (const [key, raw] of pairs) {
    const value = String(raw ?? '').trim();
    if (!value) {
      throw new Error(
        `${key} belum diisi di .env. Password default bawaan repo tidak lagi dipakai.`,
      );
    }
    if (DEFAULT_ADMIN_PASSWORDS.includes(value.toLowerCase())) {
      throw new Error(
        `${key} masih memakai password default (${value}). Ganti sebelum menjalankan dashboard.`,
      );
    }
    if (value.length < 8) {
      throw new Error(`${key} terlalu pendek (${value.length} karakter). Minimal 8 karakter.`);
    }
  }
}

/**
 * Validasi lengkap konfigurasi keamanan web.
 * Dipanggil sebelum server HTTP menerima request.
 * @throws {Error}
 */
export function assertWebSecurity() {
  const problems = [];
  const check = (fn) => {
    try {
      fn();
    } catch (e) {
      problems.push(e.message);
    }
  };

  check(requireJwtSecret);

  // Password admin hanya wajib bila admin belum pernah di-seed
  // (seed hanya berjalan saat data/admin_users.json kosong).
  // Pemeriksaan nilai default tetap dilakukan agar tidak diam-diam dipakai.
  const ownerPass = String(process.env.WEB_OWNER_PASSWORD || '').trim();
  const adminPass = String(process.env.WEB_ADMIN_PASSWORD || '').trim();
  for (const [key, value] of [
    ['WEB_OWNER_PASSWORD', ownerPass],
    ['WEB_ADMIN_PASSWORD', adminPass],
  ]) {
    if (value && DEFAULT_ADMIN_PASSWORDS.includes(value.toLowerCase())) {
      problems.push(`${key} masih memakai password default (${value}).`);
    }
    if (value && value.length < 8) {
      problems.push(`${key} terlalu pendek (${value.length} karakter). Minimal 8 karakter.`);
    }
  }

  if (problems.length) {
    throw new Error(
      'Konfigurasi web tidak aman:\n' + problems.map((p) => `  - ${p}`).join('\n'),
    );
  }
}

/**
 * Peringatan non-fatal (tidak menghentikan aplikasi).
 * @returns {string[]} daftar peringatan
 */
export function warnInsecureConfig() {
  const warnings = [];

  if (!isProduction() && process.env.COOKIE_SECURE !== 'false') {
    warnings.push(
      'NODE_ENV bukan "production" — cookie sesi dikirim tanpa flag Secure. ' +
        'Set COOKIE_SECURE=true saat dashboard diakses via HTTPS.',
    );
  }
  if (!process.env.WEB_ORIGIN) {
    warnings.push('WEB_ORIGIN kosong — CORS menerima semua origin. Isi domain dashboard Anda.');
  }
  if (isPlaceholder(process.env.GEMINI_API_KEY) && isPlaceholder(process.env.GEMINI_API_KEYS)) {
    warnings.push('GEMINI_API_KEY / GEMINI_API_KEYS belum diisi — parsing AI tidak akan berfungsi.');
  }

  for (const w of warnings) console.warn(`⚠️  [ENV] ${w}`);
  return warnings;
}
