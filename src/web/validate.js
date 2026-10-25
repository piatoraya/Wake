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
      tier: z.enum(['free', 'basic', 'premium', 'sultan']).optional(),
      tier_expired_at: isoDate,
      text_quota_used: z.coerce.number().int().min(0).optional(),
      media_quota_used: z.coerce.number().int().min(0).optional(),
      sultan_bot_limit: z.coerce.number().int().min(0).max(100).optional(),
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
