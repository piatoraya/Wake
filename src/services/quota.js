import {
  getUser,
  updateUserFields,
  currentMonthKey,
  todayKey,
} from '../config/database.js';

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

export async function checkAndConsumeQuota(phone, inputType) {
  // inputType: 'text' | 'media'
  const user = await getUser(phone);
  if (!user) return { allowed: false, reason: 'User belum terdaftar. Ketik DAFTAR.' };

  // expired tier -> downgrade
  if (isExpired(user)) {
    await updateUserFields(phone, { tier: 'free', tier_expired_at: null });
    user.tier = 'free';
  }

  await resetQuotaIfNeeded(user);

  const limits = TIER_LIMITS[user.tier] || TIER_LIMITS.free;

  if (inputType === 'media') {
    if (!limits.backup && user.tier === 'free') {
      // free has no media
    }
    if (user.tier === 'free') {
      return { allowed: false, reason: '❌ Media (foto struk/voice) tidak tersedia di tier Free. Upgrade ke Basic/Premium/Sultan.' };
    }
    if (user.tier === 'basic') {
      if (user.media_quota_used >= 1) {
        return { allowed: false, reason: '❌ Limit media Basic: 1x/hari. Coba lagi besok.' };
      }
      user.media_quota_used += 1;
    } else if (user.tier === 'premium') {
      if (user.media_quota_used >= limits.media) {
        return { allowed: false, reason: '❌ Kuota media Premium habis (100/bulan).' };
      }
      user.media_quota_used += 1;
    }
    // sultan unlimited
  } else {
    if (user.tier === 'free') {
      if (user.text_quota_used >= limits.text) {
        return { allowed: false, reason: '❌ Kuota teks Free habis (50/bulan). Upgrade untuk unlimited.' };
      }
      user.text_quota_used += 1;
    } else if (user.tier === 'basic') {
      const total = user.text_quota_used + user.media_quota_used;
      if (total >= 100) {
        return { allowed: false, reason: '❌ Kuota Basic habis (100 transaksi/bulan).' };
      }
      user.text_quota_used += 1;
    }
    // premium/sultan unlimited text
  }

  // persist
  await updateUserFields(phone, {
    text_quota_used: user.text_quota_used,
    media_quota_used: user.media_quota_used,
    quota_reset_date: user.quota_reset_date,
    last_media_reset_daily: user.last_media_reset_daily,
  });

  return { allowed: true, user };
}

export function canUseBackup(user) {
  const limits = TIER_LIMITS[user?.tier] || TIER_LIMITS.free;
  return !!limits.backup;
}

export function canCreateBotInstance(user) {
  if (!user || user.tier !== 'sultan') return { allowed: false, reason: 'Fitur khusus Sultan.' };
  const limit = user.sultan_bot_limit || 1;
  const instances = Array.isArray(user.active_bot_instances) ? user.active_bot_instances : [];
  if (instances.length >= limit) {
    return { allowed: false, reason: `Limit bot tercapai (${limit}). Hubungi admin untuk menambah.` };
  }
  return { allowed: true };
}