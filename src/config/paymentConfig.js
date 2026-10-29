/**
 * ==========================================================================
 *  src/config/paymentConfig.js
 *  Kredensial gateway pembayaran (Tripay) + opsi checkout.
 *
 *  KENAPA FILE TERPISAH DARI appConfig.js
 *  appConfig.js menyimpan pengaturan tampilan (footer) yang ikut dikirim ke
 *  halaman publik. Menaruh private key pembayaran di file yang sama berarti
 *  satu kesalahan render = kunci bocor. File ini TIDAK PERNAH mengembalikan
 *  nilai rahasia secara penuh:
 *
 *    - getPaymentConfig()          -> rahasia diganti versi bertopeng
 *    - getPaymentConfigInternal()  -> hanya untuk kode server (tanda tangan HMAC)
 *
 *  File ini juga tidak pernah membaca dari .env. Semua nilai datang dari
 *  data/config.json supaya owner bisa mengubahnya dari dashboard tanpa
 *  menyentuh server.
 * ==========================================================================
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Mode Tripay yang dikenal. */
export const PAYMENT_MODES = ['sandbox', 'production'];

/** Basis URL API Tripay per mode. */
export const TRIPAY_BASE_URLS = {
  sandbox: 'https://tripay.co.id/api-sandbox',
  production: 'https://tripay.co.id/api',
};

/**
 * Field rahasia: ditulis apa adanya, tetapi selalu ditampilkan bertopeng.
 * Urutannya dipakai konsisten untuk masking dan penggabungan.
 */
export const SECRET_FIELDS = ['private_key', 'api_key'];

/** Panjang karakter asli yang masih ditampilkan di akhir topeng. */
const MASK_VISIBLE_CHARS = 4;

const DEFAULTS = {
  enabled: false,
  mode: 'sandbox',
  merchant_code: '',
  private_key: '',
  api_key: '',
  /** Biaya jasa layanan yang dibebankan ke pembeli (persen, 0 = ditanggung merchant). */
  fee_customer_percent: 0,
  /** Metode pembayaran yang disembunyikan dari halaman checkout. */
  disabled_channels: [],
};

function dataDir() {
  return path.resolve(process.env.DATA_DIR || './data');
}

function configFile() {
  return path.join(dataDir(), 'config.json');
}

/**
 * Ubah nilai rahasia menjadi bentuk bertopeng yang aman dikirim ke browser.
 * Nilai pendek tetap ditopeng penuh supaya tidak ada karakter asli yang bocor.
 *
 * @param {string} value
 * @returns {string} contoh: '••••••••cdef'
 */
export function maskSecret(value) {
  const raw = String(value ?? '');
  if (!raw) return '';
  if (raw.length <= MASK_VISIBLE_CHARS) return '•'.repeat(raw.length || 0);
  return '•'.repeat(Math.min(raw.length - MASK_VISIBLE_CHARS, 12)) + raw.slice(-MASK_VISIBLE_CHARS);
}

/** Apakah sebuah nilai masih berupa topeng (bukan nilai asli)? */
export function isMasked(value) {
  return typeof value === 'string' && value.includes('•');
}

/** Normalisasi mode; nilai tak dikenal jatuh ke sandbox (lebih aman). */
export function normalizeMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  return PAYMENT_MODES.includes(m) ? m : 'sandbox';
}

/** Basis URL untuk sebuah mode. */
export function resolveTripayBaseUrl(mode) {
  return TRIPAY_BASE_URLS[normalizeMode(mode)];
}

/**
 * Baca config mentah dari disk, LENGKAP dengan rahasia.
 *
 * Hanya untuk kode server. Jangan pernah kirim hasil fungsi ini ke response
 * HTTP, log, atau template.
 *
 * @returns {Promise<object>}
 */
export async function getPaymentConfigInternal() {
  let parsed = {};
  try {
    const raw = await fs.readFile(configFile(), 'utf8');
    const all = JSON.parse(raw);
    if (all && typeof all === 'object' && all.payment && typeof all.payment === 'object') {
      parsed = all.payment;
    }
  } catch {
    /* file belum ada atau rusak -> pakai default */
  }

  return {
    ...DEFAULTS,
    ...parsed,
    mode: normalizeMode(parsed.mode),
    merchant_code: String(parsed.merchant_code ?? '').trim(),
    private_key: String(parsed.private_key ?? '').trim(),
    api_key: String(parsed.api_key ?? '').trim(),
    disabled_channels: Array.isArray(parsed.disabled_channels)
      ? parsed.disabled_channels.map((c) => String(c).trim()).filter(Boolean)
      : [],
  };
}

/**
 * Versi aman untuk dikirim ke dashboard: rahasia sudah bertopeng.
 *
 * @returns {Promise<object>}
 */
export async function getPaymentConfig() {
  const cfg = await getPaymentConfigInternal();
  const safe = { ...cfg };
  for (const field of SECRET_FIELDS) {
    safe[`${field}_masked`] = maskSecret(cfg[field]);
    safe[`${field}_set`] = Boolean(cfg[field]);
    delete safe[field];
  }
  safe.configured = isTripayConfigured(cfg);
  return safe;
}

/**
 * Simpan perubahan config.
 *
 * Aturan penting: field rahasia hanya ditimpa bila nilai yang dikirim
 * BUKAN string kosong dan BUKAN topeng. Ini mencegah dashboard yang hanya
 * menampilkan '••••1234' tanpa sengaja menimpa kunci asli dengan topengnya.
 *
 * @param {object} patch
 * @returns {Promise<object>} config aman (bertopeng)
 */
export async function setPaymentConfig(patch = {}) {
  const current = await getPaymentConfigInternal();
  const next = { ...current };

  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.mode !== undefined) next.mode = normalizeMode(patch.mode);
  if (patch.merchant_code !== undefined) {
    next.merchant_code = String(patch.merchant_code ?? '').trim();
  }
  if (patch.fee_customer_percent !== undefined) {
    const n = Number(patch.fee_customer_percent);
    next.fee_customer_percent = Number.isFinite(n) ? Math.min(Math.max(n, 0), 100) : 0;
  }
  if (patch.disabled_channels !== undefined) {
    next.disabled_channels = Array.isArray(patch.disabled_channels)
      ? patch.disabled_channels.map((c) => String(c).trim()).filter(Boolean)
      : [];
  }

  for (const field of SECRET_FIELDS) {
    const incoming = patch[field];
    if (incoming === undefined || incoming === null) continue;
    const value = String(incoming).trim();
    // Kosong atau masih topeng -> pertahankan nilai lama.
    if (!value || isMasked(value)) continue;
    next[field] = value;
  }

  // Tulis ke data/config.json tanpa mengganggu kunci lain (footer, dll).
  let all = {};
  try {
    const raw = await fs.readFile(configFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') all = parsed;
  } catch {
    /* mulai dari objek kosong */
  }

  all.payment = next;
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(configFile(), JSON.stringify(all, null, 2) + '\n', 'utf8');

  return getPaymentConfig();
}

/**
 * Apakah Tripay siap dipakai? Semua syarat harus terpenuhi.
 *
 * @param {object} [cfg] config internal; dibaca dari disk bila tidak diberi
 * @returns {boolean}
 */
export function isTripayConfigured(cfg) {
  if (!cfg) return false;
  return Boolean(
    cfg.enabled &&
      cfg.merchant_code &&
      cfg.private_key &&
      cfg.api_key &&
      PAYMENT_MODES.includes(cfg.mode),
  );
}

/**
 * Daftar alasan Tripay belum siap, untuk ditampilkan di dashboard.
 *
 * @returns {Promise<string[]>}
 */
export async function getPaymentConfigProblems() {
  const cfg = await getPaymentConfigInternal();
  const problems = [];
  if (!cfg.enabled) problems.push('Pembayaran otomatis masih dimatikan.');
  if (!cfg.merchant_code) problems.push('Merchant code Tripay belum diisi.');
  if (!cfg.private_key) problems.push('Private key Tripay belum diisi.');
  if (!cfg.api_key) problems.push('API key Tripay belum diisi.');
  return problems;
}
