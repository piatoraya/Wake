/**
 * ==========================================================================
 *  src/web/validate.js
 *  Validasi body request API memakai zod (sebelumnya dependency tidak dipakai).
 *
 *  Pemakaian di router:
 *    import { validateBody, schemas } from '../validate.js';
 *    router.post('/', validateBody(schemas.transactionCreate), handler);
 *
 *  Bila valid  -> req.body diganti hasil parse (hanya field yang dikenal,
 *                 sudah dikonversi tipenya, field liar dibuang).
 *  Bila gagal  -> 400 VALIDATION_ERROR + daftar field bermasalah.
 * ==========================================================================
 */

import { z } from 'zod';
import { PLAN_SLUGS } from '../config/plans.js';

/**
 * Enum slug paket diambil dari sumber kebenaran tunggal (`plans.js`) supaya
 * tidak drift saat paket ditambah/diganti. Sebelumnya di-hardcode di sini dan
 * sempat tidak sinkron ('business' vs 'starter'), sehingga checkout paket
 * 'starter' selalu ditolak 400 VALIDATION_ERROR.
 */
const planSlugField = z.enum(PLAN_SLUGS, { message: 'Paket tidak dikenal' });

/** Nomor telepon Indonesia dalam bentuk apa pun -> dinormalisasi di layer DB. */
const phoneField = z
  .string({ message: 'Nomor harus berupa teks' })
  .trim()
  .min(8, 'Nomor terlalu pendek')
  .max(20, 'Nomor terlalu panjang')
  .regex(/^[+\d\s\-().]+$/, 'Nomor mengandung karakter tidak valid');

/** Nomor opsional: string kosong dianggap tidak diisi. */
const optionalPhone = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  phoneField.optional(),
);

const shortText = (max = 120) =>
  z.string().trim().min(1, 'Wajib diisi').max(max, `Maksimal ${max} karakter`);

const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max, `Maksimal ${max} karakter`)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

const isoDate = z
  .string()
  .trim()
  .refine((v) => !v || !Number.isNaN(Date.parse(v)), 'Format tanggal tidak valid')
  .optional();

const amountField = z.coerce
  .number({ message: 'Jumlah harus berupa angka' })
  .positive('Jumlah harus lebih dari 0')
  .max(1e15, 'Jumlah terlalu besar');

const boolish = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).transform((v) => v === true || v === 'true' || v === '1');

export const schemas = {
  /* ------------------------------------------------------------------ auth */
  login: z.object({
    username: z.string().trim().min(1, 'Username wajib').max(64),
    password: z.string().min(1, 'Password wajib').max(200),
  }),

  /* ---------------------------------------------------------- transactions */
  transactionCreate: z.object({
    user_phone: phoneField,
    type: z.enum(['income', 'expense'], { message: 'Jenis harus income atau expense' }),
    amount: amountField,
    category: shortText(80),
    wallet: optionalText(80),
    description: optionalText(500),
    date: isoDate,
    source: optionalText(40),
    items: z.array(z.unknown()).max(200).optional(),
  }),

  transactionUpdate: z
    .object({
      type: z.enum(['income', 'expense']).optional(),
      amount: amountField.optional(),
      category: optionalText(80),
      wallet: optionalText(80),
      description: optionalText(500),
      date: isoDate,
    })
    .refine((v) => Object.keys(v).length > 0, 'Tidak ada field yang diubah'),

  /* ------------------------------------------------------------ categories */
  categoryCreate: z.object({
    name: shortText(80),
    type: z.enum(['income', 'expense']).default('expense'),
    parent_id: optionalText(64),
    is_active: boolish.optional(),
  }),

  categoryUpdate: z
    .object({
      name: shortText(80).optional(),
      type: z.enum(['income', 'expense']).optional(),
      parent_id: optionalText(64),
      is_active: boolish.optional(),
    })
    .refine((v) => Object.keys(v).length > 0, 'Tidak ada field yang diubah'),

  /* --------------------------------------------------------------- users */
  userUpdate: z
    .object({
      name: optionalText(80),
      // `tier` lama (free/basic/premium/sultan) DIGANTI oleh `plan_slug`.
      // Field tier sengaja dibuang, bukan dipetakan diam-diam, supaya
      // permintaan lama gagal jelas alih-alih menulis paket yang salah.
      plan_slug: planSlugField.optional(),
      plan_expires_at: isoDate,
      text_quota_used: z.coerce.number().int().min(0).optional(),
      media_quota_used: z.coerce.number().int().min(0).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, 'Tidak ada field yang diubah'),

  /* -------------------------------------------------------------- contacts */
  contactUpdate: z
    .object({
      label: optionalText(80),
      value: optionalText(300),
      is_active: boolish.optional(),
    })
    .refine((v) => Object.keys(v).length > 0, 'Tidak ada field yang diubah'),

  /* ---------------------------------------------------------- admin users */
  adminCreate: z.object({
    username: z
      .string()
      .trim()
      .min(3, 'Username minimal 3 karakter')
      .max(32)
      .regex(/^[a-zA-Z0-9._-]+$/, 'Username hanya boleh huruf, angka, titik, garis bawah, strip'),
    password: z.string().min(8, 'Password minimal 8 karakter').max(200),
    name: optionalText(80),
    role: z.enum(['owner', 'admin']).default('admin'),
  }),

  adminUpdate: z
    .object({
      password: z.string().min(8, 'Password minimal 8 karakter').max(200).optional(),
      name: optionalText(80),
      role: z.enum(['owner', 'admin']).optional(),
      is_active: boolish.optional(),
    })
    .refine((v) => Object.keys(v).length > 0, 'Tidak ada field yang diubah'),

  /* --------------------------------------------------------- bot instances */
  botInstanceCreate: z.object({
    owner_phone: phoneField,
    name: shortText(60),
    phone: optionalPhone,
    method: z.enum(['pairing', 'qr']).default('pairing'),
  }),

  botInstanceUpdate: z.object({
    phone: phoneField,
  }),

  botStart: z.object({
    method: z.enum(['pairing', 'qr']).optional(),
    force: boolish.optional(),
  }),

  /* -------------------------------------------------------------- settings */
  settingsUpdate: z.object({
    domain: z.string().trim().max(200).optional(),
  }),

  /* --------------------------------------------------------------- restore */
  restoreUpload: z
    .object({
      phone: phoneField,
      mode: z.enum(['merge', 'replace']).default('merge'),
      data: z.record(z.string(), z.unknown()).optional(),
      backup: z.record(z.string(), z.unknown()).optional(),
    })
    .refine((v) => v.data || v.backup, {
      message: 'Payload backup (data/backup) wajib diisi',
      path: ['data'],
    }),

  // --------------------------------------------------------------------
  //  Langganan & pembayaran
  // --------------------------------------------------------------------

  /** Hitung harga tanpa membuat transaksi. */
  pricingQuote: z.object({
    plan_slug: planSlugField,
    months: z.coerce
      .number({ message: 'Durasi harus berupa angka' })
      .int('Durasi harus bilangan bulat')
      .min(1, 'Durasi minimal 1 bulan')
      .max(36, 'Durasi maksimal 36 bulan'),
    voucher_code: optionalText(40),
  }),

  /** Buat transaksi baru. Nominal TIDAK diterima dari client. */
  pricingCheckout: z.object({
    phone: phoneField,
    plan_slug: planSlugField,
    months: z.coerce
      .number({ message: 'Durasi harus berupa angka' })
      .int('Durasi harus bilangan bulat')
      .min(1, 'Durasi minimal 1 bulan')
      .max(36, 'Durasi maksimal 36 bulan'),
    voucher_code: optionalText(40),
    method: optionalText(30),
    name: optionalText(80),
  }),

  /** Konfigurasi gateway pembayaran. Rahasia opsional: kosong = jangan ubah. */
  paymentConfigUpdate: z.object({
    enabled: boolish.optional(),
    mode: z.enum(['sandbox', 'production']).optional(),
    merchant_code: optionalText(40),
    private_key: optionalText(300),
    api_key: optionalText(300),
    callback_url: z
      .string()
      .trim()
      .max(300)
      .refine((v) => !v || /^https?:\/\//i.test(v), 'URL harus diawali http:// atau https://')
      .optional(),
    return_url: z
      .string()
      .trim()
      .max(300)
      .refine((v) => !v || /^https?:\/\//i.test(v), 'URL harus diawali http:// atau https://')
      .optional(),
  }),

  /** Ubah paket langganan. */
  planUpdate: z.object({
    label: optionalText(60),
    monthly_price: amountField.optional(),
    is_active: boolish.optional(),
    sort_order: z.coerce.number().int().min(0).max(999).optional(),
    features: z.record(z.string(), z.unknown()).optional(),
    durations: z.array(z.coerce.number().int().min(1).max(36)).max(10).optional(),
    benefits: z.array(z.string().trim().max(120)).max(20).optional(),
  }),

  /** Buat voucher. */
  voucherCreate: z.object({
    code: z
      .string({ message: 'Kode voucher wajib diisi' })
      .trim()
      .min(3, 'Kode minimal 3 karakter')
      .max(40, 'Kode maksimal 40 karakter')
      .regex(/^[A-Za-z0-9_-]+$/, 'Kode hanya boleh huruf, angka, tanda hubung, dan garis bawah'),
    discount_type: z.enum(['percent', 'fixed'], { message: 'Tipe diskon harus percent atau fixed' }),
    discount_value: amountField,
    min_amount: amountField.optional(),
    max_discount: amountField.optional(),
    quota: z.coerce.number().int().min(1).max(1e9).optional(),
    max_per_user: z.coerce.number().int().min(1).max(1000).optional(),
    plan_slug: planSlugField.optional(),
    is_active: boolish.optional(),
    starts_at: isoDate,
    expires_at: isoDate,
    note: optionalText(200),
  }),

  /** Ubah voucher. Semua field opsional. */
  voucherUpdate: z.object({
    code: z
      .string()
      .trim()
      .min(3, 'Kode minimal 3 karakter')
      .max(40, 'Kode maksimal 40 karakter')
      .regex(/^[A-Za-z0-9_-]+$/, 'Kode hanya boleh huruf, angka, tanda hubung, dan garis bawah')
      .optional(),
    discount_type: z.enum(['percent', 'fixed']).optional(),
    discount_value: amountField.optional(),
    min_amount: amountField.optional(),
    max_discount: amountField.optional(),
    quota: z.coerce.number().int().min(1).max(1e9).optional(),
    max_per_user: z.coerce.number().int().min(1).max(1000).optional(),
    plan_slug: planSlugField.optional(),
    is_active: boolish.optional(),
    starts_at: isoDate,
    expires_at: isoDate,
    note: optionalText(200),
  }),

  /** Aktivasi manual oleh owner (transfer langsung, kompensasi). */
  paymentActivate: z.object({
    tripay_reference: optionalText(120),
    paid_at: isoDate,
  }),

  /** Ubah status transaksi tanpa memperpanjang masa aktif. */
  paymentStatusUpdate: z.object({
    status: z.enum(['UNPAID', 'EXPIRED', 'FAILED'], { message: 'Status tidak dikenal' }),
  }),

  /** Ubah paket user langsung dari dashboard. */
  userPlanUpdate: z.object({
    plan_slug: planSlugField,
    months: z.coerce.number().int().min(0).max(36).optional(),
    expires_at: isoDate,
  }),
};

/**
 * Buat middleware validasi body.
 * @param {import('zod').ZodTypeAny} schema
 * @returns {import('express').RequestHandler}
 */
export function validateBody(schema) {
  return function validate(req, res, next) {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        field: i.path.join('.') || '(body)',
        message: i.message,
      }));
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: details.map((d) => `${d.field}: ${d.message}`).join('; '),
          details,
        },
      });
    }
    req.body = result.data;
    return next();
  };
}

/**
 * Validasi query string (angka & enum) tanpa mengubah tipe lain.
 * @param {import('zod').ZodTypeAny} schema
 * @returns {import('express').RequestHandler}
 */
export function validateQuery(schema) {
  return function validate(req, res, next) {
    const result = schema.safeParse(req.query ?? {});
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: result.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; '),
        },
      });
    }
    req.validatedQuery = result.data;
    return next();
  };
}
