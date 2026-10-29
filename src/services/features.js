/**
 * src/services/features.js
 * Gerbang fitur (feature gating) berbasis PAKET LANGGANAN.
 *
 * Menggantikan src/services/quota.js yang lama. Perbedaan pokok:
 *   - Batas fitur TIDAK di-hardcode di kode. Semua dibaca dari koleksi
 *     `subscription_plans` di database, sehingga admin bisa mengubah kuota
 *     tanpa deploy ulang.
 *   - Kedaluwarsa paket ditangani di satu tempat (`resolveEffectivePlan`),
 *     bukan tersebar di tiap cabang if.
 *   - Semua operasi baca-hitung-tulis tetap di dalam `withCollection` agar
 *     antrean tulis per-file mencegah race condition.
 */

import {
  getUser,
  withCollection,
  applyUserDefaults,
  currentMonthKey,
  todayKey,
  listPlans,
  getPlan,
  downgradeToFree,
  findExpiredPlanUsers,
} from '../config/database.js';
import { getAppConfig } from '../config/appConfig.js';
import {
  DEFAULT_PLAN,
  normalizePlanSlug,
  isPaidPlan,
  isFeatureKey,
  getFeatureMeta,
} from '../config/plans.js';

/**
 * Sakelar global: bila `tier_enabled` di config aplikasi bernilai false,
 * SEMUA fitur dibuka tanpa batas (mode pengembangan / self-host).
 * Nama kunci dipertahankan agar kompatibel dengan config yang sudah ada.
 */
export async function isLimitEnabled() {
  try {
    const cfg = await getAppConfig();
    return !!(cfg && cfg.tier_enabled);
  } catch {
    return false;
  }
}

/** @deprecated gunakan isLimitEnabled */
export const isTierEnabled = isLimitEnabled;

/** Nilai batas ketika gating dimatikan: semua terbuka. */
const UNLIMITED = -1;

/**
 * Peta paket dalam memori untuk satu siklus permintaan.
 * Menghindari membaca file JSON berulang kali dalam satu alur.
 */
async function loadPlanMap() {
  const plans = await listPlans();
  const map = new Map();
  for (const p of plans) map.set(p.slug, p);
  return map;
}

/**
 * Tentukan paket EFEKTIF seorang user, dengan mempertimbangkan:
 *   - paket tidak ada / nonaktif  -> paket gratis
 *   - paket berbayar kedaluwarsa  -> paket gratis
 *
 * Fungsi ini TIDAK menulis apa pun. Pembersihan record dilakukan oleh
 * `sweepExpiredPlans()` supaya jalur baca tetap murni.
 *
 * @param {object} user
 * @param {Map<string,object>} planMap
 * @returns {{slug:string, plan:object|null, expired:boolean, wasSlug:string}}
 */
export function resolveEffectivePlan(user, planMap) {
  const wasSlug = normalizePlanSlug(user?.plan_slug || user?.tier);
  const plan = planMap?.get(wasSlug) || null;

  // Paket tidak dikenal atau dinonaktifkan admin -> turun ke gratis.
  if (!plan || plan.is_active === false) {
    return { slug: DEFAULT_PLAN, plan: planMap?.get(DEFAULT_PLAN) || null, expired: false, wasSlug };
  }

  if (!isPaidPlan(wasSlug)) {
    return { slug: wasSlug, plan, expired: false, wasSlug };
  }

  const exp = user?.plan_expires_at || user?.tier_expired_at;
  if (!exp) {
    // Paket berbayar tanpa tanggal = anggap kedaluwarsa (aman).
    return { slug: DEFAULT_PLAN, plan: planMap?.get(DEFAULT_PLAN) || null, expired: true, wasSlug };
  }
  const t = new Date(exp).getTime();
  if (Number.isNaN(t) || t <= Date.now()) {
    return { slug: DEFAULT_PLAN, plan: planMap?.get(DEFAULT_PLAN) || null, expired: true, wasSlug };
  }

  return { slug: wasSlug, plan, expired: false, wasSlug };
}

/** Ambil nilai fitur dari record paket; tidak ada -> nilai netral. */
function featureValue(plan, key) {
  const meta = getFeatureMeta(key);
  const raw = plan?.features?.[key];
  if (!meta) return undefined;
  if (meta.type === 'boolean') return raw === true;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Apakah user boleh memakai fitur boolean (mis. backup, ekspor laporan)?
 *
 * @param {object} user
 * @param {string} featureKey
 * @returns {Promise<boolean>}
 */
export async function canAccessFeature(user, featureKey) {
  if (!isFeatureKey(featureKey)) return false;
  if (!(await isLimitEnabled())) return true;

  const meta = getFeatureMeta(featureKey);
  const planMap = await loadPlanMap();
  const { plan } = resolveEffectivePlan(user, planMap);
  const value = featureValue(plan, featureKey);

  if (meta.type === 'boolean') return value === true;
  // Untuk fitur bertipe limit, "boleh akses" berarti kuotanya > 0 atau tak terbatas.
  return value === UNLIMITED || value > 0;
}

/**
 * Periksa kuota fitur bertipe limit TANPA memakainya.
 *
 * @param {object} user
 * @param {string} featureKey
 * @param {number} [used] jumlah yang sudah dipakai; default dibaca dari user
 * @returns {Promise<{allowed:boolean, limit:number, used:number, remaining:number, reason?:string}>}
 */
export async function checkFeatureLimit(user, featureKey, used = undefined) {
  const meta = getFeatureMeta(featureKey);
  if (!meta || meta.type !== 'limit') {
    return { allowed: false, limit: 0, used: 0, remaining: 0, reason: 'Fitur tidak dikenal.' };
  }

  const planMap = await loadPlanMap();
  const { slug, plan, expired } = resolveEffectivePlan(user, planMap);
  const limit = featureValue(plan, featureKey);
  const consumed = Number.isFinite(Number(used)) ? Number(used) : readUsage(user, featureKey);

  if (!(await isLimitEnabled())) {
    return { allowed: true, limit: UNLIMITED, used: consumed, remaining: UNLIMITED };
  }

  if (limit === UNLIMITED) {
    return { allowed: true, limit: UNLIMITED, used: consumed, remaining: UNLIMITED };
  }
  if (limit <= 0) {
    return {
      allowed: false,
      limit,
      used: consumed,
      remaining: 0,
      reason: expired
        ? 'Masa aktif paket Anda sudah berakhir. Perpanjang untuk memakai fitur ini.'
        : `Fitur "${meta.label}" tidak tersedia di paket ${slug}.`,
    };
  }
  if (consumed >= limit) {
    return {
      allowed: false,
      limit,
      used: consumed,
      remaining: 0,
      reason: `Kuota "${meta.label}" sudah habis (${consumed}/${limit}).`,
    };
  }
  return { allowed: true, limit, used: consumed, remaining: limit - consumed };
}

/** Baca angka pemakaian user untuk sebuah fitur limit. */
export function readUsage(user, featureKey) {
  if (!user) return 0;
  switch (featureKey) {
    case 'text_input':
      return Number(user.text_quota_used) || 0;
    case 'media_input':
    case 'media_daily':
      return Number(user.media_quota_used) || 0;
    case 'bot_instance':
      return Array.isArray(user.active_bot_instances) ? user.active_bot_instances.length : 0;
    case 'multi_wallet':
      return Number(user.wallet_count) || 0;
    default:
      return 0;
  }
}

/**
 * Reset penghitung kuota bila bulan/hari sudah berganti.
 * Memodifikasi `user` di tempat (dipakai di dalam transaksi tulis).
 * @param {object} user
 * @returns {object} user yang sama
 */
export function resetUsageIfNeeded(user) {
  const monthKey = currentMonthKey();
  const quotaMonth = String(user.quota_reset_date || '').slice(0, 7);
  if (quotaMonth !== monthKey) {
    user.text_quota_used = 0;
    user.media_quota_used = 0;
    user.quota_reset_date = `${monthKey}-01`;
  }
  const t = todayKey();
  if (user.last_media_reset_daily !== t) {
    user.media_quota_used = 0;
    user.last_media_reset_daily = t;
  }
  return user;
}

/**
 * Cek DAN pakai kuota dalam SATU transaksi tulis (atomik).
 *
 * Baca + hitung + tulis terjadi di dalam `withCollection('users', ...)` yang
 * punya antrean per-file, jadi dua pesan yang masuk hampir bersamaan tidak
 * bisa membaca angka yang sama dan melampaui batas.
 *
 * @param {string} phone
 * @param {'text'|'media'} inputType
 * @returns {Promise<{allowed:boolean, reason?:string, user?:object}>}
 */
export async function checkAndConsumeQuota(phone, inputType) {
  const gating = await isLimitEnabled();
  const featureKey = inputType === 'media' ? 'media_input' : 'text_input';

  if (!gating) {
    const user = await getUser(phone);
    if (!user) return { allowed: false, reason: 'User belum terdaftar. Ketik DAFTAR.' };
    return { allowed: true, user };
  }

  const planMap = await loadPlanMap();
  let denial = null;

  const updated = await withCollection('users', (users) => {
    const user = users.find((u) => u.phone === phone);
    if (!user) {
      denial = 'User belum terdaftar. Ketik DAFTAR.';
      return null;
    }

    applyUserDefaults(user);
    const { slug, plan, expired } = resolveEffectivePlan(user, planMap);

    // Paket kedaluwarsa: turunkan di record yang sama supaya tampilan user
    // langsung konsisten tanpa menunggu penyapu.
    if (expired && user.plan_slug !== DEFAULT_PLAN) {
      user.plan_slug = DEFAULT_PLAN;
      user.plan_expires_at = null;
      user.tier = DEFAULT_PLAN;
      user.tier_expired_at = null;
    }

    resetUsageIfNeeded(user);

    if (inputType === 'media') {
      // Batas harian diperiksa lebih dulu bila paket punya batas harian.
      const dailyLimit = featureValue(plan, 'media_daily');
      const monthlyLimit = featureValue(plan, 'media_input');

      if (dailyLimit !== UNLIMITED && dailyLimit <= 0 && monthlyLimit !== UNLIMITED && monthlyLimit <= 0) {
        denial = expired
          ? '❌ Masa aktif paket berakhir. Media (foto struk/voice) tidak tersedia. Perpanjang paket Anda.'
          : '❌ Media (foto struk/voice) tidak tersedia di paket Gratis. Upgrade untuk memakainya.';
        return null;
      }
      if (dailyLimit !== UNLIMITED && dailyLimit > 0 && user.media_quota_used >= dailyLimit) {
        denial = `❌ Limit media harian paket ${slug}: ${dailyLimit}x/hari. Coba lagi besok.`;
        return null;
      }
      if (monthlyLimit !== UNLIMITED && monthlyLimit > 0 && user.media_quota_used >= monthlyLimit) {
        denial = `❌ Kuota media paket ${slug} habis (${monthlyLimit}/bulan).`;
        return null;
      }
      user.media_quota_used += 1;
    } else {
      const limit = featureValue(plan, 'text_input');
      if (limit !== UNLIMITED && limit > 0 && user.text_quota_used >= limit) {
        denial = `❌ Kuota teks paket ${slug} habis (${limit}/bulan). Upgrade untuk menambah.`;
        return null;
      }
      if (limit !== UNLIMITED && limit <= 0) {
        denial = `❌ Fitur catat via teks tidak tersedia di paket ${slug}.`;
        return null;
      }
      user.text_quota_used += 1;
    }

    user.updated_at = new Date().toISOString();
    return { ...user };
  });

  if (!updated) return { allowed: false, reason: denial || 'Kuota tidak tersedia.' };
  return { allowed: true, user: updated };
}

/** Apakah user boleh memakai backup/restore? */
export async function canUseBackup(user) {
  return canAccessFeature(user, 'backup');
}

/**
 * Apakah user boleh membuat bot instance baru?
 * @param {object} user
 * @returns {Promise<{allowed:boolean, reason?:string, limit?:number, used?:number}>}
 */
export async function canCreateBotInstance(user) {
  if (!(await isLimitEnabled())) return { allowed: true };

  const planMap = await loadPlanMap();
  const { slug, plan, expired } = resolveEffectivePlan(user, planMap);
  const limit = featureValue(plan, 'bot_instance');
  const instances = Array.isArray(user?.active_bot_instances) ? user.active_bot_instances : [];

  if (limit === UNLIMITED) return { allowed: true, limit: UNLIMITED, used: instances.length };
  if (limit <= 0) {
    return {
      allowed: false,
      limit,
      used: instances.length,
      reason: expired
        ? 'Masa aktif paket Anda sudah berakhir. Perpanjang untuk memakai bot instance.'
        : `Bot instance terpisah tidak tersedia di paket ${slug}.`,
    };
  }
  if (instances.length >= limit) {
    return {
      allowed: false,
      limit,
      used: instances.length,
      reason: `Limit bot tercapai (${instances.length}/${limit}). Hubungi admin untuk menambah.`,
    };
  }
  return { allowed: true, limit, used: instances.length };
}

/**
 * Ringkasan paket + pemakaian untuk ditampilkan ke user.
 * @param {string} phone
 * @returns {Promise<object|null>}
 */
export async function getPlanSummary(phone) {
  const user = await getUser(phone);
  if (!user) return null;
  applyUserDefaults(user);

  const planMap = await loadPlanMap();
  const { slug, plan, expired } = resolveEffectivePlan(user, planMap);
  const gating = await isLimitEnabled();

  const usage = {};
  for (const key of ['text_input', 'media_input', 'media_daily', 'bot_instance', 'multi_wallet']) {
    const limit = gating ? featureValue(plan, key) : UNLIMITED;
    const used = readUsage(user, key);
    usage[key] = {
      limit,
      used,
      remaining: limit === UNLIMITED ? UNLIMITED : Math.max(0, limit - used),
    };
  }

  const booleans = {};
  for (const key of ['backup', 'report_export']) {
    booleans[key] = gating ? featureValue(plan, key) === true : true;
  }

  return {
    slug,
    label: plan?.label || slug,
    is_paid: isPaidPlan(slug),
    expires_at: user.plan_expires_at || null,
    expired,
    gating_enabled: gating,
    benefits: Array.isArray(plan?.benefits) ? plan.benefits : [],
    usage,
    features: booleans,
    user,
  };
}

/**
 * Penyapu: turunkan semua user yang paket berbayarnya sudah kedaluwarsa.
 * Dipanggil berkala (mis. dari cron harian), bukan di jalur permintaan.
 *
 * @returns {Promise<{downgraded:string[]}>}
 */
export async function sweepExpiredPlans() {
  const expired = await findExpiredPlanUsers();
  const downgraded = [];
  for (const row of expired) {
    try {
      await downgradeToFree(row.phone);
      downgraded.push(row.phone);
    } catch (err) {
      console.error(`[features] gagal menurunkan paket ${row.phone}:`, err?.message);
    }
  }
  return { downgraded };
}

/** Ambil record paket mentah untuk halaman pricing. */
export async function getActivePlans() {
  const plans = await listPlans();
  return plans.filter((p) => p.is_active !== false);
}

export { getPlan };
