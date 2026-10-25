import {
  getUser,
  withCollection,
  applyUserDefaults,
  currentMonthKey,
  todayKey,
} from '../config/database.js';
import { getAppConfig } from '../config/appConfig.js';

export async function isTierEnabled() {
  try {
    const cfg = await getAppConfig();
    return !!(cfg && cfg.tier_enabled);
  } catch {
    return false;
  }
}

export const isLimitEnabled = isTierEnabled;

export const TIER_LIMITS = {
  free: { text: 50, media: 0, mediaDaily: 0, backup: false, bot: false },
  basic: { text: 100, media: 100, mediaDaily: 1, backup: false, bot: false }, // total 100 gabungan
  premium: { text: Infinity, media: 100, mediaDaily: Infinity, backup: true, bot: false },
  sultan: { text: Infinity, media: Infinity, mediaDaily: Infinity, backup: true, bot: true },
};

function isExpired(user) {
  if (!user.tier_expired_at) return false;
  if (user.tier === 'free') return false;
  return new Date(user.tier_expired_at) < new Date();
}

export async function resetQuotaIfNeeded(user) {
  const monthKey = currentMonthKey();
  const quotaMonth = (user.quota_reset_date || '').slice(0, 7);
  if (quotaMonth !== monthKey) {
    user.text_quota_used = 0;
    user.media_quota_used = 0;
    user.quota_reset_date = `${monthKey}-01`;
  }
  const t = todayKey();
  if (user.last_media_reset_daily !== t) {
    // Basic daily media reset: media_quota_used dipakai sebagai counter harian
    if (user.tier === 'basic') user.media_quota_used = 0;
    user.last_media_reset_daily = t;
  }
  return user;
}

/**
 * Cek & pakai kuota dalam SATU transaksi tulis (atomik).
 *
 * Sebelumnya fungsi ini membaca user, menghitung di memori, lalu menulis
 * terpisah lewat `updateUserFields`. Dua pesan yang masuk hampir bersamaan
 * bisa membaca angka yang sama sehingga kuota terpakai lebih dari batas
 * (race condition). Sekarang baca + hitung + tulis terjadi di dalam
 * `withCollection` yang punya antrean per-file, jadi request diproses
 * berurutan dan tidak ada update yang hilang.
 *
 * @param {string} phone
 * @param {'text'|'media'} inputType
 * @returns {Promise<{allowed:boolean, reason?:string, user?:object}>}
 */
export async function checkAndConsumeQuota(phone, inputType) {
  // Level/limit dimatikan: semua diizinkan tanpa kuota (tanpa menulis apa pun).
  if (!(await isTierEnabled())) {
    const user = await getUser(phone);
    if (!user) return { allowed: false, reason: 'User belum terdaftar. Ketik DAFTAR.' };
    return { allowed: true, user };
  }

  let denial = null;

  const updated = await withCollection('users', (users) => {
    const user = users.find((u) => u.phone === phone);
    if (!user) {
      denial = 'User belum terdaftar. Ketik DAFTAR.';
      return null;
    }

    // Samakan default field (tier, counter, dsb.) sebelum dihitung.
    applyUserDefaults(user);

    // Tier kedaluwarsa -> turunkan ke free di record yang sama.
    if (isExpired(user)) {
      user.tier = 'free';
      user.tier_expired_at = null;
    }

    resetQuotaIfNeeded(user);

    const limits = TIER_LIMITS[user.tier] || TIER_LIMITS.free;

    if (inputType === 'media') {
      if (user.tier === 'free') {
        denial = '❌ Media (foto struk/voice) tidak tersedia di tier Free. Upgrade ke Basic/Premium/Sultan.';
        return null;
      }
      if (user.tier === 'basic') {
        if (user.media_quota_used >= 1) {
          denial = '❌ Limit media Basic: 1x/hari. Coba lagi besok.';
          return null;
        }
        user.media_quota_used += 1;
      } else if (user.tier === 'premium') {
        if (user.media_quota_used >= limits.media) {
          denial = '❌ Kuota media Premium habis (100/bulan).';
          return null;
        }
        user.media_quota_used += 1;
      }
      // sultan unlimited
    } else {
      if (user.tier === 'free') {
        if (user.text_quota_used >= limits.text) {
          denial = '❌ Kuota teks Free habis (50/bulan). Upgrade untuk unlimited.';
          return null;
        }
        user.text_quota_used += 1;
      } else if (user.tier === 'basic') {
        const total = user.text_quota_used + user.media_quota_used;
        if (total >= 100) {
          denial = '❌ Kuota Basic habis (100 transaksi/bulan).';
          return null;
        }
        user.text_quota_used += 1;
      }
      // premium/sultan unlimited text
    }

    user.updated_at = new Date().toISOString();
    return { ...user };
  });

  if (!updated) return { allowed: false, reason: denial || 'Kuota tidak tersedia.' };
  return { allowed: true, user: updated };
}

export async function canUseBackup(user) {
  if (!(await isTierEnabled())) return true;
  const limits = TIER_LIMITS[user?.tier] || TIER_LIMITS.free;
  return !!limits.backup;
}

export async function canCreateBotInstance(user) {
  if (!(await isTierEnabled())) return { allowed: true };
  if (!user || user.tier !== 'sultan') return { allowed: false, reason: 'Fitur khusus Sultan.' };
  const limit = user.sultan_bot_limit || 1;
  const instances = Array.isArray(user.active_bot_instances) ? user.active_bot_instances : [];
  if (instances.length >= limit) {
    return { allowed: false, reason: `Limit bot tercapai (${limit}). Hubungi admin untuk menambah.` };
  }
  return { allowed: true };
}