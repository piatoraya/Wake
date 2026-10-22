/**
 * ==========================================================================
 *  src/services/owner.js
 *  LAPORAN OTOMATIS KE OWNER (pemilik bot)
 *
 *  Dipakai saat AI (Gemini) gagal total:
 *    - semua kuota model & API key habis (429)
 *    - semua API key tidak valid (401/403)
 *
 *  Modul ini murni (tidak menyentuh socket) supaya bisa diuji terpisah:
 *    buildAiFailureReport() -> menyusun teks laporan
 *    reportAiFailureToOwner() -> mengirim + anti spam
 * ==========================================================================
 */

import { ownerJid } from '../utils/phone.js';

/** Waktu laporan terakhir per jenis laporan (anti spam). */
const ALERT_AT = new Map();

/**
 * Jeda minimal antar laporan sejenis (menanti spam).
 * Dibaca dari .env tiap kali dipanggil -> `!reload` langsung berlaku.
 * @returns {number} durasi dalam ms
 */
export function getAlertCooldownMs() {
  const min = Math.max(1, Number(process.env.OWNER_ALERT_COOLDOWN_MIN) || 15);
  return min * 60 * 1000;
}

/**
 * Susun isi laporan kegagalan AI.
 *
 * @param {any} err            error dari services/gemini.js
 * @param {{phone?:string}} ctx info pemicu (user yang mengirim pesan)
 * @param {object} st           status rotasi (getRotationStatus)
 * @param {{timezone?:string}} [opts] zona waktu tampilan (default Asia/Jakarta)
 * @returns {string} teks laporan (siap dikirim ke WhatsApp)
 */
export function buildAiFailureReport(err, ctx = {}, st = {}, opts = {}) {
  const isQuota = err?.code === 'GEMINI_QUOTA_EXCEEDED';
  const waktu = new Date().toLocaleString('id-ID', {
    timeZone: opts.timezone || 'Asia/Jakarta',
  });

  const keys = st.keys || [];
  const invalidCount = keys.filter((k) => k.invalid).length;

  const lines = [
    isQuota
      ? '🚨 *LAPORAN OWNER — KUOTA GEMINI HABIS*'
      : '🚨 *LAPORAN OWNER — GEMINI GAGAL TOTAL*',
    '',
    `⏰ Waktu      : ${waktu}`,
    `👤 Pemicu    : ${ctx.phone || 'tidak diketahui'}`,
    `🧠 Model     : ${(st.models || []).join(', ') || '-'}`,
    `🔑 API key   : ${keys.length} terdaftar${invalidCount ? ` (${invalidCount} tidak valid)` : ''}`,
  ];

  // Rincian pasangan (model, key) yang sedang kena limit
  const limitLines = keys
    .filter((k) => k.exhaustedModels?.length)
    .map((k) => `   • key #${k.index} (\`${k.masked}\`) — ${k.exhaustedModels.join(', ')}`);
  if (limitLines.length) {
    lines.push('', '⛔ *Kena limit (429):*', ...limitLines);
  }

  // Rincian key yang dinolaki server
  const invalidLines = keys
    .filter((k) => k.invalid)
    .map((k) => `   • key #${k.index} (\`${k.masked}\`)`);
  if (invalidLines.length) {
    lines.push('', '❌ *API key tidak valid (401/403):*', ...invalidLines);
  }

  lines.push(
    '',
    '🔧 *Saran:*',
    '   • Tambah API key: `GEMINI_API_KEYS=key1,key2,key3` (tiap key = kuota sendiri)',
    '   • Tambah model cadangan: `GEMINI_MODEL=model-a,model-b`',
    '   • Setelah ubah `.env`, kirim `!reload`',
    '',
    '_Detail:_ ' + String(err?.message || '').slice(0, 300),
  );

  return lines.join('\n');
}

/**
 * Kirim laporan ke owner dengan anti-spam (maks 1 per jenis per cooldown).
 *
 * @param {object} sock          socket Baileys
 * @param {{type:string, text:string, jid?:string}} payload
 * @returns {Promise<boolean>} true bila terkirim
 */
export async function notifyOwner(sock, { type, text, jid = ownerJid() }) {
  if (!jid) {
    console.warn('[OWNER] OWNER_NUMBER belum diisi di .env — laporan tidak dikirim.');
    return false;
  }

  const now = Date.now();
  if (now - (ALERT_AT.get(type) || 0) < getAlertCooldownMs()) {
    return false; // sudah dilaporkan baru-baru ini
  }
  ALERT_AT.set(type, now);

  try {
    await sock.sendMessage(jid, { text: `${text}\n\nby: ampang dev` });
    console.log(`[OWNER] Laporan "${type}" terkirim ke ${jid}.`);
    return true;
  } catch (err) {
    console.error('[OWNER] Gagal kirim laporan:', err.message);
    return false;
  }
}

/**
 * Kirim laporan ke owner saat AI gagal total.
 * Tidak dikirim bila pemicunya owner sendiri (owner sudah dapat balasan).
 *
 * @param {object} sock          socket Baileys
 * @param {any} err              error dari services/gemini.js
 * @param {{phone?:string}} ctx   info pemicu
 * @param {object} st             status rotasi (getRotationStatus)
 * @param {{timezone?:string}} [opts]
 * @returns {Promise<boolean>} true bila terkirim
 */
export async function reportAiFailureToOwner(sock, err, ctx = {}, st = {}, opts = {}) {
  const jid = opts.jid || ownerJid();
  if (!jid) return false;
  if (ctx.phone && jid.split('@')[0] === ctx.phone) return false; // owner sendiri

  const type = err?.code === 'GEMINI_QUOTA_EXCEEDED' ? 'kuota' : 'gagal';
  const text = buildAiFailureReport(err, ctx, st, opts);
  return notifyOwner(sock, { type, text, jid });
}
