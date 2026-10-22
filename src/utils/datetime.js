/**
 * ==========================================================================
 *  src/utils/datetime.js
 *  UTILITAS TANGGAL & JAM (dengan dukungan zona waktu IANA)
 *
 *  Dipakai oleh:
 *    - src/services/gemini.js  -> gabung tanggal + jam dari pesan user
 *    - src/services/receipt.js -> jam yang tercetak di struk belanja
 *
 *  Semua data transaksi disimpan sebagai timestamp ISO UTC (…Z), sedangkan
 *  tanggal & jam yang disebut pengguna ("kemarin", "jam 10") adalah waktu
 *  lokal pada zona waktu bot (`TIMEZONE` di .env).
 * ==========================================================================
 */

/**
 * Zona waktu bot (dari .env).
 * Dibaca tiap kali dipanggil agar `!reload` langsung berlaku.
 * @returns {string} nama zona waktu IANA
 */
export function getTimezone() {
  return process.env.TIMEZONE || 'Asia/Jakarta';
}

/**
 * Set zona waktu global (proses) — berguna untuk pengujian / runtime.
 * @param {string} tz input pilihan atau nama IANA
 * @returns {string} zona waktu IANA yang diterapkan (atau sebelumnya bila invalid)
 */
export function setTimezone(tz) {
  const normalized = normalizeTimezone(tz);
  if (normalized) process.env.TIMEZONE = normalized;
  return normalized || getTimezone();
}

/**
 * Pilihan zona waktu yang disediakan perintah `.setzonawaktu`.
 *   WIB  -> Asia/Jakarta   (UTC+7)
 *   WITA -> Asia/Makassar  (UTC+8)
 *   WIT  -> Asia/Jayapura  (UTC+9)
 */
export const TIMEZONE_CHOICES = {
  WIB: 'Asia/Jakarta',
  WITA: 'Asia/Makassar',
  WIT: 'Asia/Jayapura',
};

/**
 * Rapikan input zona waktu menjadi nama IANA yang valid.
 * Menerima nama pilihan (WIB/WITA/WIT) maupun nama IANA (Asia/Jakarta, ...).
 *
 * @param {string} input
 * @returns {string} nama zona waktu IANA, atau string kosong bila tidak valid
 */
export function normalizeTimezone(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';

  const upper = raw.toUpperCase();
  if (TIMEZONE_CHOICES[upper]) return TIMEZONE_CHOICES[upper];

  // Validasi nama IANA (Intl akan melempar RangeError bila tidak dikenal).
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    return '';
  }
}

/** Alias untuk normalizeTimezone (nama lain yang mungkin dipakai). */
export const timezoneFromChoice = normalizeTimezone;
export const parseTimezone = normalizeTimezone;

/**
 * Kebalikan dari normalizeTimezone: nama IANA -> pilihan WIB/WITA/WIT (atau '').
 * @param {string} tz
 * @returns {string}
 */
export function choiceFromTimezone(tz) {
  for (const [choice, zone] of Object.entries(TIMEZONE_CHOICES)) {
    if (zone === tz) return choice;
  }
  return '';
}

/**
 * Cek apakah sebuah nilai adalah zona waktu yang dikenali.
 * @param {string} tz
 * @returns {boolean}
 */
export function isValidTimezone(tz) {
  return !!normalizeTimezone(tz);
}

/**
 * Label ramah untuk zona waktu (mis. "WIB (Asia/Jakarta)").
 * @param {string} tz
 * @returns {string}
 */
export function timezoneLabel(tz) {
  const choice = choiceFromTimezone(tz);
  const zone = tz || getTimezone();
  return choice ? `${choice} (${zone})` : zone;
}

/**
 * Komponen tanggal & jam sebuah momen pada zona waktu tertentu.
 * @param {Date} [date]
 * @param {string} [timeZone]
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number}}
 */
export function zonedParts(date = new Date(), timeZone = getTimezone()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const out = {};
  for (const part of dtf.formatToParts(date)) out[part.type] = part.value;

  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24, // beberapa ICU memberi "24" untuk tengah malam
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

/**
 * Offset zona waktu (menit, bisa negatif) terhadap UTC pada saat tertentu.
 * Menghormati DST karena dihitung dari waktu lokal yang benar-benar berlaku.
 *
 * @param {Date} date
 * @param {string} [timeZone]
 * @returns {number} selisih menit (mis. 480 untuk UTC+8, -300 untuk UTC-5)
 */
export function tzOffsetMinutes(date, timeZone = getTimezone()) {
  const p = zonedParts(date, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

/**
 * Ubah tanggal + jam lokal (zona waktu bot) menjadi momen UTC.
 *
 * @param {string} dateStr  "YYYY-MM-DD"
 * @param {string} [timeStr] "HH:MM" (boleh kosong -> 00:00)
 * @param {string} [timeZone]
 * @returns {Date|null} momen UTC, atau null bila tanggal tidak valid
 */
export function zonedToUtc(dateStr, timeStr = '00:00', timeZone = getTimezone()) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? '').trim());
  if (!dm) return null;

  const time = normalizeTime(timeStr) || '00:00';
  const [hh, mm] = time.split(':').map(Number);

  const naive = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), hh, mm, 0);

  // Offset dihitung 2x: sekali dari perkiraan awal, sekali dari hasilnya
  // (dimasukkan supaya zona dengan DST tetap benar).
  let utc = naive - tzOffsetMinutes(new Date(naive), timeZone) * 60000;
  utc = naive - tzOffsetMinutes(new Date(utc), timeZone) * 60000;

  const result = new Date(utc);
  return Number.isNaN(result.getTime()) ? null : result;
}

/**
 * Tanggal hari ini pada zona waktu bot.
 * @param {string} [timeZone]
 * @returns {string} "YYYY-MM-DD"
 */
export function todayInZone(timeZone = getTimezone()) {
  const p = zonedParts(new Date(), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Jam sekarang pada zona waktu bot.
 * @param {string} [timeZone]
 * @returns {string} "HH:MM"
 */
export function clockInZone(timeZone = getTimezone()) {
  const p = zonedParts(new Date(), timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * Rapikan input jam jadi format "HH:MM" (24 jam).
 *
 * Menerima: "10", "10:00", "9:30", "10.00", "10:00:00", "jam 10",
 * "10 PM", "10:30 malam", "jam 12 malam".
 *
 * @param {string|number} input
 * @returns {string} "HH:MM", atau string kosong bila tidak bisa dibaca
 */
export function normalizeTime(input) {
  if (input === null || input === undefined) return '';

  const raw = String(input).trim().toLowerCase();
  if (!raw) return '';

  // Buang kata pengantar ("jam", "pukul") supaya "jam 10" tetap terbaca.
  const cleaned = raw.replace(/\b(jam|pukul)\b/g, ' ').trim();

  // Kata penanda waktu (pagi/siang/sore/malam/AM/PM).
  const meridiem = /\b(pagi|siang|sore|malam|pm|am)\b/.exec(cleaned)?.[1] || '';
  const nums = cleaned.replace(/\b(pagi|siang|sore|malam|pm|am)\b/g, ' ').trim();

  let hour = null;
  let minute = 0;

  const withSep = /^(\d{1,2})\s*[:.]\s*(\d{1,2})/.exec(nums);
  const hourOnly = /^(\d{1,2})\b/.exec(nums);

  if (withSep) {
    hour = Number(withSep[1]);
    minute = Number(withSep[2]);
  } else if (hourOnly) {
    hour = Number(hourOnly[1]);
  } else {
    return '';
  }

  // AM/PM (model idealnya sudah mengonversi, tapi ini jaring pengaman).
  if (meridiem === 'malam' || meridiem === 'pm') {
    if (hour < 12) hour += 12;
    else if (hour === 12) hour = 0; // tengah malam -> 00:00
  } else if (meridiem === 'siang' || meridiem === 'sore') {
    if (hour < 12) hour += 12; // "jam 1 siang" -> 13:00
  } else if (meridiem === 'pagi' || meridiem === 'am') {
    if (hour === 12) hour = 0; // tengah malam -> 00:00
  }

  if (hour > 23 || minute > 59) return '';

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Rapikan input tanggal jadi format "YYYY-MM-DD".
 *
 * Menerima: "2026-10-18", "18/10/2026", "18-10-2026", "18.10.2026",
 * "2026/10/18".
 *
 * @param {string} input
 * @returns {string} "YYYY-MM-DD", atau string kosong bila tidak terbaca
 */
export function normalizeDate(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';

  // "YYYY-MM-DD" (ISO) — juga menerima "YYYY/MM/DD" & "YYYY.MM.DD".
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) {
    return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  // "DD/MM/YYYY" (format Indonesia) atau "MM/DD/YYYY" (ambigu).
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = Number(m[3]);
    // Angka pertama > 12 pasti hari; kalau keduanya <= 12 dipakai versi RI.
    const day = a > 12 ? a : b > 12 ? b : a;
    const month = a > 12 ? b : b > 12 ? a : a;
    return isoDate(year, month, day);
  }

  return '';
}

/**
 * Bentuk "YYYY-MM-DD" dari angka tahun/bulan/hari (null bila tidak valid).
 * @param {number} y
 * @param {number} m
 * @param {number} d
 * @returns {string}
 */
function isoDate(y, m, d) {
  if (!(y >= 1900 && y <= 2999)) return '';
  if (!(m >= 1 && m <= 12)) return '';
  if (!(d >= 1 && d <= 31)) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Gabungkan tanggal + jam yang disebut pengguna menjadi timestamp ISO UTC.
 *
 * Aturan:
 *   - tanggal + jam  -> tanggal & jam tersebut
 *   - tanggal saja    -> tanggal tersebut pada 00:00
 *   - jam saja        -> HARI INI pada jam tersebut
 *   - tidak ada       -> null (pakai waktu saat transaksi dicatat)
 *
 * Tanggal berupa ISO lengkap ("2026-10-21T03:00:00.000Z") dipakai apa adanya,
 * kecuali ada jam terpisah yang lebih spesifik.
 *
 * @param {string} dateStr
 * @param {string} timeStr
 * @param {string} [timeZone]
 * @returns {string|null} timestamp ISO UTC
 */
export function combineDateTime(dateStr, timeStr, timeZone = getTimezone()) {
  const t = normalizeTime(timeStr);
  const d = String(dateStr ?? '').trim();

  // Model kadang mengirim ISO lengkap -> pakai apa adanya.
  if (d.includes('T')) {
    const parsed = new Date(d);
    if (Number.isNaN(parsed.getTime())) return null;
    if (!t) return parsed.toISOString();

    // Ada jam terpisah -> pakai tanggal dari ISO + jam tersebut.
    const datePart = normalizeDate(d.slice(0, 10));
    if (datePart) {
      const dt = zonedToUtc(datePart, t, timeZone);
      if (dt) return dt.toISOString();
    }
    return parsed.toISOString();
  }

  // "18/10/2026" dsb. -> "YYYY-MM-DD"
  const date = normalizeDate(d);
  if (!date && !t) return null;

  const dt = zonedToUtc(date || todayInZone(timeZone), t || '00:00', timeZone);
  return dt ? dt.toISOString() : null;
}