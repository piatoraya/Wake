/**
 * ==========================================================================
 *  src/services/subscription.js
 *  Aktivasi paket setelah pembayaran lunas + penyapuan masa aktif habis.
 *
 *  KENAPA FILE INI ADA
 *  Webhook gateway pembayaran TIDAK PERNAH dikirim tepat sekali. Tripay
 *  mengirim ulang callback yang sama bila server kita lambat membalas, dan
 *  owner bisa memicu "cek status" manual dari dashboard. Semua jalur itu
 *  berakhir di activatePayment().
 *
 *  Karena itu aktivasi WAJIB idempoten:
 *    - klaim transaksi UNPAID -> PAID dilakukan secara atomik di
 *      markPaymentPaid(); hanya SATU pemanggil yang berhasil.
 *    - pemanggil yang kalah (alreadyPaid) langsung berhenti dan TIDAK
 *      memperpanjang masa aktif.
 *
 *  Tanpa penjaga ini, satu pembayaran 6 bulan bisa menjadi 12 bulan atau
 *  lebih hanya karena callback dikirim ulang.
 * ==========================================================================
 */
import {
  countVoucherUsageByUser,
  createPayment,
  downgradeToFree,
  extendUserPlan,
  findExpiredPlanUsers,
  getPaymentByRef,
  getPlan,
  getUser,
  listPayments,
  markPaymentPaid,
  redeemVoucher,
  setUserPlan,
  updatePayment,
  upsertUser,
} from '../config/database.js';
import { isPaidPlan, normalizePlanSlug, planLabel } from '../config/plans.js';
import { buildCheckoutQuote, buildMerchantRef } from './pricing.js';
import { getPlanSummary } from './features.js';

/** Alias supaya pemanggil bisa memakai nama yang lebih deskriptif. */
export { getPlanSummary as getSubscriptionStatus };

/** Status pembayaran yang dianggap sudah final dan tidak boleh diubah lagi. */
const FINAL_STATUSES = ['PAID', 'EXPIRED', 'FAILED'];

/**
 * Siapkan pembayaran baru + hitung harga di server.
 *
 * Angka apa pun yang dikirim client DIABAIKAN. Harga selalu dihitung ulang
 * dari paket di database supaya user tidak bisa mengubah total bayar.
 *
 * @param {object} params
 * @param {string} params.phone nomor WhatsApp user
 * @param {string} params.planSlug
 * @param {number} params.months
 * @param {string} [params.voucherCode]
 * @param {string} [params.name]
 * @returns {Promise<{ ok: boolean, reason?: string, payment?: object, quote?: object }>}
 */
export async function preparePayment({ phone, planSlug, months, voucherCode = '', name = '' } = {}) {
  const normalizedPhone = String(phone || '').trim();
  if (!normalizedPhone) return { ok: false, reason: 'Nomor WhatsApp wajib diisi.' };

  const plan = await getPlan(planSlug);
  if (!plan) return { ok: false, reason: 'Paket tidak ditemukan.' };

  let voucher = null;
  const code = String(voucherCode || '').trim();
  if (code) {
    const { getVoucher } = await import('../config/database.js');
    voucher = await getVoucher(code);
    if (!voucher) return { ok: false, reason: 'Kode voucher tidak ditemukan.' };
  }

  const monthsNumber = Math.max(1, Math.floor(Number(months) || 1));
  const userUsage = voucher ? await countVoucherUsageByUser(normalizedPhone, voucher.code) : 0;

  const quote = buildCheckoutQuote({
    plan,
    months: monthsNumber,
    voucher,
    userUsage,
  });
  if (!quote.ok) return { ok: false, reason: quote.reason };

  await upsertUser(normalizedPhone, name || normalizedPhone);

  const merchantRef = buildMerchantRef(plan.slug);
  const payment = await createPayment({
    merchant_ref: merchantRef,
    user_phone: normalizedPhone,
    plan_slug: plan.slug,
    duration_months: monthsNumber,
    base_amount: quote.pricing.base_amount,
    duration_discount_amount: quote.pricing.duration_discount_amount,
    voucher_code: quote.voucher?.code || null,
    voucher_discount_amount: quote.pricing.voucher_discount_amount,
    final_amount: quote.pricing.final_amount,
  });

  return { ok: true, payment, quote, plan };
}

/**
 * Lampirkan detail transaksi Tripay ke record pembayaran.
 *
 * @param {string} paymentId
 * @param {object} tripayData respons /transaction/create
 * @returns {Promise<object|null>}
 */
export async function attachTripayData(paymentId, tripayData = {}) {
  return updatePayment(paymentId, {
    tripay_reference: tripayData.reference || null,
    payment_method: tripayData.payment_method || null,
    payment_name: tripayData.payment_name || null,
    pay_code: tripayData.pay_code || null,
    pay_url: tripayData.pay_url || null,
    qr_url: tripayData.qr_url || null,
    checkout_url: tripayData.checkout_url || null,
  });
}

/**
 * Aktivasi paket setelah pembayaran lunas. IDEMPOTEN.
 *
 * Urutan yang dijaga:
 *   1. klaim transaksi (atomik) — kalah berarti sudah pernah diproses, stop
 *   2. perpanjang masa aktif user
 *   3. tandai voucher terpakai (kuota)
 *   4. catat jejak di record pembayaran
 *
 * Langkah 2-4 hanya berjalan untuk pemanggil yang MENANG di langkah 1,
 * sehingga tidak mungkin terjadi perpanjangan ganda.
 *
 * @param {object} params
 * @param {string} params.merchantRef
 * @param {number} [params.amount] nominal yang benar-benar dibayar
 * @param {string} [params.tripayReference]
 * @param {string} [params.paidAt]
 * @returns {Promise<{
 *   ok: boolean, alreadyPaid?: boolean, reason?: string,
 *   payment?: object, user?: object, months?: number, expiresAt?: string
 * }>}
 */
export async function activatePayment({
  merchantRef,
  amount = null,
  tripayReference = null,
  paidAt = null,
} = {}) {
  const ref = String(merchantRef || '').trim();
  if (!ref) return { ok: false, reason: 'Referensi transaksi kosong.' };

  const existing = await getPaymentByRef(ref);
  if (!existing) return { ok: false, reason: 'Transaksi tidak ditemukan.' };

  // Transaksi yang sudah final tidak boleh diaktifkan ulang.
  if (existing.status === 'PAID') {
    return { ok: false, alreadyPaid: true, payment: existing };
  }
  if (existing.status === 'EXPIRED' || existing.status === 'FAILED') {
    return { ok: false, reason: `Transaksi sudah berstatus ${existing.status}.`, payment: existing };
  }

  // Nominal callback harus cocok. Selisih = indikasi callback dipalsukan
  // atau transaksi tertukar, jadi jangan diaktifkan.
  if (amount !== null && amount !== undefined) {
    const paid = Math.round(Number(amount) || 0);
    if (paid !== existing.final_amount) {
      return {
        ok: false,
        reason: `Nominal tidak cocok (dibayar ${paid}, tagihan ${existing.final_amount}).`,
        payment: existing,
      };
    }
  }

  // Langkah 1: klaim atomik. Hanya satu pemanggil yang lolos.
  const claim = await markPaymentPaid(ref, {
    tripay_reference: tripayReference || undefined,
    paid_at: paidAt || undefined,
  });
  if (!claim.ok) {
    return {
      ok: false,
      alreadyPaid: Boolean(claim.alreadyPaid),
      reason: claim.alreadyPaid ? 'Pembayaran sudah pernah diproses.' : 'Gagal menandai pembayaran lunas.',
      payment: claim.payment || existing,
    };
  }

  const payment = claim.payment;
  const planSlug = normalizePlanSlug(payment.plan_slug);

  // Langkah 2: perpanjang masa aktif.
  let user = null;
  let expiresAt = null;
  if (isPaidPlan(planSlug)) {
    try {
      const extended = await extendUserPlan(payment.user_phone, planSlug, payment.duration_months);
      user = extended.user;
      expiresAt = extended.expiresAt;
    } catch (e) {
      // Paket sudah ditandai PAID; jangan batalkan. Catat supaya owner bisa
      // memperbaiki manual dari dashboard.
      console.error('[SUBSCRIPTION] gagal memperpanjang masa aktif:', e?.message);
      return {
        ok: false,
        reason: 'Pembayaran lunas tetapi masa aktif gagal diperpanjang. Hubungi owner.',
        payment,
      };
    }
  }

  // Langkah 3: pakai kuota voucher (sekali saja, karena hanya pemanggil
  // pemenang yang sampai ke sini).
  if (payment.voucher_code) {
    try {
      const redeemed = await redeemVoucher({
        code: payment.voucher_code,
        phone: payment.user_phone,
        paymentId: payment.id,
        amount: payment.voucher_discount_amount,
      });
      if (!redeemed.ok) {
        console.warn('[SUBSCRIPTION] voucher gagal dicatat:', redeemed.reason);
      }
    } catch (e) {
      console.error('[SUBSCRIPTION] error saat mencatat voucher:', e?.message);
    }
  }

  return {
    ok: true,
    payment,
    user,
    planSlug,
    months: payment.duration_months,
    expiresAt,
  };
}

/**
 * Cek status transaksi ke Tripay lalu aktifkan bila sudah lunas.
 * Dipakai halaman checkout untuk polling dan tombol "Cek Status".
 *
 * @param {string} merchantRef
 * @returns {Promise<object>}
 */
export async function syncPaymentStatus(merchantRef) {
  const payment = await getPaymentByRef(merchantRef);
  if (!payment) return { ok: false, reason: 'Transaksi tidak ditemukan.' };
  if (payment.status === 'PAID') return { ok: true, alreadyPaid: true, payment };

  const { getTripayTransactionDetail, mapTripayStatus } = await import('./tripay.js');

  let detail;
  try {
    detail = await getTripayTransactionDetail(merchantRef);
  } catch (e) {
    return { ok: false, reason: e?.message || 'Gagal memeriksa status ke Tripay.', payment };
  }

  const status = mapTripayStatus(detail?.status);

  if (status === 'PAID') {
    return activatePayment({
      merchantRef,
      amount: Number(detail.total_amount ?? detail.amount ?? 0) || null,
      tripayReference: detail.reference || null,
      paidAt: detail.paid_at || null,
    });
  }

  if (status === 'EXPIRED' || status === 'FAILED') {
    const updated = await updatePayment(payment.id, { status });
    return { ok: false, reason: `Transaksi berstatus ${status}.`, payment: updated || payment };
  }

  return { ok: false, reason: 'Pembayaran belum diterima.', payment };
}

/**
 * Turunkan semua user yang masa aktifnya sudah lewat ke paket gratis.
 *
 * Aman dipanggil berulang (cron): user yang sudah gratis tidak muncul lagi
 * di findExpiredPlanUsers().
 *
 * @returns {Promise<{ checked: number, downgraded: Array<{phone: string, from: string}> }>}
 */
export async function sweepExpiredPlans() {
  const expired = await findExpiredPlanUsers();
  const downgraded = [];

  for (const entry of expired) {
    try {
      const updated = await downgradeToFree(entry.phone);
      if (updated) {
        downgraded.push({ phone: entry.phone, from: entry.plan_slug });
      }
    } catch (e) {
      console.error(`[SUBSCRIPTION] gagal menurunkan ${entry.phone}:`, e?.message);
    }
  }

  if (downgraded.length) {
    console.log(`[SUBSCRIPTION] ${downgraded.length} paket kedaluwarsa diturunkan ke gratis.`);
  }

  return { checked: expired.length, downgraded };
}

/**
 * Ringkasan langganan satu user untuk dashboard & halaman checkout.
 *
 * @param {string} phone
 * @returns {Promise<object|null>}
 */
export async function getSubscriptionSummary(phone) {
  const user = await getUser(phone);
  if (!user) return null;

  const [status, plan, payments] = await Promise.all([
    getPlanSummary(phone),
    getPlan(user.plan_slug),
    listPayments({ phone }),
  ]);

  const paid = payments.filter((p) => p.status === 'PAID');
  const totalPaid = paid.reduce((sum, p) => sum + (p.final_amount || 0), 0);

  return {
    ...status,
    // `getPlanSummary` memakai nama `slug`; samakan dengan nama kolom user
    // supaya pemanggil (route & view) tidak perlu tahu perbedaannya.
    plan_slug: status?.slug || user.plan_slug,
    plan_label: planLabel(user.plan_slug),
    plan,
    total_paid: totalPaid,
    payment_count: payments.length,
    last_payment: payments[0] || null,
  };
}

/**
 * Ubah paket user secara manual dari dashboard owner.
 *
 * Dipakai untuk kasus di luar alur pembayaran: kompensasi, hadiah, atau
 * perbaikan setelah aktivasi otomatis gagal.
 *
 * @param {object} params
 * @param {string} params.phone
 * @param {string} params.planSlug
 * @param {number} [params.months] 0 = turunkan ke gratis
 * @returns {Promise<{ ok: boolean, reason?: string, user?: object }>}
 */
export async function setUserPlanManually({ phone, planSlug, months = 0 } = {}) {
  const normalizedPhone = String(phone || '').trim();
  if (!normalizedPhone) return { ok: false, reason: 'Nomor wajib diisi.' };

  const user = await getUser(normalizedPhone);
  if (!user) return { ok: false, reason: 'User tidak ditemukan.' };

  const slug = normalizePlanSlug(planSlug);

  if (!isPaidPlan(slug)) {
    const updated = await downgradeToFree(normalizedPhone);
    return { ok: true, user: updated };
  }

  const count = Math.max(1, Math.floor(Number(months) || 1));
  try {
    const result = await extendUserPlan(normalizedPhone, slug, count);
    return { ok: true, user: result.user, expiresAt: result.expiresAt };
  } catch (e) {
    return { ok: false, reason: e?.message || 'Gagal mengubah paket.' };
  }
}

/**
 * Setel ulang masa aktif ke tanggal tertentu (koreksi manual).
 *
 * @param {object} params
 * @param {string} params.phone
 * @param {string} params.planSlug
 * @param {string|null} params.expiresAt ISO date
 * @returns {Promise<{ ok: boolean, reason?: string, user?: object }>}
 */
export async function overrideUserPlan({ phone, planSlug, expiresAt = null } = {}) {
  const normalizedPhone = String(phone || '').trim();
  if (!normalizedPhone) return { ok: false, reason: 'Nomor wajib diisi.' };

  const user = await getUser(normalizedPhone);
  if (!user) return { ok: false, reason: 'User tidak ditemukan.' };

  const slug = normalizePlanSlug(planSlug);
  const updated = await setUserPlan(normalizedPhone, slug, isPaidPlan(slug) ? expiresAt : null);
  return { ok: true, user: updated };
}

/** Apakah status pembayaran sudah final? */
export function isFinalStatus(status) {
  return FINAL_STATUSES.includes(String(status || '').toUpperCase());
}
