/**
 * src/services/pricing.js
 * Mesin harga & validasi voucher.
 *
 * Fungsi di file ini MURNI (tidak menyentuh database) supaya bisa diuji
 * tanpa I/O dan supaya angka yang ditampilkan ke user bisa dihitung ulang
 * di server saat pembuatan transaksi — mencegah manipulasi harga dari sisi
 * klien.
 *
 * Urutan perhitungan (penting, jangan diubah tanpa menyesuaikan tes):
 *   1. base_amount     = monthly_price x months
 *   2. duration_disc   = diskon durasi dari paket (persen atau nominal)
 *   3. after_duration  = base_amount - duration_disc
 *   4. voucher_disc    = diskon voucher, dihitung dari after_duration
 *                        (bukan dari base_amount), dengan plafon opsional
 *   5. final_amount    = after_duration - voucher_disc, minimum 0
 *
 * Voucher dihitung SETELAH diskon durasi supaya voucher persen tidak
 * menumpuk di atas harga penuh — ini perilaku yang lazim dan mencegah
 * harga akhir jadi nol tanpa sengaja.
 */

import {
  DURATION_MONTHS,
  MIN_TRANSACTION_AMOUNT,
  normalizePlanSlug,
  isPaidPlan,
} from '../config/plans.js';
import { normalizeVoucherCode } from '../config/database.js';

/** Bulatkan ke rupiah utuh (tidak ada sen). */
export function roundRp(value) {
  const n = Math.round(Number(value) || 0);
  return n < 0 ? 0 : n;
}

/**
 * Hitung potongan diskon durasi.
 * @param {number} amount harga dasar
 * @param {{discount_type:'percent'|'fixed', discount_value:number}} duration
 * @returns {number} potongan dalam rupiah (tidak pernah melebihi amount)
 */
export function computeDurationDiscount(amount, duration) {
  const base = roundRp(amount);
  if (!duration) return 0;
  const value = Number(duration.discount_value) || 0;
  if (value <= 0) return 0;
  const cut =
    duration.discount_type === 'fixed' ? value : Math.floor((base * Math.min(value, 100)) / 100);
  return Math.min(base, roundRp(cut));
}

/**
 * Hitung potongan diskon voucher.
 *
 * @param {number} amount harga setelah diskon durasi
 * @param {object} voucher record voucher
 * @returns {number} potongan dalam rupiah
 */
export function computeVoucherDiscount(amount, voucher) {
  const base = roundRp(amount);
  if (!voucher) return 0;
  const value = Number(voucher.discount_value) || 0;
  if (value <= 0) return 0;

  let cut =
    voucher.discount_type === 'fixed' ? value : Math.floor((base * Math.min(value, 100)) / 100);

  const cap = voucher.max_discount_amount;
  if (cap !== null && cap !== undefined && Number.isFinite(Number(cap)) && Number(cap) >= 0) {
    cut = Math.min(cut, Number(cap));
  }
  return Math.min(base, roundRp(cut));
}

/**
 * Ambil definisi durasi dari record paket.
 * @param {object} plan
 * @param {number} months
 * @returns {{months:number, discount_type:string, discount_value:number}|null}
 */
export function getDurationOption(plan, months) {
  const m = Math.floor(Number(months));
  if (!DURATION_MONTHS.includes(m)) return null;
  const list = Array.isArray(plan?.durations) ? plan.durations : [];
  const found = list.find((d) => Number(d.months) === m);
  if (found) return found;
  // Durasi 1 bulan selalu tersedia walau admin menghapusnya dari daftar.
  if (m === 1) return { months: 1, discount_type: 'percent', discount_value: 0 };
  return null;
}

/**
 * Hitung rincian harga lengkap.
 *
 * @param {object} args
 * @param {object} args.plan record paket
 * @param {number} args.months durasi dalam bulan
 * @param {object|null} [args.voucher] record voucher yang sudah lolos validasi
 * @returns {{base_amount:number, duration_discount_amount:number, subtotal:number,
 *   voucher_discount_amount:number, final_amount:number, months:number,
 *   monthly_price:number, duration:object|null}}
 */
export function calculatePrice({ plan, months, voucher = null }) {
  const m = Math.floor(Number(months)) || 1;
  const monthly = roundRp(plan?.monthly_price);
  const duration = getDurationOption(plan, m);

  const baseAmount = roundRp(monthly * m);
  const durationDiscount = computeDurationDiscount(baseAmount, duration);
  const subtotal = Math.max(0, baseAmount - durationDiscount);
  const voucherDiscount = computeVoucherDiscount(subtotal, voucher);
  const finalAmount = Math.max(0, subtotal - voucherDiscount);

  return {
    months: m,
    monthly_price: monthly,
    base_amount: baseAmount,
    duration: duration
      ? {
          months: duration.months,
          discount_type: duration.discount_type,
          discount_value: Number(duration.discount_value) || 0,
        }
      : null,
    duration_discount_amount: durationDiscount,
    subtotal,
    voucher_discount_amount: voucherDiscount,
    final_amount: finalAmount,
  };
}

/**
 * Validasi voucher terhadap konteks pembelian.
 *
 * Fungsi ini MURNI: tidak menulis dan tidak menaikkan `used_count`.
 * Pemakaian dicatat terpisah lewat `redeemVoucher()` saat pembayaran lunas.
 *
 * @param {object} args
 * @param {object|null} args.voucher record voucher (null = tidak ada)
 * @param {string} args.planSlug paket yang dibeli
 * @param {number} args.months durasi
 * @param {number} args.amount harga setelah diskon durasi (untuk cek minimum)
 * @param {number} [args.userUsage] berapa kali user ini sudah memakai kode tsb
 * @param {Date} [args.now] waktu acuan (memudahkan tes)
 * @returns {{valid:boolean, reason?:string, code?:string}}
 */
export function validateVoucher({
  voucher,
  planSlug,
  months,
  amount,
  userUsage = 0,
  now = new Date(),
}) {
  if (!voucher) return { valid: false, reason: 'Kode voucher tidak ditemukan.' };

  const code = normalizeVoucherCode(voucher.code);
  if (voucher.is_active === false) {
    return { valid: false, reason: 'Kode voucher sudah tidak aktif.', code };
  }

  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();

  if (voucher.starts_at) {
    const s = new Date(voucher.starts_at).getTime();
    if (!Number.isNaN(s) && t < s) {
      return { valid: false, reason: 'Kode voucher belum berlaku.', code };
    }
  }
  if (voucher.expires_at) {
    const e = new Date(voucher.expires_at).getTime();
    if (!Number.isNaN(e) && t > e) {
      return { valid: false, reason: 'Kode voucher sudah kedaluwarsa.', code };
    }
  }

  if (voucher.quota !== null && voucher.quota !== undefined) {
    if ((Number(voucher.used_count) || 0) >= Number(voucher.quota)) {
      return { valid: false, reason: 'Kuota voucher sudah habis.', code };
    }
  }

  const maxPerUser = Math.max(1, Math.floor(Number(voucher.max_per_user) || 1));
  if (Number(userUsage) >= maxPerUser) {
    return {
      valid: false,
      reason: `Kode voucher ini hanya bisa dipakai ${maxPerUser}x per akun.`,
      code,
    };
  }

  const slug = normalizePlanSlug(planSlug);
  const plans = Array.isArray(voucher.applicable_plans) ? voucher.applicable_plans : [];
  if (plans.length > 0 && !plans.map((p) => normalizePlanSlug(p)).includes(slug)) {
    return { valid: false, reason: `Voucher tidak berlaku untuk paket ${slug}.`, code };
  }

  const durations = Array.isArray(voucher.applicable_durations) ? voucher.applicable_durations : [];
  if (durations.length > 0 && !durations.map(Number).includes(Math.floor(Number(months)))) {
    return { valid: false, reason: 'Voucher tidak berlaku untuk durasi ini.', code };
  }

  const min = Number(voucher.min_transaction_amount) || 0;
  if (min > 0 && roundRp(amount) < min) {
    return {
      valid: false,
      reason: `Minimal transaksi untuk voucher ini Rp ${min.toLocaleString('id-ID')}.`,
      code,
    };
  }

  const discount = computeVoucherDiscount(amount, voucher);
  if (discount <= 0) {
    return { valid: false, reason: 'Voucher tidak menghasilkan potongan harga.', code };
  }

  return { valid: true, code };
}

/**
 * Validasi seluruh permintaan checkout dan hitung harga akhirnya.
 * Satu pintu masuk supaya route tidak pernah menghitung harga sendiri.
 *
 * @param {object} args
 * @param {object} args.plan record paket dari DB
 * @param {number} args.months
 * @param {object|null} [args.voucher]
 * @param {number} [args.userUsage]
 * @param {Date} [args.now]
 * @returns {{ok:boolean, reason?:string, pricing?:object, voucher?:object|null}}
 */
export function buildCheckoutQuote({
  plan,
  months,
  voucher = null,
  userUsage = 0,
  now = new Date(),
}) {
  if (!plan) return { ok: false, reason: 'Paket tidak ditemukan.' };
  if (plan.is_active === false) return { ok: false, reason: 'Paket sedang tidak dijual.' };
  if (!isPaidPlan(plan.slug)) return { ok: false, reason: 'Paket gratis tidak perlu dibeli.' };

  const m = Math.floor(Number(months));
  if (!DURATION_MONTHS.includes(m)) {
    return { ok: false, reason: `Durasi harus salah satu dari: ${DURATION_MONTHS.join(', ')} bulan.` };
  }

  // Hitung dulu TANPA voucher untuk mendapat `subtotal`, karena validasi
  // voucher butuh angka setelah diskon durasi.
  const withoutVoucher = calculatePrice({ plan, months: m });
  if (withoutVoucher.subtotal <= 0) {
    return { ok: false, reason: 'Paket ini tidak memiliki harga.' };
  }

  let appliedVoucher = null;
  if (voucher) {
    const check = validateVoucher({
      voucher,
      planSlug: plan.slug,
      months: m,
      amount: withoutVoucher.subtotal,
      userUsage,
      now,
    });
    if (!check.valid) return { ok: false, reason: check.reason };
    appliedVoucher = voucher;
  }

  const pricing = calculatePrice({ plan, months: m, voucher: appliedVoucher });

  if (pricing.final_amount < MIN_TRANSACTION_AMOUNT) {
    return {
      ok: false,
      reason: `Total pembayaran minimal Rp ${MIN_TRANSACTION_AMOUNT.toLocaleString('id-ID')}.`,
    };
  }

  return { ok: true, pricing, voucher: appliedVoucher };
}

/**
 * Bentuk `merchant_ref` unik untuk Tripay.
 * Format: WAKE-<slug>-<yyyymmdd>-<6 hex> — mudah dibaca saat rekonsiliasi.
 * @param {string} planSlug
 * @param {Date} [now]
 * @returns {string}
 */
export function buildMerchantRef(planSlug, now = new Date()) {
  const slug = normalizePlanSlug(planSlug).toUpperCase();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = Math.random().toString(16).slice(2, 8).toUpperCase();
  return `WAKE-${slug}-${y}${mo}${d}-${rand}`;
}

/**
 * Ringkas harga semua paket berbayar untuk halaman Pricing.
 * @param {Array<object>} plans
 * @returns {Array<object>}
 */
export function buildPricingTable(plans) {
  return (plans || [])
    .filter((p) => isPaidPlan(p.slug) && p.is_active !== false)
    .map((p) => {
      const monthly = roundRp(p.monthly_price);
      const options = DURATION_MONTHS.map((m) => {
        const pricing = calculatePrice({ plan: p, months: m });
        const perMonth = m > 0 ? Math.round(pricing.final_amount / m) : monthly;
        return {
          months: m,
          base_amount: pricing.base_amount,
          discount_amount: pricing.duration_discount_amount,
          final_amount: pricing.final_amount,
          per_month: perMonth,
          savings: pricing.duration_discount_amount,
          discount_type: pricing.duration?.discount_type || 'percent',
          discount_value: pricing.duration?.discount_value || 0,
        };
      });
      return {
        slug: p.slug,
        label: p.label,
        monthly_price: monthly,
        benefits: Array.isArray(p.benefits) ? p.benefits : [],
        features: p.features || {},
        options,
      };
    });
}
