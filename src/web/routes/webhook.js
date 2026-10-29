/**
 * ==========================================================================
 *  src/web/routes/webhook.js
 *  Penerima callback pembayaran dari Tripay.
 *
 *  ENDPOINT INI TERBUKA TANPA LOGIN. Siapa pun di internet bisa memanggilnya.
 *  Karena itu setiap permintaan WAJIB lolos verifikasi tanda tangan HMAC
 *  sebelum dipercaya. Tanpa verifikasi, penyerang cukup mengirim:
 *
 *    POST /api/webhook/tripay
 *    {"merchant_ref":"WAKE-PRO-...","status":"PAID","total_amount":402900}
 *
 *  ...dan mendapat paket Pro gratis.
 *
 *  TIGA LAPIS PERTAHANAN
 *
 *  1. Tanda tangan HMAC-SHA256 atas RAW BODY dibandingkan timing-safe.
 *     Raw body disimpan middleware `rawBodySaver` yang dipasang SEBELUM
 *     express.json() di server.js. Tanpa itu, byte asli hilang.
 *
 *  2. Nominal callback harus sama persis dengan tagihan. Tanda tangan yang
 *     sah tetapi nominal berbeda (mis. transaksi tertukar) ditolak.
 *
 *  3. Aktivasi idempoten lewat activatePayment(). Callback yang dikirim
 *     ulang tidak menambah masa aktif.
 *
 *  BALASAN SELALU 200 untuk callback yang tanda tangannya sah tetapi tidak
 *  bisa diproses (transaksi tidak dikenal, nominal beda). Kalau kita balas
 *  4xx/5xx, Tripay akan mengirim ulang terus-menerus tanpa henti.
 * ==========================================================================
 */
import { Router } from 'express';

import { parseTripayCallback, verifyTripayCallback, SIGNATURE_HEADER } from '../../services/tripay.js';
import { activatePayment } from '../../services/subscription.js';
import { getPaymentConfigInternal } from '../../config/paymentConfig.js';
import { getPaymentByRef, updatePayment } from '../../config/database.js';

const router = Router();

/**
 * POST /api/webhook/tripay
 *
 * Catatan: route ini TIDAK memakai validateBody(). Body harus tetap mentah
 * untuk verifikasi tanda tangan; parsing dilakukan manual setelah lolos.
 */
router.post('/tripay', async (req, res) => {
  const signature = req.get(SIGNATURE_HEADER) || req.get('X-Callback-Signature') || '';
  const rawBody = req.rawBody;

  // Lapis 1: verifikasi tanda tangan.
  let verification;
  try {
    verification = await verifyTripayCallback({ rawBody, signature });
  } catch (e) {
    console.error('[WEBHOOK] gagal memverifikasi tanda tangan:', e?.message);
    return res.status(500).json({ success: false, message: 'Gagal memverifikasi callback.' });
  }

  if (!verification.valid) {
    // Balasan 401 memberi tahu Tripay bahwa callback tidak sah. Percobaan
    // seperti ini dicatat supaya owner bisa melihat upaya pemalsuan.
    console.warn('[WEBHOOK] callback DITOLAK:', verification.reason, {
      ip: req.ip,
      hasSignature: Boolean(signature),
      bodyLength: rawBody ? rawBody.length : 0,
    });
    return res.status(401).json({ success: false, message: verification.reason });
  }

  // Body sudah terbukti asli; aman di-parse.
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ success: false, message: 'Body callback bukan JSON yang sah.' });
  }

  const event = parseTripayCallback(payload);

  if (!event.merchantRef) {
    return res.status(200).json({ success: true, message: 'Callback diabaikan: merchant_ref kosong.' });
  }

  try {
    const payment = await getPaymentByRef(event.merchantRef);

    if (!payment) {
      console.warn('[WEBHOOK] transaksi tidak dikenal:', event.merchantRef);
      return res.status(200).json({ success: true, message: 'Transaksi tidak dikenal, diabaikan.' });
    }

    // Lapis 2: nominal harus cocok.
    if (event.amount && event.amount !== payment.final_amount) {
      console.error(
        `[WEBHOOK] nominal tidak cocok untuk ${event.merchantRef}: callback ${event.amount}, tagihan ${payment.final_amount}`,
      );
      return res.status(200).json({ success: true, message: 'Nominal tidak cocok, diabaikan.' });
    }

    if (event.status === 'PAID') {
      // Lapis 3: aktivasi idempoten.
      const result = await activatePayment({
        merchantRef: event.merchantRef,
        amount: event.amount || null,
        tripayReference: event.reference,
        paidAt: event.paidAt,
      });

      if (result.alreadyPaid) {
        return res.status(200).json({ success: true, message: 'Sudah diproses sebelumnya.' });
      }
      if (!result.ok) {
        console.error('[WEBHOOK] aktivasi gagal:', result.reason);
        // Tetap 200: mengulang tidak akan menolong, owner harus turun tangan.
        return res.status(200).json({ success: true, message: `Gagal diproses: ${result.reason}` });
      }

      console.log(
        `[WEBHOOK] ${event.merchantRef} LUNAS: ${result.planSlug} ${result.months} bulan untuk ${result.payment.user_phone}`,
      );
      return res.status(200).json({ success: true, message: 'Pembayaran diaktifkan.' });
    }

    if (event.status === 'EXPIRED' || event.status === 'FAILED') {
      if (payment.status === 'PAID') {
        // Jangan turunkan paket yang sudah lunas hanya karena callback
        // kedaluwarsa datang terlambat (urutan callback tidak dijamin).
        console.warn(`[WEBHOOK] ${event.merchantRef} sudah PAID, abaikan status ${event.status}`);
        return res.status(200).json({ success: true, message: 'Transaksi sudah lunas, diabaikan.' });
      }
      await updatePayment(payment.id, { status: event.status });
      return res.status(200).json({ success: true, message: `Status diubah ke ${event.status}.` });
    }

    return res.status(200).json({ success: true, message: `Status ${event.rawStatus} diabaikan.` });
  } catch (e) {
    console.error('[WEBHOOK] error tak terduga:', e?.message);
    // 500 supaya Tripay mencoba lagi — kegagalan di sini bisa bersifat sementara.
    return res.status(500).json({ success: false, message: 'Kesalahan internal.' });
  }
});

/**
 * GET /api/webhook/tripay/health
 * Uji cepat dari dashboard: apakah private key sudah diatur dan endpoint
 * bisa dijangkau. TIDAK membocorkan nilai kredensial.
 */
router.get('/tripay/health', async (req, res) => {
  try {
    const cfg = await getPaymentConfigInternal();
    res.json({
      success: true,
      data: {
        endpoint_ready: true,
        mode: cfg.mode,
        enabled: cfg.enabled,
        has_private_key: Boolean(cfg.private_key),
        signature_header: SIGNATURE_HEADER,
        raw_body_capture: typeof req.rawBody === 'string',
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

export default router;
