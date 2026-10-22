/**
 * ==========================================================================
 *  src/services/gemini.js
 *  Integrasi Google Gemini (@google/genai) untuk mengubah pesan natural
 *  (teks MAUPUN voice note) menjadi JSON terstruktur:
 *
 *    { "intent": "...", "data": { "type", "amount", "category",
 *                                 "wallet", "description",
 *                                 "date", "time" } }
 *
 *  Teknik yang dipakai:
 *    - System Instruction berisi aturan parsing + daftar kategori/wallet.
 *    - responseMimeType : 'application/json'  -> jawaban murni JSON.
 *    - responseSchema   -> struktur JSON dijaga ketat oleh API
 *                          (ada fallback bila model tidak mendukungnya).
 *    - Normalisasi & validasi hasil di sisi klien (amount jadi number bulat,
 *                          intent dicek terhadap daftar yang diizinkan).
 *    - ROTASI MODEL: .env bisa berisi daftar model (pisah koma). Begitu satu
 *      model kena 429 (kuota free tier habis ~20 request/model), request
 *      otomatis dilanjut ke model berikutnya.
 * ==========================================================================
 */

import { GoogleGenAI, Type } from '@google/genai';
import {
  clockInZone,
  combineDateTime,
  getTimezone,
  normalizeDate,
  normalizeTime,
  todayInZone,
} from '../utils/datetime.js';

/* -------------------------------------------------------------------------
 *  Konfigurasi (dibaca lazy agar .env sudah ter-load)
 * ---------------------------------------------------------------------- */

/** Model utama bila .env tidak diisi. */
const DEFAULT_MODEL = 'gemini-3.6-flash';

/**
 * Rantai API key. Format di .env: `GEMINI_API_KEYS=key1,key2,key3`.
 * Setiap API key = 1 project Google = kuota terpisah, jadi ketika satu key
 * kena 429 (kuota habis) request otomatis pindah ke key berikutnya.
 * `GEMINI_API_KEY` (tunggal) tetap didukung & digabung dengan daftar di atas.
 *
 * @returns {string[]} daftar API key, urut dari yang paling diutamakan
 */
function getApiKeys() {
  const raw = [
    ...String(process.env.GEMINI_API_KEYS || '').split(','),
    String(process.env.GEMINI_API_KEY || ''),
  ]
    .map((k) => k.trim())
    .filter((k) => k && !k.includes('XXXX'));

  // Buang duplikat (kalau user menaruh key yang sama di dua tempat)
  return [...new Set(raw)];
}

/**
 * Sidik jari singkat dari API key.
 * Dipakai sebagai penanda key (cache client, daftar key invalid, cooldown)
 * supaya tetap aman walaupun urutan/isi daftar key berubah saat `!reload`.
 *
 * @param {string} apiKey
 * @returns {string} sidik jari hex pendek
 */
function keyFingerprint(apiKey) {
  let h = 5381;
  const s = String(apiKey || '');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/**
 * Tampilkan key dalam bentuk disamarkan: "AIza...abcd".
 * @param {string} apiKey
 * @returns {string}
 */
function maskApiKey(apiKey) {
  const s = String(apiKey || '');
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * Rantai model. Format di .env: `GEMINI_MODEL=model-a,model-b,model-c`.
 * Free tier Google membatasi ~20 request per model per periode, jadi begitu
 * satu model kena 429 (kuota habis) request otomatis dilanjut ke model
 * berikutnya sampai ketemu yang masih bisa dipakai.
 *
 * @returns {string[]} daftar model, urut dari yang paling diutamakan
 */
function getModels() {
  const raw = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const list = String(raw)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return list.length ? list : [DEFAULT_MODEL];
}

/**
 * Pasangan (model, apiKey) yang kehabisan kuota -> dicatat supaya request
 * berikutnya langsung melompat ke pasangan lain.
 * key: `${model}#${fingerprintKey}` -> timestamp (ms) sampai kapan di-skip.
 */
const PAIR_COOLDOWN = new Map();

/** Sidik jari API key yang dianggap tidak valid (401/403) -> tak dicoba lagi. */
const INVALID_KEYS = new Set();

/** Batas lama cooldown ketika API tidak memberi tahu sisa waktu (ms). */
const COOLDOWN_MS = 10 * 60 * 1000;

/** Batas atas cooldown (ms) supaya key fatigued tetap dicek sesekali. */
const COOLDOWN_MAX_MS = 30 * 60 * 1000;

/**
 * "Tangga config" yang cocok untuk tiap model -> index rung configLadder().
 * Dipakai supaya request berikutnya tidak mengulang opsi yang sudah pasti
 * ditolak (mis. `thinkingConfig` pada gemini-3.5-flash-lite).
 */
const MODEL_RUNG = new Map();

/** Cache client SDK per API key (mencegah pembuatan objek berulang). */
const CLIENTS = new Map();

/**
 * Client Gemini untuk API key tertentu.
 * @param {string} apiKey
 * @returns {import('@google/genai').GoogleGenAI}
 */
function getClient(apiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY belum diisi di file .env');
  const fp = keyFingerprint(apiKey);
  let client = CLIENTS.get(fp);
  if (!client) {
    client = new GoogleGenAI({ apiKey });
    CLIENTS.set(fp, client);
  }
  return client;
}

/* -------------------------------------------------------------------------
 *  SYSTEM INSTRUCTION
 *  Kunci utama: seluruh aturan bisnis bot ada di sini sehingga jawaban
 *  Gemini konsisten dan selalu berupa JSON murni.
 * ---------------------------------------------------------------------- */
const SYSTEM_INSTRUCTION = `
Kamu adalah mesin parsing transaksi keuangan pribadi untuk bot WhatsApp.
Tugasmu: mengubah pesan pengguna (teks atau transkrip voice note) menjadi SATU objek JSON yang valid.

=== ATURAN KERAS ===
1. Balas HANYA dengan JSON murni. Dilarang menulis teks lain, penjelasan,
   maupun blok kode markdown (\`\`\`).
2. Skema JSON:
   {
     "intent": "add_transaction" | "get_report" | "get_backup" | "unknown",
     "data": {
       "type": "expense" | "income",
       "amount": <number>,
       "category": "<kategori>",
       "wallet": "<nama wallet>",
       "description": "<deskripsi singkat>",
       "date": "<YYYY-MM-DD atau string kosong>",
       "time": "<HH:MM 24 jam atau string kosong>"
     }
   }
   Untuk intent selain "add_transaction", isi "data" dengan null.

3. Pemilihan "intent":
   - "add_transaction" : pesan berisi catatan transaksi
                         (pengeluaran maupun pemasukan).
   - "get_report"      : minta laporan, rekap, ringkasan, analisa saldo /
                         budget / pengeluaran bulan tertentu.
   - "get_backup"      : minta backup, unduh, ekspor, atau kirim file
                         Excel / spreadsheet / CSV.
   - "unknown"         : sisanya, atau informasi kurang untuk memutuskan.

4. "amount" (Rupiah, BULAT, tanpa desimal):
   - "25rb" / "25k" / "25.000" / "dua puluh lima ribu"  -> 25000
   - "1,2jt" / "1,2 juta" / "1.200.000"                 -> 1200000
   - "50 ribu"                                          -> 50000
   - WAJIB angka (tanpa tanda kutip). Jika intent BUKAN add_transaction
     atau nominal tidak disebut sama sekali -> 0.
   - Selalu Math.round ke integer.

5. "type":
   - default "expense".
   - "income" bila ada kata: gaji, gajian, dapat, masuk, bonus, dividen,
     untung, laku, terima, transfer masuk, cashback besar, pemasukan.

6. "category" (pilih SATU, jangan mengarang nama lain):
   - expense: "Makanan & Minuman", "Belanja", "Transport", "Tagihan",
              "Kesehatan", "Hiburan", "Pendidikan", "Sosial", "Lainnya"
   - income : "Gaji", "Freelance", "Bonus", "Investasi", "Lainnya"
   - Contoh: kopi/makan/nasi -> "Makanan & Minuman";
             bensin/ojek/grab/parkir -> "Transport";
             belanja/baju/supermarket -> "Belanja";
             listrik/air/internet/pulpa -> "Tagihan".

7. "wallet" (pilih salah satu):
   "Cash", "BCA", "MANDIRI", "BRI", "BNI", "QRIS", "GoPay", "OVO",
   "DANA", "ShopeePay".
   Jika tidak disebut -> "Cash".

8. "description": ringkasan maksimal 60 karakter dari kegiatan
   (boLeh memakai kembali teks pesan asli yang telah dirapikan).

9. "date": HANYA diisi bila pesan menyebut TANGGAL ("kemarin", "tadi pagi",
   "tanggal 5", "bulan ini") -> format "YYYY-MM-DD" (bukan UTC, bukan ISO
   lengkap). Jika tanggal tidak disebut -> string kosong "" (BUKAN null).
   Jangan menebak tanggal.

10. "time": HANYA diisi bila pesan menyebut JAM ("jam 10", "jam 10 pagi",
   "jam 10 malam", "jam 8", "pukul 14", "setengah jam 9", "jam 21.30") ->
   format "HH:MM" 24 jam:
     jam 10 pagi   -> "10:00"
     jam 10 malam  -> "22:00"
     jam 12 siang  -> "12:00"
     jam 12 malam  -> "00:00"
     jam 8         -> "08:00"
   Jika jam tidak disebut -> string kosong "" (BUKAN null).
   Kalau jam disebut tanpa tanggal -> tanggal dianggap HARI INI.
   Kalau tanggal disebut tanpa jam -> jam dianggap "00:00".

11. Tanggal & jam HARUS memakai zona waktu yang tertera pada bagian
   "KONTEKS WAKTU" di bawah (bukan UTC). Kalau jam disebut tanpa tanggal,
   jangan mengisi tanggal dengan tanggal lain.
`.trim();

/**
 * Tambahkan konteks waktu saat ini ke system instruction.
 * Tanpa ini model menebak-nebak tahun untuk kata "kemarin"/"bulan ini"
 * (mis. memakai tahun training-nya, bukan tahun berjalan).
 *
 * Zona waktu diambil dari `TIMEZONE` di .env, sehingga tanggal & jam yang
 * disebut user ("jam 10") dibaca sebagai waktu lokal bot, bukan UTC.
 *
 * @param {string} [base] system instruction dasar (default: parsing transaksi)
 * @returns {string} system instruction lengkap
 */
function buildSystemInstruction(base = SYSTEM_INSTRUCTION, timeZone = getTimezone()) {
  const today = todayInZone(timeZone);
  const clock = clockInZone(timeZone);

  return (
    `${base}\n\n` +
    `=== KONTEKS WAKTU (${timeZone}) ===\n` +
    `Tanggal hari ini: ${today}\n` +
    `Jam sekarang: ${clock}\n` +
    `Semua tanggal & jam pada pesan WAJIB memakai zona waktu ini (bukan UTC).\n` +
    `Gunakan tanggal di atas sebagai acuan untuk "hari ini", "kemarin", "tadi", ` +
    `"minggu lalu", "tanggal 5", "bulan ini", dan sebangsaunya.`
  );
}

/* -------------------------------------------------------------------------
 *  JSON Schema yang dipaksakan ke API (fallback tersedia bila ditolak)
 *
 *  PENTING: semua field di dalam `data` WAJIB (required) dan TIDAK memakai
 *  `nullable`. Kalau field-nya opsional, Gemini diam-diam boleh membalas JSON
 *  terpotong (mis. amount & description hilang) sehingga transaksi tercatat
 *  dengan nominal 0. Dengan schema ketat, field yang tidak relevan diisi
 *  nilai kosong / 0.
 * ---------------------------------------------------------------------- */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      enum: ['add_transaction', 'get_report', 'get_backup', 'unknown'],
    },
    data: {
      type: Type.OBJECT,
      nullable: true, // null untuk intent selain add_transaction
      properties: {
        type: { type: Type.STRING, enum: ['expense', 'income'] },
        amount: { type: Type.NUMBER },
        category: { type: Type.STRING },
        wallet: { type: Type.STRING },
        description: { type: Type.STRING },
        date: { type: Type.STRING }, // "YYYY-MM-DD" atau string kosong
        time: { type: Type.STRING }, // "HH:MM" 24 jam atau string kosong
      },
      required: ['type', 'amount', 'category', 'wallet', 'description', 'date', 'time'],
    },
  },
  required: ['intent', 'data'],
};

const VALID_INTENTS = ['add_transaction', 'get_report', 'get_backup', 'unknown'];

/* -------------------------------------------------------------------------
 *  PEMBACA STRUK BELANJA (foto struk -> data transaksi)
 *
 *  Schema & prompt TERPISAH dari parsing teks, karena struk punya bentuk
 *  data yang berbeda (total, toko, item, metode bayar, ...).
 * ---------------------------------------------------------------------- */
const RECEIPT_CATEGORIES = [
  'Makanan & Minuman',
  'Belanja',
  'Transport',
  'Tagihan',
  'Kesehatan',
  'Hiburan',
  'Pendidikan',
  'Sosial',
  'Lainnya',
];

const RECEIPT_INSTRUCTION = `
Kamu adalah pembaca struk belanja untuk bot WhatsApp pencatat keuangan pribadi.
Tugasmu: membaca FOTO STRUK yang dikirim pengguna lalu mengekstrak isinya
menjadi JSON sesuai skema.

=== ATURAN KERAS ===
1. Balas HANYA JSON murni sesuai skema. Dilarang ada penjelasan atau markdown.
2. Kalau gambar BUKAN struk (foto biasa, screenshot chat, wajah orang, dsb.):
   is_receipt = false, semua angka = 0, semua string kosong, items = [].
3. Angka rupiah TANPA pemisah ribuan:
   "25.000" -> 25000, "1.250.500" -> 1250500, "1.250,50" -> 1250.5.
   Perhatikan struk yang menulis harga dalam ribuan: "2,5" = 2500.
4. "total" = nominal yang WAJIB dibayar (label "TOTAL", "TOTAL BAYAR",
   "JUMLAH", "TUNDAI", "TOTAL TAGIHAN", "AMOUNT", "JUMLAH BAYAR").
   Gunakan TOTAL BUKAN subtotal. Kalau struk hanya punya subtotal + pajak,
   maka total = subtotal + tax.
5. "subtotal" = total sebelum pajak/diskon. "tax" = pajak/biaya tambahan
   yang tercetak terpisah (PPN, PB1, biaya admin, ongkir).
6. "store" = nama toko/merchant seperti tercetak di struk. Kalau tidak
   terbaca -> "".
7. "date" = tanggal transaksi -> format "YYYY-MM-DD". Kalau tanggal tidak
   tercetak atau tidak terbaca -> "" (JANGAN menebak).
8. "time" = jam transaksi yang tercetak di struk -> format "HH:MM" 24 jam
   ("19:32" -> "19:32", "07.05" -> "07:05", "7:05 PM" -> "19:05").
   Kalau jam tidak tercetak atau tidak terbaca -> "" (JANGAN menebak).
9. "payment_method" = metode pembayaran yang tercetak, apa adanya:
   "TUNDAI", "QRIS", "DEBIT BCA", "KREDIT MANDIRI", "GOPAY", "OVO", "DANA",
   "SHOPEEPAY", "BCA", "MANDIRI", "BRI", "BNI", "VA", dll.
   Kalau tidak tercetak -> "TUNDAI".
10. "items" = daftar barang yang dibeli (maks 20 baris). Setiap item:
   { "name": nama barang, "qty": jumlah (angka; 1 bila tak tertulis),
     "price": TOTAL harga baris itu (angka, sudah dikali qty),
     "category": kategori dari daftar di bawah }
   Abaikan baris yang bukan barang: "SUBTOTAL", "PPN", "PST", "TUNDAI",
   "KARTU", "NO. KARTU", "TERIMA KASIH", "KODE BARANG", "DISKON", "CHANGE".
11. "category" = kategori transaksi dari struk, pilih SATU dari:
    "Makanan & Minuman", "Belanja", "Transport", "Tagihan", "Kesehatan",
    "Hiburan", "Pendidikan", "Sosial", "Lainnya"
    Panduan: supermarket/indomaret/alfamart/toko bahan groceries ->
    "Belanja"; restoran/kafe/warung/mbak -> "Makanan & Minuman";
    apotek -> "Kesehatan"; bengkel/SPBU -> "Transport"; tokopedia/
    shopee/lazada -> "Belanja".
12. "notes" = catatan relevan lain (mis. "Diskon 5rb", "Bayar QRIS BCA").
    String kosong bila tidak ada.
`.trim();

/** Schema JSON untuk pembacaan struk (ketat, semua field wajib). */
const RECEIPT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    is_receipt: { type: Type.BOOLEAN },
    store: { type: Type.STRING },
    total: { type: Type.NUMBER },
    subtotal: { type: Type.NUMBER },
    tax: { type: Type.NUMBER },
    payment_method: { type: Type.STRING },
    date: { type: Type.STRING },
    time: { type: Type.STRING },
    category: { type: Type.STRING },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          qty: { type: Type.NUMBER },
          price: { type: Type.NUMBER },
          category: { type: Type.STRING },
        },
        required: ['name', 'qty', 'price', 'category'],
      },
    },
    notes: { type: Type.STRING },
  },
  required: [
    'is_receipt',
    'store',
    'total',
    'subtotal',
    'tax',
    'payment_method',
    'date',
    'time',
    'category',
    'items',
    'notes',
  ],
};

/* -------------------------------------------------------------------------
 *  Helper internal
 * ---------------------------------------------------------------------- */

/** Response SDK -> string teks jawaban (aman dari kasus safety-block). */
function extractResponseText(response) {
  try {
    if (response?.text) return response.text;
  } catch {
    /* getter .text bisa melempar saat finishReason memblokir */
  }
  const parts = response?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p?.text ?? '').join('');
}

/** Buang bungkus ```json, ambil objek {...} paling luar, lalu parse. */
function safeJsonParse(text) {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`Respons bukan JSON: ${cleaned.slice(0, 120)}`);
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** Paksa hasil sesuai kontrak sebelum dipakai modul lain. */
function normalizeResult(raw, timeZone = getTimezone()) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  } catch (err) {
    throw new Error(`Gemini mengirim JSON tidak valid: ${err.message}`);
  }

  const intent = VALID_INTENTS.includes(parsed?.intent) ? parsed.intent : 'unknown';
  if (intent !== 'add_transaction' || !parsed?.data) {
    return { intent, data: null };
  }

  const d = parsed.data;
  // amount: kadang model mengirim "25.000" (string) -> buang pemisah ribuan
  const numeric =
    typeof d.amount === 'number'
      ? d.amount
      : Number(String(d.amount ?? '').replace(/[^\d]/g, ''));

  return {
    intent,
    data: {
      type: d.type === 'income' ? 'income' : 'expense',
      amount: Number.isFinite(numeric) ? Math.round(Math.abs(numeric)) : 0,
      category: typeof d.category === 'string' && d.category.trim() ? d.category.trim() : 'Lainnya',
      wallet: typeof d.wallet === 'string' && d.wallet.trim() ? d.wallet.trim() : 'Cash',
      description:
        typeof d.description === 'string' && d.description.trim()
          ? d.description.trim().slice(0, 120)
          : '',
      // Tanggal + jam yang disebut user -> timestamp ISO UTC.
      // null = tidak ada tanggal/jam -> pakai waktu saat pencatatan.
      date: combineDateTime(d.date, d.time, timeZone),
      time: normalizeTime(d.time),
    },
  };
}

/**
 * Config yang dicoba untuk satu model, dari paling lengkap ke paling minimal.
 * Tidak semua model mendukung semua fitur:
 *   - `gemini-3.5-flash-lite` menolak `thinkingConfig` (400 invalid argument)
 *   - sebagian model menolak `responseSchema`
 * Kalau model menolak sebuah opsi (400), turuni ke opsi berikutnya.
 *
 * @param {object|null} schema schema yang dipaksakan (null = tanpa schema)
 * @returns {Array<object>} daftar config, urut dari paling lengkap
 */
function configLadder(schema) {
  const ladder = [];
  if (schema) {
    ladder.push({ responseSchema: schema, thinkingConfig: { thinkingBudget: 0 } });
    ladder.push({ responseSchema: schema });
  }
  ladder.push({});
  return ladder;
}

/**
 * Ambil status HTTP dari error SDK / fetch.
 * @param {any} err
 * @returns {number|null}
 */
function errorStatus(err) {
  return err?.status ?? err?.code ?? err?.response?.status ?? null;
}

/**
 * Panggil model dan kembalikan teks mentah jawabannya.
 * Mencoba model-model secara berurutan sampai ada yang berhasil.
 *
 * @param {Array} parts parts pesan (teks / inlineData audio / inlineData gambar)
 * @param {object|null} [schema] schema JSON yang dipaksakan ke model
 * @param {string} [instruction] system instruction khusus untuk flow ini
 * @returns {Promise<string>} teks JSON mentah dari model
 */
async function generateJSON(parts, schema = RESPONSE_SCHEMA, instruction = SYSTEM_INSTRUCTION, timeZone = getTimezone(), options = {}) {
  const apiKeys = getApiKeys();
  if (!apiKeys.length) {
    throw new Error('GEMINI_API_KEY / GEMINI_API_KEYS belum diisi di file .env');
  }
  const models = getModels();

  const expectJson = options.expectJson !== false && Boolean(schema);
  const temperature = options.temperature ?? (expectJson ? 0.1 : 0.4);
  const maxOutputTokens = options.maxOutputTokens ?? (expectJson ? 1024 : 4096);
  const responseMimeType = options.responseMimeType ?? (expectJson ? 'application/json' : 'text/plain');

  const baseConfig = {
    systemInstruction: buildSystemInstruction(instruction, timeZone),
    temperature,
    maxOutputTokens,
    ...(responseMimeType ? { responseMimeType } : {}),
  };

  const failures = [];
  let quotaExceeded = false;

  // Loop: model (luar) x API key (dalam).
  // Setiap key = 1 project = kuota terpisah, jadi saat satu key kena 429
  // coba model yang sama dengan key berikutnya dulu.
  for (const model of models) {
    for (let keyIdx = 0; keyIdx < apiKeys.length; keyIdx++) {
      const apiKey = apiKeys[keyIdx];
      const fp = keyFingerprint(apiKey);

      // Key yang sudah dinyatakan invalid -> jangan dicoba lagi.
      if (INVALID_KEYS.has(fp)) continue;

      // Pasangan (model, key) yang baru saja kena limit -> lewati.
      const pairKey = `${model}#${fp}`;
      const until = PAIR_COOLDOWN.get(pairKey);
      if (until && until > Date.now()) {
        failures.push(`${model}/key${keyIdx + 1}: limit (dilewati)`);
        quotaExceeded = true;
        continue;
      }

      const ai = getClient(apiKey);

      // Mulai dari "tangga config" yang terakhir dipakai untuk model ini,
      // supaya kita tidak mengulang request yang sudah pasti ditolak (400).
      const ladder = configLadder(schema);
      const rungKey = `${model}#${schema ? 'schema' : 'plain'}`;
      const startRung = MODEL_RUNG.get(rungKey) ?? 0;

      for (let rung = startRung; rung < ladder.length; rung++) {
        const extra = ladder[rung];
        try {
          const response = await ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts }],
            config: { ...baseConfig, ...extra },
          });

          const text = extractResponseText(response);
          if (!text.trim()) {
            failures.push(`${model}/key${keyIdx + 1}: respons kosong`);
            break; // coba key/model lain
          }

          // Validasi JSON di sini (hanya bila expectJson): model yang balas
          // JSON rusak (terpotong / teks reasoning bocor) langsung di-skip.
          if (expectJson) {
            try {
              safeJsonParse(text);
            } catch {
              failures.push(`${model}/key${keyIdx + 1}: JSON tidak valid`);
              break; // coba key/model lain
            }
          }

          MODEL_RUNG.set(rungKey, rung); // config ini cocok untuk model ini
          return text;
        } catch (err) {
          const status = errorStatus(err);
          const msg = String(err?.message ?? '');

          // 429 = kuota habis. Berlaku untuk (model + key) ini -> lewati
          // pasangan ini, coba key berikutnya untuk model yang sama.
          if (status === 429) {
            const cooldown = Math.min(parseRetryDelayMs(err) ?? COOLDOWN_MS, COOLDOWN_MAX_MS);
            PAIR_COOLDOWN.set(pairKey, Date.now() + cooldown);
            failures.push(`${model}/key${keyIdx + 1}: 429 kuota habis`);
            quotaExceeded = true;
            console.warn(
              `[Gemini] ${model} + API key #${keyIdx + 1} kehabisan kuota, coba key berikutnya.`
            );
            break;
          }

          // 401/403 atau "API key not valid" -> key rusak, jangan dipakai lagi.
          if (status === 401 || status === 403 || /api key/i.test(msg)) {
            INVALID_KEYS.add(fp);
            failures.push(`${model}/key${keyIdx + 1}: key tidak valid`);
            console.warn(`[Gemini] API key #${keyIdx + 1} tidak valid, dilewati.`);
            break;
          }

          // 503 = overload sementara -> key/model lain mungkin masih aman.
          if (status === 503) {
            failures.push(`${model}/key${keyIdx + 1}: 503 overload`);
            console.warn(`[Gemini] ${model} sedang overload, coba yang lain.`);
            break;
          }

          // 404 = model tidak tersedia (mis. model lama utk akun baru) ->
          // lewati model ini, key/model lain mungkin masih bisa dipakai.
          if (status === 404) {
            failures.push(`${model}/key${keyIdx + 1}: 404 model tidak tersedia`);
            console.warn(`[Gemini] ${model} tidak tersedia, lewati.`);
            break;
          }

          // 400 = opsi config tidak didukung -> coba config yang lebih ringan.
          if (status === 400) {
            const opsi = Object.keys(extra).join('+') || 'tanpa-opsi';
            console.warn(`[Gemini] ${model} menolak opsi "${opsi}", mencoba config lebih ringan.`);
            failures.push(`${model}/key${keyIdx + 1}: 400 (${opsi} ditolak)`);
            MODEL_RUNG.set(rungKey, rung + 1); // ingat, jangan ulangi request ini
            continue;
          }

          // Error lain -> biarkan error aslinya naik ke pemanggil.
          throw err;
        }
      }
    }
  }

  // Semua kombinasi model x key gagal.
  if (quotaExceeded) {
    const err = new Error(
      `Kuota/limit Gemini habis untuk semua model & API key (${failures.join('; ')}). ` +
        'Coba lagi beberapa saat lagi.'
    );
    err.code = 'GEMINI_QUOTA_EXCEEDED';
    err.status = 429;
    throw err;
  }

  const err = new Error(`Semua model/API key Gemini gagal: ${failures.join('; ')}`);
  err.code = 'GEMINI_ALL_FAILED';
  throw err;
}

/**
 * Ambil sisa waktu dari error Google ("Please retry in 19h36m" / retryDelay).
 * @param {any} err
 * @returns {number|null} durasi dalam ms
 */
function parseRetryDelayMs(err) {
  const msg = String(err?.message ?? '');

  // Format: "retryDelay": "70566s"  (detail RetryInfo)
  const secs = msg.match(/"retryDelay"\s*:\s*"?(\d+(?:\.\d+)?)s"?/);
  if (secs) return Number(secs[1]) * 1000;

  // Format: "Please retry in 19h36m6s"
  const human = msg.match(/retry in\s+(\d+)h(\d+)m(\d+(?:\.\d+)?)s/i);
  if (human) {
    return (Number(human[1]) * 3600 + Number(human[2]) * 60 + Number(human[3])) * 1000;
  }

  const mins = msg.match(/retry in\s+(\d+)m/i);
  if (mins) return Number(mins[1]) * 60 * 1000;

  return null;
}

/**
 * Status rotasi model & API key (untuk debugging / perintah !ai).
 * API key ditampilkan dalam bentuk disamarkan (tidak pernah ditampilkan utuh).
 *
 * @returns {{
 *   models: string[],
 *   keys: Array<{ index:number, masked:string, invalid:boolean, exhaustedModels:string[] }>,
 *   exhaustedPairs: string[]
 * }}
 */
/**
 * Hasilkan teks bebas (Markdown) dari model, tanpa memaksa JSON.
 * Dipakai untuk fitur analisis/laporan naratif.
 *
 * @param {Array} parts parts pesan (teks)
 * @param {string} [instruction] system instruction khusus
 * @param {{timezone?:string, maxOutputTokens?:number, temperature?:number}} [opts]
 * @returns {Promise<string>} teks jawaban model
 */
export async function generateText(parts, instruction = SYSTEM_INSTRUCTION, opts = {}) {
  const timeZone = opts.timezone || getTimezone();
  return generateJSON(parts, null, instruction, timeZone, {
    expectJson: false,
    maxOutputTokens: opts.maxOutputTokens ?? 4096,
    temperature: opts.temperature ?? 0.4,
    responseMimeType: 'text/plain',
  });
}

export function getRotationStatus() {
  const now = Date.now();
  const apiKeys = getApiKeys();
  const models = getModels();

  const keys = apiKeys.map((apiKey, i) => {
    const fp = keyFingerprint(apiKey);
    return {
      index: i + 1,
      masked: maskApiKey(apiKey),
      invalid: INVALID_KEYS.has(fp),
      exhaustedModels: models.filter((m) => {
        const until = PAIR_COOLDOWN.get(`${m}#${fp}`);
        return until && until > now;
      }),
    };
  });

  const exhaustedPairs = [];
  for (const [pair, until] of PAIR_COOLDOWN.entries()) {
    if (until > now) exhaustedPairs.push(pair.split('#')[0]);
  }

  return {
    models,
    keys,
    exhaustedPairs: [...new Set(exhaustedPairs)],
  };
}

/** Batas ukuran media inline Gemini ± 20 MB. */
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

/* -------------------------------------------------------------------------
 *  API publik
 * ---------------------------------------------------------------------- */

/**
 * Parse pesan TEKS natural -> { intent, data }.
 * Contoh: "Beli kopi 25rb pakai QRIS"
 *        -> { intent:'add_transaction', data:{ amount:25000, wallet:'QRIS', ... } }
 *
 * @param {string} text pesan dari pengguna
 * @returns {Promise<{intent:string, data:object|null}>}
 */
export async function parseTextMessage(text, { timezone = null } = {}) {
  const tz = timezone || getTimezone();
  const raw = await generateJSON([{ text: String(text).slice(0, 4000) }], RESPONSE_SCHEMA, SYSTEM_INSTRUCTION, tz);
  return normalizeResult(raw, tz);
}

/**
 * Parse VOICE NOTE (buffer audio) -> { intent, data }.
 * Audio dikirim langsung ke Gemini sebagai inlineData (transkripsi +
 * ekstraksi dilakukan oleh model dalam satu langkah).
 *
 * @param {Buffer} buffer   hasil unduhan media dari Baileys
 * @param {string} mimeType mis. 'audio/ogg; codecs=opus'
 * @returns {Promise<{intent:string, data:object|null}>}
 */
export async function parseVoiceNote(buffer, mimeType = 'audio/ogg', { timezone = null } = {}) {
  const tz = timezone || getTimezone();
  if (!buffer?.length) throw new Error('Voice note kosong');
  if (buffer.length > MAX_INLINE_BYTES) {
    throw new Error('Voice note terlalu besar untuk dianalisis (>20MB)');
  }

  const parts = [
    {
      inlineData: {
        mimeType: (mimeType || 'audio/ogg').split(';')[0].trim(),
        data: buffer.toString('base64'),
      },
    },
    {
      text:
        'Pengguna mengirim VOICE NOTE (audio di atas). Terapkan seluruh aturan ' +
        'parsing dan balas hanya dengan JSON sesuai skema.',
    },
  ];

  const raw = await generateJSON(parts, RESPONSE_SCHEMA, SYSTEM_INSTRUCTION, tz);
  return normalizeResult(raw, tz);
}

/**
 * Router utama: parse teks ATAU audio dalam satu panggilan.
 * @param {{text?:string|null, audio?:Buffer|null, mimeType?:string}} input
 * @returns {Promise<{intent:string, data:object|null}>}
 */
export async function parseMessage({ text = null, audio = null, mimeType = null, timezone = null } = {}) {
  if (audio?.length) return parseVoiceNote(audio, mimeType, { timezone });
  if (text) return parseTextMessage(text, { timezone });
  return { intent: 'unknown', data: null };
}

/* -------------------------------------------------------------------------
 *  PEMBACA STRUK (gambar)
 * ---------------------------------------------------------------------- */

/** Buang angka jadi number bulat & pastikan tidak negatif. */
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.abs(n)) : 0;
}

/**
 * Normalisasi hasil pembacaan struk supaya aman dipakai modul lain.
 * @param {string|object} raw
 * @returns {object} data struk yang sudah tervalidasi
 */
function normalizeReceipt(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  } catch (err) {
    throw new Error(`Gemini mengirim JSON tidak valid untuk struk: ${err.message}`);
  }

  const items = (Array.isArray(parsed?.items) ? parsed.items : [])
    .map((it) => ({
      name: String(it?.name ?? '').trim(),
      qty: toNumber(it?.qty) || 1,
      price: toNumber(it?.price),
      category: RECEIPT_CATEGORIES.includes(it?.category) ? it.category : 'Belanja',
    }))
    .filter((it) => it.name && it.price > 0)
    .slice(0, 20);

  const subtotal = toNumber(parsed?.subtotal);
  const tax = toNumber(parsed?.tax);
  let total = toNumber(parsed?.total);

  // Kalau model hanya memberi subtotal (+ pajak), turunkan ke total.
  if (!total && subtotal) total = subtotal + tax;

  // Tanggal dipakai kalau formatnya bisa dibaca (YYYY-MM-DD atau 18/10/2026).
  const date = normalizeDate(parsed?.date);

  // Jam transaksi yang tercetak di struk (HH:MM 24 jam).
  const time = normalizeTime(parsed?.time);

  return {
    is_receipt: parsed?.is_receipt === true,
    store: String(parsed?.store ?? '').trim().slice(0, 60),
    total,
    subtotal,
    tax,
    payment_method: String(parsed?.payment_method ?? '').trim().slice(0, 40),
    date,
    time,
    category: RECEIPT_CATEGORIES.includes(parsed?.category) ? parsed.category : 'Belanja',
    items,
    notes: String(parsed?.notes ?? '').trim().slice(0, 200),
  };
}

/**
 * Deteksi tipe gambar dari magic bytes.
 * Dipakai sebagai cadangan bila WhatsApp/Baileys tidak mengirim mimetype —
 * mime yang salah bikin API menolak gambar dengan 400.
 *
 * @param {Buffer} buffer
 * @returns {string} mime type
 */
function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return 'image/jpeg';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return 'image/jpeg';
}

/**
 * Baca FOTO STRUK -> data transaksi siap catat.
 *
 * @param {Buffer} buffer      hasil unduhan gambar dari Baileys
 * @param {string} mimeType    mis. 'image/jpeg'
 * @param {{caption?:string}} [opts] caption (teks yang dilampirkan user)
 * @returns {Promise<object>} data struk yang sudah tervalidasi
 */
export async function parseReceiptImage(buffer, mimeType = 'image/jpeg', { caption = '', timezone = null } = {}) {
  const tz = timezone || getTimezone();
  if (!buffer?.length) throw new Error('Gambar kosong');
  if (buffer.length > MAX_INLINE_BYTES) {
    throw new Error('Gambar terlalu besar untuk dianalisis (>20MB)');
  }

  const declared = String(mimeType || '').split(';')[0].trim();
  const mime =
    declared && declared !== 'application/octet-stream'
      ? declared
      : detectImageMime(buffer);

  const parts = [
    {
      inlineData: {
        mimeType: mime,
        data: buffer.toString('base64'),
      },
    },
    {
      text:
        'Pengguna mengirim FOTO STRUK (gambar di atas). Baca struknya dan balas ' +
        'hanya dengan JSON sesuai skema.' +
        (caption ? ` Catatan pengguna: "${String(caption).slice(0, 300)}".` : ''),
    },
  ];

  const raw = await generateJSON(parts, RECEIPT_SCHEMA, RECEIPT_INSTRUCTION, tz);
  return normalizeReceipt(raw);
}
