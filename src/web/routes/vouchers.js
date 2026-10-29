/**
 * ==========================================================================
 *  src/web/routes/vouchers.js
 *  CRUD kode voucher.
 *
 *  Hanya owner/admin. Voucher adalah diskon uang langsung, jadi setiap
 *  perubahan dicatat ke audit log.
 * ==========================================================================
 */
import { Router } from 'express';

import { authMiddleware, requireRole } from '../auth.js';
import { addAuditLog } from '../audit.js';
import { validateBody, schemas } from '../validate.js';
import {
  addVoucher,
  countVoucherUsageByUser,
  deleteVoucher,
  getVoucher,
  listVouchers,
  updateVoucher,
} from '../../config/database.js';
import { MIN_TRANSACTION_AMOUNT, PLAN_SLUGS, DURATION_MONTHS } from '../../config/plans.js';

const router = Router();
router.use(authMiddleware);
router.use(requireRole('owner', 'admin'));

function fail(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

/**
 * GET /api/vouchers
 * Daftar voucher + ringkasan pemakaian.
 */
router.get('/', async (req, res) => {
  try {
    const vouchers = await listVouchers();
    const now = Date.now();

    const data = vouchers.map((v) => {
      const starts = v.starts_at ? new Date(v.starts_at).getTime() : null;
      const expires = v.expires_at ? new Date(v.expires_at).getTime() : null;

      let status = 'aktif';
      if (!v.is_active) status = 'nonaktif';
      else if (expires !== null && expires < now) status = 'kedaluwarsa';
      else if (starts !== null && starts > now) status = 'terjadwal';
      else if (v.quota !== null && v.used_count >= v.quota) status = 'kuota habis';

      return {
        ...v,
        status,
        remaining_quota: v.quota === null ? null : Math.max(0, v.quota - (v.used_count || 0)),
      };
    });

    res.json({
      success: true,
      data: {
        vouchers: data,
        options: { plans: PLAN_SLUGS, durations: DURATION_MONTHS, min_amount: MIN_TRANSACTION_AMOUNT },
      },
    });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * GET /api/vouchers/:code
 * Detail satu voucher (dipakai form edit).
 */
router.get('/:code', async (req, res) => {
  try {
    const v = await getVoucher(req.params.code);
    if (!v) return fail(res, 404, 'VOUCHER_NOT_FOUND', 'Voucher tidak ditemukan.');
    res.json({ success: true, data: v });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * POST /api/vouchers
 * Buat voucher baru.
 */
router.post('/', validateBody(schemas.voucherCreate), async (req, res) => {
  try {
    const voucher = await addVoucher(req.body);

    await addAuditLog({
      adminId: req.user?.sub || null,
      action: 'create',
      entity: 'vouchers',
      entityId: voucher.id,
      after: voucher,
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    res.status(201).json({ success: true, data: voucher });
  } catch (e) {
    // Duplikat kode adalah kesalahan pengguna, bukan kegagalan server.
    if (/sudah dipakai/i.test(e.message)) {
      return fail(res, 409, 'VOUCHER_DUPLICATE', e.message);
    }
    if (/wajib diisi/i.test(e.message)) {
      return fail(res, 400, 'VOUCHER_INVALID', e.message);
    }
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * PUT /api/vouchers/:code
 * Ubah voucher. Kode boleh diubah selama tidak bertabrakan.
 */
router.put('/:code', validateBody(schemas.voucherUpdate), async (req, res) => {
  try {
    const existing = await getVoucher(req.params.code);
    if (!existing) return fail(res, 404, 'VOUCHER_NOT_FOUND', 'Voucher tidak ditemukan.');

    const updated = await updateVoucher(existing.id, req.body);
    if (!updated) return fail(res, 404, 'VOUCHER_NOT_FOUND', 'Voucher tidak ditemukan.');

    await addAuditLog({
      adminId: req.user?.sub || null,
      action: 'update',
      entity: 'vouchers',
      entityId: existing.id,
      before: existing,
      after: updated,
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    res.json({ success: true, data: updated });
  } catch (e) {
    if (/sudah dipakai/i.test(e.message)) {
      return fail(res, 409, 'VOUCHER_DUPLICATE', e.message);
    }
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * DELETE /api/vouchers/:code
 * Hapus voucher. Pemakaian yang sudah tercatat tetap tersimpan di
 * voucher_redemptions sebagai jejak.
 */
router.delete('/:code', async (req, res) => {
  try {
    const existing = await getVoucher(req.params.code);
    if (!existing) return fail(res, 404, 'VOUCHER_NOT_FOUND', 'Voucher tidak ditemukan.');

    const ok = await deleteVoucher(existing.id);
    if (!ok) return fail(res, 404, 'VOUCHER_NOT_FOUND', 'Voucher tidak ditemukan.');

    await addAuditLog({
      adminId: req.user?.sub || null,
      action: 'delete',
      entity: 'vouchers',
      entityId: existing.id,
      before: existing,
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    res.json({ success: true, data: { code: existing.code } });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * GET /api/vouchers/:code/usage?phone=...
 * Berapa kali satu nomor sudah memakai voucher ini. Dipakai saat
 * menangani keluhan "voucher saya ditolak".
 */
router.get('/:code/usage', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').trim();
    if (!phone) return fail(res, 400, 'BAD_REQUEST', 'Parameter phone wajib diisi.');

    const v = await getVoucher(req.params.code);
    if (!v) return fail(res, 404, 'VOUCHER_NOT_FOUND', 'Voucher tidak ditemukan.');

    const used = await countVoucherUsageByUser(phone, v.code);
    res.json({
      success: true,
      data: {
        code: v.code,
        phone,
        used_by_user: used,
        max_per_user: v.max_per_user,
        remaining: v.max_per_user === null ? null : Math.max(0, v.max_per_user - used),
      },
    });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

export default router;
