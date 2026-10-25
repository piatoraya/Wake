/**
 * ==========================================================================
 *  src/utils/phone.js
 *  UTILITAS NOMOR TELEPON (normalisasi ke format Indonesia)
 *
 *  Dipakai oleh:
 *    - src/index.js            -> nomor bot, pairing code
 *    - src/services/owner.js   -> nomor owner (tujuan laporan)
 * ==========================================================================
 */

/**
 * Normalisasi nomor telepon Indonesia ke format internasional (62...).
 *
 * Aturan:
 *   - hanya digit yang dipakai ("+62 812-34" -> "62812...34")
 *   - awalan 0    -> 62   (0852... -> 62852...)
 *   - awalan 620  -> 62   (buang kode negara ganda)
 *   - tanpa 0/62  -> 62, hanya bila diawali 8 (nomor seluler)
 *
 * @param {string} input nomor bebas
 * @returns {string|null} nomor valid (62...), atau null bila tidak valid
 */
export function normalizePhoneNumber(input) {
  if (!input) return null;
  let digits = String(input).replace(/\D/g, '');

  // Buang kode negara ganda (mis. 620812...)
  if (digits.startsWith('620')) digits = digits.slice(2);

  if (digits.startsWith('0')) {
    // Nomor lokal Indonesia: 08xxx -> 628xxx
    if (!digits.startsWith('08')) return null;
    digits = `62${digits.slice(1)}`;
  } else if (!digits.startsWith('62')) {
    // Tanpa awalan 0/62 -> hanya terima bila jelas nomor seluler Indonesia
    if (!digits.startsWith('8')) return null;
    digits = `62${digits}`;
  }

  // Nomor Indonesia: 62 + 8 + 8-11 digit (total 10-13 digit setelah 62)
  if (!/^628\d{8,11}$/.test(digits)) return null;
  return digits;
}

/**
 * Ubah nomor (62...) menjadi JID WhatsApp.
 * @param {string} phone
 * @returns {string} JID, atau '' bila nomor tidak valid
 */
export function phoneToJid(phone) {
  const digits = normalizePhoneNumber(phone);
  return digits ? `${digits}@s.whatsapp.net` : '';
}

/**
 * JID owner (pemilik bot) dari .env (`OWNER_NUMBER`).
 * Dibaca tiap kali dipanggil agar `!reload` langsung berlaku.
 * @param {string} [raw] nomor owner (default: dari .env)
 * @returns {string} JID owner, atau '' bila belum diisi / tidak valid
 */
export function ownerJid(raw = process.env.OWNER_NUMBER || '') {
  return phoneToJid(raw);
}

/**
 * Nomor owner yang sudah dinormalisasi (62...), atau null bila belum diisi.
 * Dibaca tiap kali dipanggil agar perubahan .env + `!reload` langsung berlaku.
 * @param {string} [raw] override nomor owner
 * @returns {string|null}
 */
export function ownerPhone(raw = process.env.OWNER_NUMBER || '') {
  return normalizePhoneNumber(raw);
}

/**
 * Cek apakah sebuah nomor adalah owner bot.
 * Satu-satunya sumber kebenaran untuk pengecekan owner di seluruh kode.
 *
 * @param {string} phone nomor apa pun (08xx, 62xx, +62 xx)
 * @param {string} [raw] override nomor owner (default dari .env)
 * @returns {boolean}
 */
export function isOwner(phone, raw = process.env.OWNER_NUMBER || '') {
  const owner = normalizePhoneNumber(raw);
  if (!owner) return false;
  const candidate = normalizePhoneNumber(phone);
  if (!candidate) return false;
  return candidate === owner;
}
