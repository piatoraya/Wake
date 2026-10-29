/**
 * ==========================================================================
 *  src/web/routes/adminPlans.js
 *  Kelola paket langganan + matriks fitur dari dashboard.
 *
 *  Hanya owner/admin. Setiap perubahan dicatat ke audit log karena
 *  mengubah harga atau fitur langsung memengaruhi pendapatan.
 * ==========================================================================
 */
import { Router } from 'express';

import { authMiddleware, requireRole } from '../auth.js';
import { addAuditLog } from '../audit.js';
import { validateBody, schemas } from '../validate.js';
import { getPlan, listPlans, seedDefaultPlans, updatePlan } from '../../config/database.js';
import {
  FEATURE_CATALOG,
  PLAN_SLUGS,
  buildDefaultPlanRecord,
  isFeatureKey,
  normalizeDurations,
  normalizeFeatures,
  planLabel,
} from '../../config/plans.js';
import {
  clearChannelCache,
  listPaymentChannels,
  TripayError,
} from '../../services/tripay.js';
import {
  getPaymentConfig,
  getPaymentConfigProblems,
  isTripayConfigured,
  setPaymentConfig,
} from '../../config/paymentConfig.js';

const router = Router();
router.use(authMiddleware);
router.use(requireRole('owner', 'admin'));

function fail(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

/**
 * GET /api/admin-plans
 * Daftar paket + katalog fitur yang bisa diatur.
 */
router.get('/', async (req, res) => {
  try {
    const plans = await listPlans();
    res.json({
      success: true,
      data: {
        plans: plans.map((p) => ({ ...p, label: p.label || planLabel(p.slug) })),
        feature_catalog: FEATURE_CATALOG,
        plan_slugs: PLAN_SLUGS,
      },
    });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * GET /api/admin-plans/features
 * Katalog fitur saja — dipakai halaman matriks fitur.
 */
router.get('/features', async (req, res) => {
  try {
    res.json({ success: true, data: FEATURE_CATALOG });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * GET /api/admin-plans/payment-config
 * Konfigurasi gateway. Rahasia SELALU bertopeng di sini.
 */
router.get('/payment-config', async (req, res) => {
  try {
    const [config, problems] = await Promise.all([
      getPaymentConfig(),
      getPaymentConfigProblems(),
    ]);
    res.json({ success: true, data: { ...config, problems } });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * PUT /api/admin-plans/payment-config
 * Simpan kredensial gateway. Field rahasia yang dikirim kosong atau masih
 * bertopeng TIDAK menimpa nilai lama.
 */
router.put('/payment-config', validateBody(schemas.paymentConfigUpdate), async (req, res) => {
  try {
    const before = await getPaymentConfig();
    const after = await setPaymentConfig(req.body);

    // Cache kanal mungkin berisi daftar dari mode/kredensial lama.
    clearChannelCache();

    await addAuditLog({
      adminId: req.user?.sub || null,
      action: 'update',
      entity: 'payment_config',
      entityId: 'tripay',
      before: { mode: before.mode, enabled: before.enabled, merchant_code: before.merchant_code },
      after: { mode: after.mode, enabled: after.enabled, merchant_code: after.merchant_code },
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    res.json({
      success: true,
      data: { ...after, problems: await getPaymentConfigProblems() },
    });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * POST /api/admin-plans/payment-config/test
 * Uji kredensial dengan memanggil daftar kanal Tripay.
 */
router.post('/payment-config/test', async (req, res) => {
  try {
    const config = await getPaymentConfig();
    if (!isTripayConfigured({
      enabled: true,
      mode: config.mode,
      merchant_code: config.merchant_code,
      private_key: config.private_key_set ? 'x' : '',
      api_key: config.api_key_set ? 'x' : '',
    })) {
      return fail(res, 400, 'NOT_CONFIGURED', 'Lengkapi merchant code, private key, dan API key dulu.');
    }

    const channels = await listPaymentChannels({ force: true });
    res.json({
      success: true,
      data: { ok: true, channel_count: channels.length, mode: config.mode },
    });
  } catch (e) {
    if (e instanceof TripayError) return fail(res, e.status, e.code, e.message);
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * POST /api/admin-plans/seed
 * Buat paket bawaan yang belum ada. TIDAK menimpa paket yang sudah diubah.
 */
router.post('/seed', async (req, res) => {
  try {
    const result = await seedDefaultPlans();

    await addAuditLog({
      adminId: req.user?.sub || null,
      action: 'seed',
      entity: 'subscription_plans',
      entityId: null,
      after: { created: result.created, existing: result.existing },
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    res.json({ success: true, data: result });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * GET /api/admin-plans/:slug
 * Detail satu paket.
 */
router.get('/:slug', async (req, res) => {
  try {
    const plan = await getPlan(req.params.slug);
    if (!plan) return fail(res, 404, 'PLAN_NOT_FOUND', 'Paket tidak ditemukan.');
    res.json({ success: true, data: plan });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * PUT /api/admin-plans/:slug
 * Ubah harga, fitur, durasi, atau status jual satu paket.
 */
router.put('/:slug', validateBody(schemas.planUpdate), async (req, res) => {
  try {
    const before = await getPlan(req.params.slug);
    if (!before) return fail(res, 404, 'PLAN_NOT_FOUND', 'Paket tidak ditemukan.');

    const patch = {};

    if (req.body.label !== undefined) patch.label = String(req.body.label).trim().slice(0, 60);
    if (req.body.monthly_price !== undefined) patch.monthly_price = req.body.monthly_price;
    if (req.body.is_active !== undefined) patch.is_active = req.body.is_active;
    if (req.body.sort_order !== undefined) patch.sort_order = req.body.sort_order;

    if (req.body.features !== undefined) {
      const unknown = Object.keys(req.body.features).filter((k) => !isFeatureKey(k));
      if (unknown.length) {
        return fail(res, 400, 'UNKNOWN_FEATURE', `Fitur tidak dikenal: ${unknown.join(', ')}`);
      }
      patch.features = normalizeFeatures(req.body.features);
    }

    if (req.body.durations !== undefined) {
      patch.durations = normalizeDurations(req.body.durations);
      if (!patch.durations.length) {
        return fail(res, 400, 'INVALID_DURATIONS', 'Minimal satu opsi durasi harus ada.');
      }
    }

    if (req.body.benefits !== undefined) {
      patch.benefits = Array.isArray(req.body.benefits)
        ? req.body.benefits.map((b) => String(b).trim()).filter(Boolean).slice(0, 20)
        : [];
    }

    const after = await updatePlan(req.params.slug, patch);
    if (!after) return fail(res, 404, 'PLAN_NOT_FOUND', 'Paket tidak ditemukan.');

    await addAuditLog({
      adminId: req.user?.sub || null,
      action: 'update',
      entity: 'subscription_plans',
      entityId: req.params.slug,
      before,
      after,
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    res.json({ success: true, data: after });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

/**
 * POST /api/admin-plans/:slug/reset
 * Kembalikan satu paket ke pengaturan bawaan.
 */
router.post('/:slug/reset', async (req, res) => {
  try {
    const slug = String(req.params.slug).toLowerCase();
    if (!PLAN_SLUGS.includes(slug)) {
      return fail(res, 404, 'PLAN_NOT_FOUND', 'Paket tidak ditemukan.');
    }

    const before = await getPlan(slug);
    if (!before) return fail(res, 404, 'PLAN_NOT_FOUND', 'Paket tidak ditemukan.');

    const defaults = buildDefaultPlanRecord(slug);
    const after = await updatePlan(slug, {
      label: defaults.label,
      monthly_price: defaults.monthly_price,
      features: defaults.features,
      benefits: defaults.benefits,
      durations: defaults.durations,
      is_active: defaults.is_active,
      sort_order: defaults.sort_order,
    });

    await addAuditLog({
      adminId: req.user?.sub || null,
      action: 'reset',
      entity: 'subscription_plans',
      entityId: slug,
      before,
      after,
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    res.json({ success: true, data: after });
  } catch (e) {
    fail(res, 500, 'SERVER_ERROR', e.message);
  }
});

export default router;
