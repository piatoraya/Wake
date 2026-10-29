/**
 * ==========================================================================
 *  src/services/tripay.js
 *  Klien API Tripay + verifikasi tanda tangan callback.
 *
 *  ATURAN KEAMANAN YANG DIJAGA FILE INI
 *
 *  1. Callback webhook HANYA dipercaya setelah tanda tangan HMAC-SHA256
 *     diverifikasi memakai private key. Tanpa ini, siapa pun yang tahu URL
 *     webhook bisa mengirim "pembayaran lunas" palsu dan mendapat paket
 *     berbayar gratis.
 *
 *  2. Perbandingan tanda tangan memakai timingSafeEqual, bukan ===. String
 *     compare biasa membocorkan panjang prefix yang cocok lewat waktu respons.
 *
 *  3. Verifikasi butuh RAW BODY. Server memakai express.json() yang
 *     menghancurkan byte asli, jadi route webhook harus memasang
 *     `rawBodySaver` SEBELUM express.json(). Middleware itu diekspor di sini.
 *
 *  4. Semua permintaan keluar diberi timeout. Tanpa timeout, Tripay yang
 *     lambat akan menggantung request Express sampai worker habis.
 * ==========================================================================
 */
import crypto from 'node:crypto';

import {
  getPaymentConfigInternal,
  isTripayConfigured,
  resolveTripayBaseUrl,
} from '../config/paymentConfig.js';

/** Nama header tanda tangan callback Tripay. */
export const SIGNATURE_HEADER = 'x-callback-signature';

/** Batas waktu permintaan ke Tripay (ms). */
const REQUEST_TIMEOUT_MS = 15000;

/** Berapa lama daftar kanal bayar di-cache (ms). */
const CHANNEL_CACHE_MS = 10 * 60 * 1000;

let channelCache = { at: 0, data: null };

/**
 * Error khusus Tripay supaya route bisa membedakan kegagalan gateway dari
 * bug internal tanpa mencocokkan teks pesan.
 */
export class TripayError extends Error {
  /**
   * @param {string} message pesan siap tampil (Bahasa Indonesia)
   * @param {{ code?: string, status?: number, detail?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'TripayError';
    this.code = meta.code || 'TRIPAY_ERROR';
    this.status = meta.status || 502;
    this.detail = meta.detail ?? null;
  }
}

/**
 * Tanda tangan permintaan pembuatan transaksi Tripay.
 *
 * Rumus resmi: HMAC-SHA256(merchant_code + merchant_ref + amount, private_key)
 * dalam bentuk hex. Amount HARUS bilangan bulat tanpa pemisah ribuan —
 * "474000", bukan "474.000" atau "474000.0".
 *
 * @param {object} params
 * @param {string} params.merchantCode
 * @param {string} params.merchantRef
 * @param {number|string} params.amount
 * @param {string} params.privateKey
 * @returns {string} hex
 */
export function tripaySignature({ merchantCode, merchantRef, amount, privateKey }) {
  const payload = `${merchantCode}${merchantRef}${normalizeAmount(amount)}`;
  return crypto.createHmac('sha256', String(privateKey ?? '')).update(payload).digest('hex');
}

/**
 * Bandingkan dua tanda tangan tanpa membocorkan waktu.
 * Panjang berbeda langsung dianggap tidak cocok (panjang hex bukan rahasia).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeCompare(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  if (left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Amount Tripay: bilangan bulat, tanpa desimal.
 * @param {number|string} value
 * @returns {string}
 */
export function normalizeAmount(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return '0';
  return String(n);
}

/**
 * Middleware penyimpan raw body.
 *
 * Panggil `app.use(rawBodySaver)` SEBELUM `express.json()`. Tanpa ini,
 * verifikasi tanda tangan callback selalu gagal karena body sudah di-parse
 * ulang dan urutan key/whitespace-nya berubah.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 */
export function rawBodySaver(req, res, next) {
  if (req.path && !req.path.startsWith('/api/webhook')) return next();
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    req.rawBody = buf.length ? buf.toString('utf8') : '';
    next();
  });
  req.on('error', next);
}

/**
 * Ambil kredensial siap pakai, atau lempar bila belum lengkap.
 * @returns {Promise<object>}
 */
async function requireConfig() {
  const cfg = await getPaymentConfigInternal();
  if (!isTripayConfigured(cfg)) {
    throw new TripayError('Pembayaran otomatis belum dikonfigurasi.', {
      code: 'TRIPAY_NOT_CONFIGURED',
      status: 503,
    });
  }
  return cfg;
}

/**
 * Panggil API Tripay dengan timeout dan penanganan error yang seragam.
 *
 * @param {string} pathname contoh '/transaction/create'
 * @param {{ method?: string, body?: object, cfg: object }} options
 * @returns {Promise<object>} isi `data` dari respons
 */
async function tripayFetch(pathname, { method = 'GET', body, cfg } = {}) {
  const url = `${resolveTripayBaseUrl(cfg.mode)}${pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.api_key}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new TripayError('Tripay tidak merespons (timeout). Coba lagi.', {
        code: 'TRIPAY_TIMEOUT',
        status: 504,
      });
    }
    throw new TripayError('Gagal menghubungi Tripay. Periksa koneksi server.', {
      code: 'TRIPAY_UNREACHABLE',
      status: 502,
      detail: e?.message,
    });
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* respons bukan JSON (mis. halaman error HTML dari proxy) */
  }

  if (!res.ok || !payload || payload.success === false) {
    const detail = payload?.message || `HTTP ${res.status}`;
    throw new TripayError(`Tripay menolak permintaan: ${detail}`, {
      code: 'TRIPAY_REJECTED',
      status: res.status === 401 || res.status === 403 ? 502 : 400,
      detail: payload,
    });
  }

  return payload.data;
}

/**
 * Buat transaksi di Tripay.
 *
 * @param {object} params
 * @param {string} params.merchantRef referensi unik kita (WAKE-PRO-...)
 * @param {number} params.amount total akhir yang harus dibayar
 * @param {string} params.method kode kanal, mis. 'QRIS'
 * @param {string} [params.customerName]
 * @param {string} [params.customerPhone]
 * @param {Array<{name: string, price: number, quantity: number}>} [params.items]
 * @param {number} [params.expiredMinutes] masa berlaku (menit)
 * @param {string} [params.returnUrl]
 * @returns {Promise<object>} data transaksi Tripay
 */
export async function createTripayTransaction({
  merchantRef,
  amount,
  method,
  customerName = '',
  customerPhone = '',
  items = [],
  expiredMinutes = 60,
  returnUrl = '',
} = {}) {
  const cfg = await requireConfig();

  if (!merchantRef) {
    throw new TripayError('Referensi transaksi wajib diisi.', { code: 'TRIPAY_BAD_REQUEST', status: 400 });
  }
  if (!method) {
    throw new TripayError('Metode pembayaran wajib dipilih.', {
      code: 'TRIPAY_BAD_REQUEST',
      status: 400,
    });
  }

  const amountStr = normalizeAmount(amount);
  if (amountStr === '0') {
    throw new TripayError('Nominal pembayaran tidak sah.', {
      code: 'TRIPAY_BAD_REQUEST',
      status: 400,
    });
  }

  const body = {
    method,
    merchant_ref: merchantRef,
    amount: Number(amountStr),
    customer_name: String(customerName || 'Pengguna Wake').slice(0, 100),
    customer_email: '',
    customer_phone: String(customerPhone || '').slice(0, 20),
    order_items: (items.length ? items : [{ name: 'Langganan Wake', price: Number(amountStr), quantity: 1 }]).map(
      (it) => ({
        sku: String(it.sku || 'WAKE').slice(0, 50),
        name: String(it.name || 'Langganan Wake').slice(0, 100),
        price: Math.round(Number(it.price) || 0),
        quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
      }),
    ),
    callback_url: '',
    return_url: String(returnUrl || ''),
    expired_time: Math.floor(Date.now() / 1000) + Math.max(5, Number(expiredMinutes) || 60) * 60,
    signature: tripaySignature({
      merchantCode: cfg.merchant_code,
      merchantRef,
      amount: amountStr,
      privateKey: cfg.private_key,
    }),
  };

  return tripayFetch('/transaction/create', { method: 'POST', body, cfg });
}

/**
 * Detail transaksi menurut referensi merchant kita.
 * @param {string} merchantRef
 * @returns {Promise<object>}
 */
export async function getTripayTransactionDetail(merchantRef) {
  const cfg = await requireConfig();
  return tripayFetch(`/transaction/detail?reference=&merchant_ref=${encodeURIComponent(merchantRef)}`, {
    cfg,
  });
}

/**
 * Daftar kanal pembayaran aktif, di-cache 10 menit.
 *
 * @param {{ force?: boolean, cfg?: object }} [options]
 * @returns {Promise<Array<object>>}
 */
export async function listPaymentChannels({ force = false, cfg } = {}) {
  const now = Date.now();
  if (!force && channelCache.data && now - channelCache.at < CHANNEL_CACHE_MS) {
    return channelCache.data;
  }

  const config = cfg || (await requireConfig());
  const data = await tripayFetch('/payment/channel', { cfg: config });
  const channels = Array.isArray(data) ? data : [];

  // Sembunyikan kanal yang dimatikan owner.
  const disabled = new Set(config.disabled_channels || []);
  const filtered = channels.filter((c) => !disabled.has(c.code));

  channelCache = { at: now, data: filtered };
  return filtered;
}

/** Kosongkan cache kanal (dipakai setelah owner mengubah daftar kanal). */
export function clearChannelCache() {
  channelCache = { at: 0, data: null };
}

/**
 * Verifikasi tanda tangan callback Tripay.
 *
 * Rumus resmi: HMAC-SHA256(raw_body, private_key) hex.
 *
 * @param {object} params
 * @param {string} params.rawBody body mentah persis seperti diterima
 * @param {string} params.signature nilai header X-Callback-Signature
 * @param {object} [params.cfg] config internal; dibaca dari disk bila kosong
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
export async function verifyTripayCallback({ rawBody, signature, cfg } = {}) {
  if (!rawBody || typeof rawBody !== 'string') {
    return { valid: false, reason: 'Body callback kosong.' };
  }
  if (!signature) {
    return { valid: false, reason: 'Header tanda tangan tidak ada.' };
  }

  const config = cfg || (await getPaymentConfigInternal());
  if (!config.private_key) {
    return { valid: false, reason: 'Private key Tripay belum diatur.' };
  }

  const expected = crypto
    .createHmac('sha256', config.private_key)
    .update(rawBody)
    .digest('hex');

  if (!safeCompare(expected, String(signature).trim())) {
    return { valid: false, reason: 'Tanda tangan callback tidak cocok.' };
  }

  return { valid: true };
}

/**
 * Terjemahkan status pembayaran Tripay ke status internal kita.
 *
 * @param {string} tripayStatus
 * @returns {'PAID'|'EXPIRED'|'FAILED'|'UNPAID'}
 */
export function mapTripayStatus(tripayStatus) {
  switch (String(tripayStatus || '').toUpperCase()) {
    case 'PAID':
      return 'PAID';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'FAILED':
      return 'FAILED';
    case 'REFUND':
      return 'FAILED';
    default:
      return 'UNPAID';
  }
}

/**
 * Ringkas data callback Tripay menjadi bentuk yang kita butuhkan.
 * Field yang tidak ada tetap `null` agar pemanggil bisa membedakan
 * "tidak dikirim" dari "dikirim kosong".
 *
 * @param {object} payload body callback ter-parse
 * @returns {object}
 */
export function parseTripayCallback(payload = {}) {
  const amount = Number(payload.total_amount ?? payload.amount ?? 0);
  return {
    merchantRef: payload.merchant_ref ? String(payload.merchant_ref) : null,
    reference: payload.reference ? String(payload.reference) : null,
    status: mapTripayStatus(payload.status),
    rawStatus: payload.status ? String(payload.status) : null,
    amount: Number.isFinite(amount) ? Math.round(amount) : 0,
    method: payload.payment_method ? String(payload.payment_method) : null,
    paymentName: payload.payment_name ? String(payload.payment_name) : null,
    payCode: payload.pay_code ? String(payload.pay_code) : null,
    paidAt: payload.paid_at ? String(payload.paid_at) : null,
    isClosed: Boolean(payload.is_closed),
    isRefund: Boolean(payload.is_refund),
  };
}
