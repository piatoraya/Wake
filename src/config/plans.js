/**
 * src/config/plans.js
 * Definisi paket langganan (subscription plan) — sumber kebenaran TUNGGAL
 * untuk slug paket, katalog fitur, dan bentuk data default.
 *
 * Prinsip: TIDAK ada fitur yang di-hardcode di logika bisnis. File ini hanya
 * menyediakan (a) slug paket yang sah, (b) KATALOG fitur yang boleh diatur,
 * dan (c) nilai awal saat seeder pertama kali dijalankan. Setelah itu,
 * nilai efektif selalu dibaca dari koleksi `subscription_plans` di database,
 * sehingga admin/owner bisa mengubahnya tanpa deploy ulang.
 */

/** Slug paket yang sah, berurutan dari terendah ke tertinggi. */
export const PLAN_SLUGS = ['free', 'starter', 'pro'];

/** Paket default untuk semua user baru. */
export const DEFAULT_PLAN = 'free';

/** Paket yang bisa dibeli (berbayar, punya masa aktif). */
export const PAID_PLAN_SLUGS = ['starter', 'pro'];

/**
 * Opsi durasi sewa dalam bulan. Durasi 1 bulan selalu diskon 0 dan tidak
 * bisa diubah admin (lihat `normalizeDurations`).
 */
export const DURATION_MONTHS = [1, 3, 6, 12];

/** Durasi yang diskonnya boleh diatur admin (1 bulan dikunci 0%). */
export const DISCOUNTABLE_MONTHS = [3, 6, 12];

/** Batas minimum transaksi Tripay (Rp). Harga akhir tidak boleh di bawah ini. */
export const MIN_TRANSACTION_AMOUNT = 1000;

/**
 * Katalog fitur yang boleh diatur per paket.
 *
 * `type` menentukan bentuk nilainya:
 *   - 'boolean' → toggle ON/OFF akses fitur
 *   - 'limit'   → angka kuota; -1 berarti tanpa batas (unlimited)
 *
 * `key` dipakai di kode lewat `canAccessFeature(user, key)` untuk boolean dan
 * `checkFeatureLimit(user, key)` untuk limit. Jangan pakai string lepas di
 * logika bisnis — impor dari sini supaya salah ketik terdeteksi lebih awal.
 */
export const FEATURE_CATALOG = [
  {
    key: 'text_input',
    type: 'limit',
    label: 'Catat via Teks',
    hint: 'Jumlah transaksi teks per bulan. -1 = tanpa batas.',
  },
  {
    key: 'media_input',
    type: 'limit',
    label: 'Catat via Media (foto struk / voice)',
    hint: 'Jumlah transaksi media per bulan. -1 = tanpa batas.',
  },
  {
    key: 'media_daily',
    type: 'limit',
    label: 'Batas Media Harian',
    hint: 'Batas media per hari. -1 = tanpa batas.',
  },
  {
    key: 'backup',
    type: 'boolean',
    label: 'Backup & Restore',
    hint: 'Ekspor/impor data ke Excel/PDF.',
  },
  {
    key: 'bot_instance',
    type: 'limit',
    label: 'Bot Instance Terpisah',
    hint: 'Jumlah bot WhatsApp terpisah. 0 = tidak tersedia.',
  },
  {
    key: 'report_export',
    type: 'boolean',
    label: 'Ekspor Laporan',
    hint: 'Unduh laporan transaksi.',
  },
  {
    key: 'multi_wallet',
    type: 'limit',
    label: 'Jumlah Dompet',
    hint: 'Jumlah dompet/akun yang bisa dipakai. -1 = tanpa batas.',
  },
];

/** Daftar key fitur bertipe boolean. */
export const BOOLEAN_FEATURE_KEYS = FEATURE_CATALOG.filter((f) => f.type === 'boolean').map(
  (f) => f.key,
);

/** Daftar key fitur bertipe limit. */
export const LIMIT_FEATURE_KEYS = FEATURE_CATALOG.filter((f) => f.type === 'limit').map(
  (f) => f.key,
);

export function isFeatureKey(key) {
  return FEATURE_CATALOG.some((f) => f.key === key);
}

export function getFeatureMeta(key) {
  return FEATURE_CATALOG.find((f) => f.key === key) || null;
}

export function isPlanSlug(slug) {
  return PLAN_SLUGS.includes(String(slug || '').toLowerCase());
}

export function isPaidPlan(slug) {
  return PAID_PLAN_SLUGS.includes(String(slug || '').toLowerCase());
}

/** Normalisasi slug apa pun menjadi slug sah; tidak dikenal → free. */
export function normalizePlanSlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  return isPlanSlug(s) ? s : DEFAULT_PLAN;
}

/**
 * Nilai fitur default per paket saat seeder pertama jalan.
 * Sengaja konservatif: paket berbayar mendapat lebih, tetapi semuanya bisa
 * diubah admin lewat dashboard setelahnya.
 */
export const DEFAULT_PLAN_FEATURES = {
  free: {
    text_input: 50,
    media_input: 0,
    media_daily: 0,
    backup: false,
    bot_instance: 0,
    report_export: false,
    multi_wallet: 1,
  },
  starter: {
    text_input: -1,
    media_input: 100,
    media_daily: 5,
    backup: true,
    bot_instance: 0,
    report_export: true,
    multi_wallet: 3,
  },
  pro: {
    text_input: -1,
    media_input: -1,
    media_daily: -1,
    backup: true,
    bot_instance: 3,
    report_export: true,
    multi_wallet: -1,
  },
};

/** Daftar benefit default yang tampil sebagai checklist di halaman Pricing. */
export const DEFAULT_PLAN_BENEFITS = {
  free: [
    'Catat transaksi via teks',
    '1 dompet',
    'Riwayat 1 bulan',
  ],
  starter: [
    'Catat transaksi tanpa batas',
    'Catat via foto struk & voice',
    'Backup & restore data',
    'Ekspor laporan',
    '3 dompet',
  ],
  pro: [
    'Semua fitur Starter',
    'Kuota media tanpa batas',
    'Bot instance terpisah (3 slot)',
    'Dompet tanpa batas',
    'Prioritas dukungan',
  ],
};

/** Harga dasar bulanan default (Rp) untuk paket berbayar. */
export const DEFAULT_MONTHLY_PRICE = {
  starter: 29000,
  pro: 79000,
};

/**
 * Diskon durasi default. `type` = 'percent' | 'fixed'.
 * Durasi 1 bulan selalu { type: 'percent', value: 0 }.
 */
export const DEFAULT_DURATIONS = {
  free: [{ months: 1, discount_type: 'percent', discount_value: 0 }],
  starter: [
    { months: 1, discount_type: 'percent', discount_value: 0 },
    { months: 3, discount_type: 'percent', discount_value: 10 },
    { months: 6, discount_type: 'percent', discount_value: 15 },
    { months: 12, discount_type: 'percent', discount_value: 25 },
  ],
  pro: [
    { months: 1, discount_type: 'percent', discount_value: 0 },
    { months: 3, discount_type: 'percent', discount_value: 10 },
    { months: 6, discount_type: 'percent', discount_value: 15 },
    { months: 12, discount_type: 'percent', discount_value: 25 },
  ],
};

/** Label tampilan paket. */
export const PLAN_LABELS = {
  free: 'Gratis',
  starter: 'Starter',
  pro: 'Pro',
};

export function planLabel(slug) {
  return PLAN_LABELS[normalizePlanSlug(slug)] || 'Gratis';
}

/**
 * Bangun satu record paket lengkap dari nilai default.
 * Dipakai seeder; setelah tersimpan di DB, DB yang jadi sumber kebenaran.
 * @param {'free'|'starter'|'pro'} slug
 * @returns {object}
 */
export function buildDefaultPlanRecord(slug) {
  const s = normalizePlanSlug(slug);
  const paid = isPaidPlan(s);
  return {
    slug: s,
    label: planLabel(s),
    is_paid: paid,
    is_active: true,
    monthly_price: paid ? DEFAULT_MONTHLY_PRICE[s] : 0,
    features: { ...DEFAULT_PLAN_FEATURES[s] },
    benefits: [...DEFAULT_PLAN_BENEFITS[s]],
    durations: DEFAULT_DURATIONS[s].map((d) => ({ ...d })),
    sort_order: PLAN_SLUGS.indexOf(s),
    updated_at: new Date().toISOString(),
  };
}

/** Bangun seluruh record paket default (untuk seeder). */
export function buildDefaultPlanRecords() {
  return PLAN_SLUGS.map((slug) => buildDefaultPlanRecord(slug));
}

/**
 * Rapikan array durasi: pastikan keempat durasi ada, urut, dan durasi
 * 1 bulan selalu diskon 0 (tidak bisa diubah admin).
 * @param {Array} durations
 * @returns {Array<{months:number, discount_type:'percent'|'fixed', discount_value:number}>}
 */
export function normalizeDurations(durations) {
  const byMonths = new Map();
  if (Array.isArray(durations)) {
    for (const d of durations) {
      const months = Number(d?.months);
      if (!DURATION_MONTHS.includes(months)) continue;
      const type = d?.discount_type === 'fixed' ? 'fixed' : 'percent';
      let value = Number(d?.discount_value);
      if (!Number.isFinite(value) || value < 0) value = 0;
      byMonths.set(months, { months, discount_type: type, discount_value: value });
    }
  }
  return DURATION_MONTHS.map((months) => {
    if (months === 1) return { months, discount_type: 'percent', discount_value: 0 };
    return byMonths.get(months) || { months, discount_type: 'percent', discount_value: 0 };
  });
}

/**
 * Rapikan objek fitur: hanya key yang ada di katalog, tipe sesuai, dan
 * limit tidak boleh di bawah -1.
 * @param {object} features
 * @returns {object}
 */
export function normalizeFeatures(features) {
  const src = features && typeof features === 'object' ? features : {};
  const out = {};
  for (const meta of FEATURE_CATALOG) {
    const raw = src[meta.key];
    if (meta.type === 'boolean') {
      out[meta.key] = raw === true || raw === 'true' || raw === 1 || raw === '1';
    } else {
      let n = Number(raw);
      if (!Number.isFinite(n)) n = 0;
      n = Math.floor(n);
      if (n < -1) n = -1;
      out[meta.key] = n;
    }
  }
  return out;
}

/** Rapikan daftar benefit: array string, maksimum 20 poin, tiap poin ≤200 char. */
export function normalizeBenefits(benefits) {
  if (!Array.isArray(benefits)) return [];
  return benefits
    .map((b) => String(b ?? '').trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((b) => b.slice(0, 200));
}

/** Harga bulanan: bilangan bulat ≥ 0. */
export function normalizeMonthlyPrice(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}
