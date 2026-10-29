/**
 * ==========================================================================
 *  src/web/routes/pricing.js
 *  Halaman harga publik + alur checkout.
 *
 *  ATURAN YANG DIJAGA
 *
 *  1. Harga SELALU dihitung ulang di server lewat buildCheckoutQuote().
 *     Nominal dari client diabaikan sepenuhnya. Tanpa ini, user bisa
 *     mengubah total bayar dari DevTools.
 *
 *  2. Endpoint checkout dibatasi laju. Tanpa pembatasan, satu orang bisa
 *     membanjiri koleksi payments dan membuat Tripay menandai akun kita.
 *
 *  3. Jawaban tidak pernah memuat kredensial gateway.
 * ==========================================================================
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { getActivePlans, getPlanSummary } from '../../services/features.js';
import { buildPricingTable, buildCheckoutQuote } from '../../services/pricing.js';
import {
  attachTripayData,
  preparePayment,
  syncPaymentStatus,
} from '../../services/subscription.js';
import { createTripayTransaction, listPaymentChannels, TripayError } from '../../services/tripay.js';
import { getPaymentConfig, isTripayConfigured } from '../../config/paymentConfig.js';
import { getVoucher } from '../../config/database.js';
import { validateBody, schemas } from '../validate.js';

const router = Router();

/** Pembatasan laju untuk endpoint yang menulis data atau memanggil Tripay. */
const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Terlalu banyak percobaan checkout. Coba lagi nanti.' },
  },
});

/** Pembatasan laju untuk pengecekan status (dipanggil berkala oleh halaman). */
const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Terlalu sering memeriksa status.' },
  },
});

function fail(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

/**
 * GET /api/pricing
 * Tabel harga publik: paket aktif + opsi durasi + harga per bulan.
 * Tidak butuh login.
 */
router.get('/', async (req, res) => {
  try {
    const [plans, payment] = await Promise.all([getActivePlans(), getPaymentConfig()]);

    res.json({
      success: true,
      data: {
        plans: buildPricingTable(plans),
        payment_enabled: isTripayConfigured({
          enabled: payment.enabled,
          mode: payment.mode,
          merchant_code: payment.merchant_code,
          // Nilai bertopeng selalu truthy; dipakai hanya sebagai penanda "terisi".
          private_key: payment.private_key_set ? 'x' : '',
          api_key: payment.api_key_set ? 'x' : '',
        }),
      },
    });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * GET /api/pricing/channels
 * Daftar kanal pembayaran aktif. Butuh Tripay sudah dikonfigurasi.
 */
router.get('/channels', async (req, res) => {
  try {
    const channels = await listPaymentChannels();
    res.json({
      success: true,
      data: channels.map((c) => ({
        code: c.code,
        name: c.name,
        group: c.group,
        type: c.type,
        fee_merchant: c.total_fee?.merchant ?? c.fee_merchant ?? null,
        fee_customer: c.total_fee?.customer ?? c.fee_customer ?? null,
        logo: c.logo || null,
      })),
    });
  } catch (e) {
    if (e instanceof TripayError) return fail(res, e.status, e.code, e.message);
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * POST /api/pricing/quote
 * Hitung harga untuk kombinasi paket + durasi + voucher tanpa membuat
 * transaksi. Dipakai halaman checkout untuk menampilkan angka hidup.
 */
router.post('/quote', validateBody(schemas.pricingQuote), async (req, res) => {
  try {
    const { plan_slug, months, voucher_code } = req.body;

    const plans = await getActivePlans();
    const plan = plans.find((p) => p.slug === String(plan_slug).toLowerCase());
    if (!plan) return fail(res, 404, 'PLAN_NOT_FOUND', 'Paket tidak ditemukan.');

    let voucher = null;
    if (voucher_code) {
      voucher = await getVoucher(voucher_code);
      if (!voucher) return fail(res, 404, 'VOUCHER_NOT_FOUND', 'Kode voucher tidak ditemukan.');
    }

    const quote = buildCheckoutQuote({ plan, months, voucher });
    if (!quote.ok) return fail(res, 400, 'QUOTE_REJECTED', quote.reason);

    res.json({ success: true, data: quote });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * POST /api/pricing/checkout
 * Buat transaksi: hitung harga di server, simpan pembayaran, lalu minta
 * kanal pembayaran ke Tripay.
 */
router.post('/checkout', checkoutLimiter, validateBody(schemas.pricingCheckout), async (req, res) => {
  try {
    const { phone, plan_slug, months, voucher_code, method, name } = req.body;

    const prepared = await preparePayment({
      phone,
      planSlug: plan_slug,
      months,
      voucherCode: voucher_code || '',
      name: name || '',
    });
    if (!prepared.ok) return fail(res, 400, 'CHECKOUT_REJECTED', prepared.reason);

    // Tripay belum dikonfigurasi: transaksi tetap tersimpan sebagai UNPAID
    // supaya owner bisa menagih manual, tetapi tanpa instruksi bayar.
    if (!method) {
      return res.json({
        success: true,
        data: {
          merchant_ref: prepared.payment.merchant_ref,
          amount: prepared.payment.final_amount,
          pricing: prepared.quote.pricing,
          instruction: null,
          note: 'Metode pembayaran belum dipilih.',
        },
      });
    }

    let tripay;
    try {
      tripay = await createTripayTransaction({
        merchantRef: prepared.payment.merchant_ref,
        amount: prepared.payment.final_amount,
        method,
        customerName: name || phone,
        customerPhone: phone,
        items: [
          {
            sku: prepared.plan.slug,
            name: `${prepared.plan.label} ${months} bulan`,
            price: prepared.payment.final_amount,
            quantity: 1,
          },
        ],
      });
    } catch (e) {
      if (e instanceof TripayError) return fail(res, e.status, e.code, e.message);
      throw e;
    }

    await attachTripayData(prepared.payment.id, tripay);

    res.json({
      success: true,
      data: {
        merchant_ref: prepared.payment.merchant_ref,
        amount: prepared.payment.final_amount,
        pricing: prepared.quote.pricing,
        instruction: {
          reference: tripay.reference,
          method: tripay.payment_method,
          name: tripay.payment_name,
          pay_code: tripay.pay_code,
          pay_url: tripay.pay_url,
          qr_url: tripay.qr_url,
          qr_string: tripay.qr_string || null,
          checkout_url: tripay.checkout_url,
          expires_at: tripay.expired_time
            ? new Date(tripay.expired_time * 1000).toISOString()
            : null,
          instructions: Array.isArray(tripay.instructions) ? tripay.instructions : [],
        },
      },
    });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * GET /api/pricing/status/:ref
 * Status satu transaksi. Dipakai halaman checkout untuk polling.
 * Bila Tripay melaporkan PAID, aktivasi dijalankan di sini juga — berguna
 * saat webhook tidak sampai (server di balik firewall, dsb).
 */
router.get('/status/:ref', statusLimiter, async (req, res) => {
  try {
    const ref = String(req.params.ref || '').trim();
    if (!ref) return fail(res, 400, 'BAD_REQUEST', 'Referensi transaksi kosong.');

    const result = await syncPaymentStatus(ref);
    if (!result.payment) return fail(res, 404, 'PAYMENT_NOT_FOUND', result.reason || 'Transaksi tidak ditemukan.');

    const p = result.payment;
    // Instruksi bayar ikut dikirim supaya halaman /pembayaran/:ref bisa
    // menampilkan kode bayar/QR tanpa permintaan kedua. Field-nya tersimpan
    // flat di record pembayaran (lihat attachTripayData di subscription.js).
    const hasInstruction = Boolean(p.pay_code || p.pay_url || p.qr_url || p.checkout_url);
    res.json({
      success: true,
      data: {
        merchant_ref: p.merchant_ref,
        status: p.status,
        amount: p.final_amount,
        plan_slug: p.plan_slug,
        duration_months: p.duration_months,
        paid_at: p.paid_at,
        activated: Boolean(result.ok && !result.alreadyPaid),
        note: result.reason || null,
        instruction: hasInstruction
          ? {
              reference: p.tripay_reference || null,
              method: p.payment_method || null,
              name: p.payment_name || null,
              pay_code: p.pay_code || null,
              pay_url: p.pay_url || null,
              qr_url: p.qr_url || null,
              checkout_url: p.checkout_url || null,
            }
          : null,
      },
    });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * GET /api/pricing/me?phone=...
 * Ringkasan langganan satu nomor, untuk halaman akun.
 */
router.get('/me', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').trim();
    if (!phone) return fail(res, 400, 'BAD_REQUEST', 'Parameter phone wajib diisi.');

    const summary = await getPlanSummary(phone);
    if (!summary) return fail(res, 404, 'USER_NOT_FOUND', 'Nomor belum terdaftar.');

    res.json({ success: true, data: summary });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

export default router;
