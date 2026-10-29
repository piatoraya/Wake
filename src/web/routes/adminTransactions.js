/**
 * ==========================================================================
 *  src/web/routes/adminTransactions.js
 *  Riwayat pembayaran + koreksi paket manual.
 *
 *  Hanya owner/admin. Bagian "koreksi manual" penting untuk kasus di luar
 *  alur normal: pembayaran via transfer bank langsung, kompensasi karena
 *  gangguan, atau memperbaiki aktivasi otomatis yang gagal.
 * ==========================================================================
 */
import { Router } from 'express';

import { authMiddleware, requireRole } from '../auth.js';
import { addAuditLog } from '../audit.js';
import { validateBody, schemas } from '../validate.js';
import {
  getPaymentByRef,
  getUser,
  listPayments,
  updatePayment,
} from '../../config/database.js';
import { planLabel } from '../../config/plans.js';
import {
  activatePayment,
  overrideUserPlan,
  setUserPlanManually,
  sweepExpiredPlans,
  syncPaymentStatus,
} from '../../services/subscription.js';

const router = Router();
router.use(authMiddleware);
router.use(requireRole('owner', 'admin'));

const VALID_STATUSES = ['UNPAID', 'PAID', 'EXPIRED', 'FAILED'];

function fail(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

/**
 * GET /api/admin-transactions
 * Riwayat pembayaran, terbaru dulu.
 *
 * Query: phone, status, limit (default 100, maks 500), offset
 */
router.get('/', async (req, res) => {
  try {
    const phone = req.query.phone ? String(req.query.phone).trim() : null;
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;

    if (status && !VALID_STATUSES.includes(status)) {
      return fail(res, 400, 'BAD_STATUS', `Status tidak dikenal: ${status}`);
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const all = await listPayments({ phone, status });

    // Ringkasan dihitung dari SELURUH hasil filter, bukan hanya halaman ini,
    // supaya angka pendapatan tidak menyesatkan saat data dipaginasi.
    const paid = all.filter((p) => p.status === 'PAID');
    const summary = {
      total: all.length,
      paid_count: paid.length,
      unpaid_count: all.filter((p) => p.status === 'UNPAID').length,
      expired_count: all.filter((p) => p.status === 'EXPIRED').length,
      failed_count: all.filter((p) => p.status === 'FAILED').length,
      revenue: paid.reduce((sum, p) => sum + (p.final_amount || 0), 0),
      discount_given: paid.reduce(
        (sum, p) => sum + (p.duration_discount_amount || 0) + (p.voucher_discount_amount || 0),
        0,
      ),
    };

    res.json({
      success: true,
      data: {
        payments: all.slice(offset, offset + limit),
        summary,
        pagination: { total: all.length, limit, offset },
      },
    });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * POST /api/admin-transactions/sweep
 * Turunkan semua paket yang sudah kedaluwarsa ke gratis.
 * Juga dipanggil otomatis oleh cron di index.js.
 */
router.post('/sweep', async (req, res) => {
  try {
    const result = await sweepExpiredPlans();

    if (result.downgraded.length) {
      await addAuditLog({
        adminId: req.user?.sub || null,
        action: 'sweep',
        entity: 'users',
        entityId: null,
        after: result,
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
      });
    }

    res.json({ success: true, data: result });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * GET /api/admin-transactions/:ref
 * Detail satu transaksi + data user pemiliknya.
 */
router.get('/:ref', async (req, res) => {
  try {
    const payment = await getPaymentByRef(req.params.ref);
    if (!payment) return fail(res, 404, 'PAYMENT_NOT_FOUND', 'Transaksi tidak ditemukan.');

    const user = await getUser(payment.user_phone);

    res.json({
      success: true,
      data: {
        payment,
        user: user
          ? {
              phone: user.phone,
              name: user.name,
              plan_slug: user.plan_slug,
              plan_label: planLabel(user.plan_slug),
              plan_expires_at: user.plan_expires_at,
            }
          : null,
      },
    });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * POST /api/admin-transactions/:ref/activate
 * Tandai lunas + aktifkan paket secara manual.
 * Dipakai untuk pembayaran di luar gateway (transfer langsung, tunai).
 */
router.post('/:ref/activate', validateBody(schemas.paymentActivate), async (req, res) => {
  try {
    const payment = await getPaymentByRef(req.params.ref);
    if (!payment) return fail(res, 404, 'PAYMENT_NOT_FOUND', 'Transaksi tidak ditemukan.');

    const result = await activatePayment({
      merchantRef: req.params.ref,
      // Nominal sengaja tidak dikirim: owner berhak mengaktifkan walau
      // nominal transfer berbeda (mis. biaya admin dipotong bank).
      tripayReference: req.body.tripay_reference || null,
      paidAt: req.body.paid_at || null,
    });

    if (result.alreadyPaid) {
      return fail(res, 409, 'ALREADY_PAID', 'Transaksi ini sudah berstatus lunas.');
    }
    if (!result.ok) {
      return fail(res, 400, 'ACTIVATION_FAILED', result.reason || 'Aktivasi gagal.');
    }

    await addAuditLog({
      adminId: req.user?.sub || null,
      action: 'activate',
      entity: 'payments',
      entityId: payment.id,
      before: { status: payment.status },
      after: { status: result.payment.status, plan_slug: result.planSlug, months: result.months },
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    res.json({
      success: true,
      data: {
        payment: result.payment,
        plan_slug: result.planSlug,
        months: result.months,
        expires_at: result.expiresAt,
      },
    });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * POST /api/admin-transactions/:ref/status
 * Ubah status transaksi tanpa mengaktifkan paket.
 * Dipakai untuk menandai transaksi gagal/kedaluwarsa secara manual.
 */
router.post('/:ref/status', validateBody(schemas.paymentStatusUpdate), async (req, res) => {
  try {
    const payment = await getPaymentByRef(req.params.ref);
    if (!payment) return fail(res, 404, 'PAYMENT_NOT_FOUND', 'Transaksi tidak ditemukan.');

    const status = String(req.body.status).toUpperCase();
    if (!VALID_STATUSES.includes(status)) {
      return fail(res, 400, 'BAD_STATUS', `Status tidak dikenal: ${status}`);
    }

    // Menandai PAID lewat endpoint ini TIDAK memperpanjang masa aktif.
    // Arahkan ke /activate supaya tidak ada paket lunas tanpa masa aktif.
    if (status === 'PAID') {
      return fail(
        res,
        400,
        'USE_ACTIVATE',
        'Untuk menandai lunas, pakai endpoint /activate agar masa aktif ikut diperpanjang.',
      );
    }

    if (payment.status === 'PAID') {
      return fail(res, 409, 'ALREADY_PAID', 'Transaksi lunas tidak boleh diubah statusnya.');
    }

    const updated = await updatePayment(payment.id, { status });

    await addAuditLog({
      adminId: req.user?.sub || null,
      action: 'update_status',
      entity: 'payments',
      entityId: payment.id,
      before: { status: payment.status },
      after: { status },
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    res.json({ success: true, data: updated });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * POST /api/admin-transactions/:ref/sync
 * Tanya Tripay status transaksi ini, lalu aktiskan bila sudah lunas.
 */
router.post('/:ref/sync', async (req, res) => {
  try {
    const payment = await getPaymentByRef(req.params.ref);
    if (!payment) return fail(res, 404, 'PAYMENT_NOT_FOUND', 'Transaksi tidak ditemukan.');

    const result = await syncPaymentStatus(req.params.ref);
    if (!result.payment) {
      return fail(res, 400, 'SYNC_FAILED', result.reason || 'Gagal menyinkronkan status.');
    }

    res.json({
      success: true,
      data: {
        status: result.payment.status,
        activated: Boolean(result.ok && !result.alreadyPaid),
        already_paid: Boolean(result.alreadyPaid),
        note: result.reason || null,
      },
    });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * POST /api/admin-transactions/user/:phone/plan
 * Ubah paket user langsung, tanpa transaksi.
 * `months: 0` menurunkan ke paket gratis.
 */
router.post('/user/:phone/plan', validateBody(schemas.userPlanUpdate), async (req, res) => {
  try {
    const phone = String(req.params.phone).trim();
    const user = await getUser(phone);
    if (!user) return fail(res, 404, 'USER_NOT_FOUND', 'User tidak ditemukan.');

    const before = { plan_slug: user.plan_slug, plan_expires_at: user.plan_expires_at };

    // Bila tanggal eksplisit dikirim, pakai itu; kalau tidak, tambah bulan.
    const result = req.body.expires_at
      ? await overrideUserPlan({
          phone,
          planSlug: req.body.plan_slug,
          expiresAt: req.body.expires_at,
        })
      : await setUserPlanManually({
          phone,
          planSlug: req.body.plan_slug,
          months: req.body.months || 0,
        });

    if (!result.ok) return fail(res, 400, 'PLAN_UPDATE_FAILED', result.reason);

    await addAuditLog({
      adminId: req.user?.sub || null,
      action: 'update_plan',
      entity: 'users',
      entityId: phone,
      before,
      after: { plan_slug: result.user.plan_slug, plan_expires_at: result.user.plan_expires_at },
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    res.json({
      success: true,
      data: {
        phone,
        plan_slug: result.user.plan_slug,
        plan_label: planLabel(result.user.plan_slug),
        plan_expires_at: result.user.plan_expires_at,
      },
    });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

export default router;
