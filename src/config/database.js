/**
 * src/config/database.js
 * Database LOKAL berbasis file JSON (safe write).
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeTimezone, getTimezone, zonedParts } from '../utils/datetime.js';

export function getDataDir() {
  return path.resolve(process.env.DATA_DIR || './data');
}

export const COLLECTIONS = ['users', 'transactions', 'wallets', 'budgets', 'categories', 'contacts'];

export const DEFAULT_WALLETS = ['Cash', 'BCA', 'QRIS', 'GoPay'];

const writeQueues = new Map();

function enqueue(key, task) {
  const tail = writeQueues.get(key) ?? Promise.resolve();
  const run = tail.then(task);
  writeQueues.set(
    key,
    run.catch((err) => console.error(`[DB] task ${key} gagal:`, err?.message)),
  );
  return run;
}

function fileOf(name) {
  return path.join(getDataDir(), `${name}.json`);
}

/**
 * Koleksi yang file-nya sedang rusak (tidak bisa di-parse).
 * Dipakai untuk MENCEGAH penulisan yang akan menimpa data lama dengan
 * array kosong — sumber kehilangan data yang paling berbahaya.
 * @type {Map<string, {file: string, archivedTo: string|null, error: string, at: string}>}
 */
const corruptCollections = new Map();

/**
 * Tandai koleksi sebagai korup, simpan salinan sekali, lalu kembalikan
 * state kosong supaya pemanggil (bot) tetap bisa jalan.
 */
async function markCorrupt(name, file, err) {
  let info = corruptCollections.get(file);
  if (!info) {
    let archivedTo = null;
    try {
      archivedTo = `${file}.corrupt-${Date.now()}`;
      await fs.copyFile(file, archivedTo);
    } catch {
      archivedTo = null;
    }
    info = { name, file, archivedTo, error: err.message, at: new Date().toISOString() };
    corruptCollections.set(file, info);
    console.error(`[DB] ${path.basename(file)} KORUP: ${err.message}`);
    console.error(`[DB] Data lama TIDAK akan ditimpa. Salinan: ${archivedTo || '(gagal dibuat)'}`);
    console.error(
      `[DB] Perbaiki file tersebut, atau pindahkan/hapus agar koleksi dimulai kosong.`,
    );
  }
  return { records: [], corrupt: true, error: info.error, archivedTo: info.archivedTo };
}

/**
 * Baca satu koleksi beserta status kesehatannya.
 * @returns {Promise<{records: any[], corrupt: boolean, error?: string, archivedTo?: string|null}>}
 */
async function readState(name) {
  const file = fileOf(name);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      corruptCollections.delete(file);
      return { records: [], corrupt: false };
    }
    throw err;
  }

  // File kosong dianggap koleksi kosong (bukan korup).
  if (!raw.trim()) {
    corruptCollections.delete(file);
    return { records: [], corrupt: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return markCorrupt(name, file, err);
  }
  if (!Array.isArray(parsed)) {
    return markCorrupt(name, file, new Error('isi file bukan array JSON'));
  }

  // Sehat kembali (mis. sudah diperbaiki manual) -> lepas tanda korup.
  corruptCollections.delete(file);
  return { records: parsed, corrupt: false };
}

/**
 * Baca isi koleksi. Bila file korup, kembalikan array kosong agar bot tetap
 * hidup — tetapi penulisan ke koleksi itu akan ditolak (lihat `writeAtomic`).
 * @returns {Promise<any[]>}
 */
export async function readCollection(name) {
  const state = await readState(name);
  return state.records;
}

/**
 * Daftar koleksi yang saat ini rusak — untuk ditampilkan di dashboard/log.
 * @returns {Array<{name: string, file: string, archivedTo: string|null, error: string, at: string}>}
 */
/**
 * Pindai semua koleksi dan laporkan yang rusak.
 * Dipakai endpoint `/health` supaya kerusakan file terdeteksi tanpa menunggu
 * ada request lain yang kebetulan membaca koleksi tersebut.
 * @returns {Promise<Array<{name: string, file: string, archivedTo: string|null, error: string, at: string}>>}
 */
export async function scanCorruptCollections() {
  for (const name of COLLECTIONS) {
    try {
      await readState(name);
    } catch {
      /* error I/O lain: biarkan ditangani pemanggil */
    }
  }
  return listCorruptCollections();
}

export function listCorruptCollections() {
  // Buang entri basi: file sudah tidak ada (mis. dipindahkan admin atau
  // DATA_DIR berganti), jadi tidak lagi relevan dilaporkan sebagai korup.
  for (const [key, info] of corruptCollections) {
    if (!fsSync.existsSync(info.file)) corruptCollections.delete(key);
  }
  return [...corruptCollections.values()].map((info) => ({ ...info }));
}

async function writeAtomic(name, records) {
  // Jangan pernah menimpa koleksi korup: array kosong hasil pembacaan gagal
  // akan menghapus seluruh data lama secara permanen.
  const corrupt = corruptCollections.get(fileOf(name));
  if (corrupt) {
    throw new Error(
      `Koleksi "${name}" rusak (${corrupt.error}). Penulisan dibatalkan agar data lama tidak hilang. ` +
        `Perbaiki ${path.basename(corrupt.file)} atau pindahkan file tersebut, lalu coba lagi.`,
    );
  }

  const dir = getDataDir();
  await fs.mkdir(dir, { recursive: true });
  const target = fileOf(name);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, target);
}

export function writeCollection(name, records) {
  return enqueue(name, () => writeAtomic(name, records));
}

export async function withCollection(name, mutator) {
  return enqueue(name, async () => {
    // Baca lewat readState agar status korup terdeteksi SEBELUM mutasi,
    // sehingga writeAtomic bisa menolak dan data lama tetap utuh.
    const { records } = await readState(name);
    const result = await mutator(records);
    await writeAtomic(name, records);
    return result;
  });
}

/* USERS */
export async function getUser(phone) {
  const users = await readCollection('users');
  return users.find((u) => u.phone === phone) ?? null;
}

export async function getUserTimezone(phone) {
  const user = await getUser(phone);
  const tz = user?.timezone;
  return tz && normalizeTimezone(tz) ? tz : getTimezone();
}

export async function setUserTimezone(phone, timezone) {
  const tz = normalizeTimezone(timezone);
  if (!tz) throw new Error('Zona waktu tidak dikenali');
  return withCollection('users', (users) => {
    let found = users.find((u) => u.phone === phone);
    if (!found) {
      found = { phone, name: phone, created_at: new Date().toISOString(), timezone: tz };
      users.push(found);
    } else {
      found.timezone = tz;
    }
    return found;
  });
}

export async function listUsers() {
  return readCollection('users');
}

export const TIERS = ['free', 'basic', 'premium', 'sultan'];

export function normalizeTier(tier) {
  const t = String(tier || 'free').toLowerCase();
  return TIERS.includes(t) ? t : 'free';
}

export function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function applyUserDefaults(user) {
  if (!user.tier) user.tier = 'free';
  user.tier = normalizeTier(user.tier);
  if (typeof user.text_quota_used !== 'number') user.text_quota_used = 0;
  if (typeof user.media_quota_used !== 'number') user.media_quota_used = 0;
  if (!user.last_media_reset_daily) user.last_media_reset_daily = todayKey();
  if (!user.quota_reset_date) user.quota_reset_date = `${currentMonthKey()}-01`;
  if (user.sultan_bot_limit === undefined || user.sultan_bot_limit === null) user.sultan_bot_limit = 1;
  if (!Array.isArray(user.active_bot_instances)) user.active_bot_instances = [];
  if (user.tier_expired_at === undefined) user.tier_expired_at = null;
  return user;
}

export async function upsertUser(phone, name = phone) {
  const { user, isNew } = await withCollection('users', (users) => {
    let found = users.find((u) => u.phone === phone);
    if (!found) {
      found = {
        phone,
        name: name || phone,
        created_at: new Date().toISOString(),
        timezone: getTimezone(),
        tier: 'free',
        text_quota_used: 0,
        media_quota_used: 0,
        last_media_reset_daily: todayKey(),
        quota_reset_date: `${currentMonthKey()}-01`,
        tier_expired_at: null,
        sultan_bot_limit: 1,
        active_bot_instances: [],
      };
      users.push(found);
      return { user: found, isNew: true };
    }
    if (name && name !== phone) found.name = name;
    applyUserDefaults(found);
    return { user: found, isNew: false };
  });

  if (isNew) await ensureDefaultWallets(phone);
  return applyUserDefaults(user);
}

export async function setUserTier(phone, tier, expiredAt = null) {
  return withCollection('users', (users) => {
    const found = users.find((u) => u.phone === phone);
    if (!found) throw new Error('User tidak ditemukan');
    applyUserDefaults(found);
    found.tier = normalizeTier(tier);
    found.tier_expired_at = expiredAt;
    found.updated_at = new Date().toISOString();
    return found;
  });
}

function getBackupDir() {
  return path.resolve(process.env.BACKUP_DIR || './backups');
}

export async function restoreUserBackup(phone, payload = {}, mode = 'replace') {
  const targetPhone = phone || payload?.user?.phone;
  if (!targetPhone) throw new Error('Phone target tidak ditemukan');

  // safety backup
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(getBackupDir(), `pre_restore_${targetPhone}_${stamp}.json`);
  await fs.mkdir(getBackupDir(), { recursive: true });
  const current = {
    meta: { phone: targetPhone, exported_at: new Date().toISOString(), type: 'pre_restore' },
    user: await getUser(targetPhone),
    transactions: await listTransactions(targetPhone),
    wallets: await getWallets(targetPhone),
    budgets: await getBudgets(targetPhone),
  };
  await fs.writeFile(backupPath, JSON.stringify(current, null, 2), 'utf8');

  const incomingTx = Array.isArray(payload.transactions) ? payload.transactions : [];
  const incomingWallets = Array.isArray(payload.wallets) ? payload.wallets : [];
  const incomingBudgets = Array.isArray(payload.budgets) ? payload.budgets : [];

  if (mode === 'replace') {
    await withCollection('transactions', (list) => {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].user_phone === targetPhone) list.splice(i, 1);
      for (const t of incomingTx) list.push({ ...t, user_phone: targetPhone });
    });
    await withCollection('wallets', (list) => {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].user_phone === targetPhone) list.splice(i, 1);
      for (const w of incomingWallets) list.push({ ...w, user_phone: targetPhone });
    });
    await withCollection('budgets', (list) => {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].user_phone === targetPhone) list.splice(i, 1);
      for (const b of incomingBudgets) list.push({ ...b, user_phone: targetPhone });
    });
  } else {
    // merge
    await withCollection('transactions', (list) => {
      const ids = new Set(list.filter((t) => t.user_phone === targetPhone).map((t) => t.id));
      for (const t of incomingTx) {
        if (t.id && ids.has(t.id)) continue;
        list.push({ ...t, user_phone: targetPhone });
        if (t.id) ids.add(t.id);
      }
    });
    await withCollection('wallets', (list) => {
      const names = new Set(list.filter((w) => w.user_phone === targetPhone).map((w) => w.name));
      for (const w of incomingWallets) {
        if (names.has(w.name)) continue;
        list.push({ ...w, user_phone: targetPhone });
        names.add(w.name);
      }
    });
    await withCollection('budgets', (list) => {
      const keys = new Set(list.filter((b) => b.user_phone === targetPhone).map((b) => b.category));
      for (const b of incomingBudgets) {
        if (keys.has(b.category)) continue;
        list.push({ ...b, user_phone: targetPhone });
        keys.add(b.category);
      }
    });
  }

  if (payload.user && typeof payload.user === 'object') {
    await updateUserFields(targetPhone, {
      name: payload.user.name,
      tier: payload.user.tier,
      tier_expired_at: payload.user.tier_expired_at,
      text_quota_used: payload.user.text_quota_used,
      media_quota_used: payload.user.media_quota_used,
      sultan_bot_limit: payload.user.sultan_bot_limit,
    });
  }

  return { phone: targetPhone, mode, restored: incomingTx.length, backupPath };
}

export async function updateUserFields(phone, fields = {}) {
  return withCollection('users', (users) => {
    const found = users.find((u) => u.phone === phone);
    if (!found) throw new Error('User tidak ditemukan');
    applyUserDefaults(found);
    if (fields.tier !== undefined) found.tier = normalizeTier(fields.tier);
    if (fields.tier_expired_at !== undefined) found.tier_expired_at = fields.tier_expired_at;
    if (fields.text_quota_used !== undefined) found.text_quota_used = Number(fields.text_quota_used) || 0;
    if (fields.media_quota_used !== undefined) found.media_quota_used = Number(fields.media_quota_used) || 0;
    if (fields.sultan_bot_limit !== undefined) found.sultan_bot_limit = Math.max(0, Number(fields.sultan_bot_limit) || 0);
    if (fields.name !== undefined) found.name = fields.name;
    found.updated_at = new Date().toISOString();
    return found;
  });
}

/* TRANSACTIONS */
export async function addTransaction(fields) {
  const now = new Date().toISOString();
  const tx = {
    id: crypto.randomUUID(),
    user_phone: fields.user_phone,
    type: fields.type === 'income' ? 'income' : 'expense',
    amount: Math.round(Math.abs(Number(fields.amount) || 0)),
    category: fields.category || 'Lainnya',
    wallet: fields.wallet || 'Cash',
    description: fields.description || '',
    date: fields.date || now,
    created_at: now,
  };
  if (Array.isArray(fields.items) && fields.items.length) {
    tx.items = fields.items.slice(0, 30);
  }
  if (fields.source) tx.source = fields.source;

  await withCollection('transactions', (list) => {
    list.push(tx);
  });

  await ensureWalletExists(tx.user_phone, tx.wallet);
  return tx;
}

export async function getTransactionById(id) {
  const all = await readCollection('transactions');
  return all.find((t) => t.id === id) ?? null;
}

export async function updateTransaction(id, fields) {
  return withCollection('transactions', (list) => {
    const tx = list.find((t) => t.id === id);
    if (!tx) return null;
    if (fields.type !== undefined) tx.type = fields.type === 'income' ? 'income' : 'expense';
    if (fields.amount !== undefined) tx.amount = Math.round(Math.abs(Number(fields.amount) || 0));
    if (fields.category !== undefined) tx.category = fields.category || 'Lainnya';
    if (fields.wallet !== undefined) tx.wallet = fields.wallet || 'Cash';
    if (fields.description !== undefined) tx.description = fields.description || '';
    if (fields.date !== undefined) tx.date = fields.date;
    if (Array.isArray(fields.items)) tx.items = fields.items.slice(0, 30);
    if (fields.source !== undefined) tx.source = fields.source;
    tx.updated_at = new Date().toISOString();
    return tx;
  });
}

export async function deleteTransaction(id) {
  return withCollection('transactions', (list) => {
    const idx = list.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    return true;
  });
}

export async function listTransactions(phone, { month = null, type = null } = {}) {
  const all = await readCollection('transactions');
  return all
    .filter((t) => t.user_phone === phone)
    .filter((t) => (month ? String(t.date ?? '').slice(0, 7) === month : true))
    .filter((t) => (type ? t.type === type : true))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

export async function getStats(phone, month = null) {
  const txs = await listTransactions(phone, { month });
  let income = 0;
  let expense = 0;
  for (const t of txs) {
    if (t.type === 'income') income += t.amount;
    else expense += t.amount;
  }
  return { income, expense, net: income - expense, count: txs.length };
}

export async function getCategoryExpenses(phone, month = null) {
  const txs = await listTransactions(phone, { month, type: 'expense' });
  const result = {};
  for (const t of txs) {
    const key = t.category || 'Lainnya';
    result[key] = (result[key] || 0) + t.amount;
  }
  return result;
}

/* WALLETS */
export async function getWallets(phone) {
  const wallets = await readCollection('wallets');
  return wallets.filter((w) => w.user_phone === phone);
}

async function ensureDefaultWallets(phone) {
  await withCollection('wallets', (wallets) => {
    const mine = wallets.filter((w) => w.user_phone === phone);
    for (const name of DEFAULT_WALLETS) {
      if (!mine.some((w) => w.name.toLowerCase() === name.toLowerCase())) {
        wallets.push({
          user_phone: phone,
          name,
          initial_balance: 0,
          created_at: new Date().toISOString(),
        });
      }
    }
  });
}

async function ensureWalletExists(phone, name) {
  if (!name) return;
  await withCollection('wallets', (wallets) => {
    const exists = wallets.some(
      (w) => w.user_phone === phone && w.name.toLowerCase() === name.toLowerCase(),
    );
    if (!exists) {
      wallets.push({
        user_phone: phone,
        name,
        initial_balance: 0,
        created_at: new Date().toISOString(),
      });
    }
  });
}

export async function setWalletBalance(phone, name, initialBalance) {
  const amount = Math.max(0, Math.round(Number(initialBalance) || 0));
  return withCollection('wallets', (wallets) => {
    let w = wallets.find(
      (x) => x.user_phone === phone && x.name.toLowerCase() === name.toLowerCase(),
    );
    if (!w) {
      w = {
        user_phone: phone,
        name,
        initial_balance: amount,
        created_at: new Date().toISOString(),
      };
      wallets.push(w);
    } else {
      w.initial_balance = amount;
    }
    return w;
  });
}

export function computeWalletBalances(wallets, transactions) {
  const map = new Map();
  for (const w of wallets) {
    map.set(w.name, {
      name: w.name,
      initial_balance: Number(w.initial_balance) || 0,
      income: 0,
      expense: 0,
      balance: Number(w.initial_balance) || 0,
    });
  }
  for (const t of transactions) {
    const key = t.wallet || 'Cash';
    if (!map.has(key)) {
      map.set(key, { name: key, initial_balance: 0, income: 0, expense: 0, balance: 0 });
    }
    const entry = map.get(key);
    if (t.type === 'income') entry.income += t.amount;
    else entry.expense += t.amount;
  }
  for (const entry of map.values()) {
    entry.balance = entry.initial_balance + entry.income - entry.expense;
  }
  return [...map.values()];
}

export async function getWalletBalances(phone) {
  const [wallets, transactions] = await Promise.all([
    getWallets(phone),
    listTransactions(phone),
  ]);
  return computeWalletBalances(wallets, transactions);
}

export async function getWalletBalance(phone, walletName) {
  const balances = await getWalletBalances(phone);
  return balances.find((w) => w.name.toLowerCase() === String(walletName).toLowerCase())
    ?.balance ?? null;
}

/* BUDGETS */
export async function getBudgets(phone) {
  const budgets = await readCollection('budgets');
  return budgets.filter((b) => b.user_phone === phone);
}

export async function setBudget(phone, category, limit) {
  const amount = Math.max(0, Math.round(Number(limit) || 0));
  return withCollection('budgets', (budgets) => {
    let b = budgets.find(
      (x) =>
        x.user_phone === phone &&
        String(x.category).toLowerCase() === String(category).toLowerCase(),
    );
    if (!b) {
      b = {
        id: crypto.randomUUID(),
        user_phone: phone,
        category,
        limit: amount,
        created_at: new Date().toISOString(),
      };
      budgets.push(b);
    } else {
      b.limit = amount;
    }
    return b;
  });
}

/* CATEGORIES */
const DEFAULT_CATEGORIES = [
  { name: 'Makanan & Minuman', type: 'expense' },
  { name: 'Transportasi', type: 'expense' },
  { name: 'Belanja', type: 'expense' },
  { name: 'Tagihan', type: 'expense' },
  { name: 'Hiburan', type: 'expense' },
  { name: 'Kesehatan', type: 'expense' },
  { name: 'Pendidikan', type: 'expense' },
  { name: 'Lainnya', type: 'both' },
  { name: 'Gaji', type: 'income' },
  { name: 'Bonus', type: 'income' },
  { name: 'Usaha', type: 'income' },
  { name: 'Investasi', type: 'income' },
];

export async function listCategories() {
  const cats = await readCollection('categories');
  if (cats.length === 0) {
    const seeded = DEFAULT_CATEGORIES.map((c) => ({
      id: crypto.randomUUID(),
      name: c.name,
      type: c.type,
      parent_id: null,
      icon: '',
      color: '',
      is_active: true,
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    await writeCollection('categories', seeded);
    return seeded;
  }
  return cats;
}

export async function getCategory(id) {
  const cats = await readCollection('categories');
  return cats.find((c) => c.id === id) ?? null;
}

export async function addCategory(fields) {
  return withCollection('categories', (cats) => {
    const now = new Date().toISOString();
    const cat = {
      id: crypto.randomUUID(),
      name: String(fields.name || '').trim(),
      type: ['income', 'expense', 'both'].includes(fields.type) ? fields.type : 'both',
      parent_id: fields.parent_id || null,
      icon: fields.icon || '',
      color: fields.color || '',
      is_active: fields.is_active !== false,
      is_default: false,
      created_at: now,
      updated_at: now,
    };
    cats.push(cat);
    return cat;
  });
}

export async function updateCategory(id, fields) {
  return withCollection('categories', (cats) => {
    const cat = cats.find((c) => c.id === id);
    if (!cat) return null;
    if (fields.name !== undefined) cat.name = String(fields.name).trim();
    if (fields.type !== undefined && ['income', 'expense', 'both'].includes(fields.type)) cat.type = fields.type;
    if (fields.parent_id !== undefined) cat.parent_id = fields.parent_id || null;
    if (fields.icon !== undefined) cat.icon = fields.icon || '';
    if (fields.color !== undefined) cat.color = fields.color || '';
    if (fields.is_active !== undefined) cat.is_active = !!fields.is_active;
    cat.updated_at = new Date().toISOString();
    return cat;
  });
}

export async function deleteCategory(id) {
  const cats = await readCollection('categories');
  const cat = cats.find((c) => c.id === id);
  if (!cat) return { ok: false, reason: 'not_found' };
  if (cat.is_default) return { ok: false, reason: 'default' };
  const txs = await readCollection('transactions');
  if (txs.some((t) => t.category === cat.name)) {
    return { ok: false, reason: 'in_use' };
  }
  await withCollection('categories', (list) => {
    const idx = list.findIndex((c) => c.id === id);
    if (idx >= 0) list.splice(idx, 1);
  });
  return { ok: true };
}

/* ==========================================================================
 *  CONTACTS / SUPPORT SETTINGS
 * ========================================================================== */

const DEFAULT_CONTACTS = [
  { key: 'whatsapp_admin', label: 'WhatsApp Admin/CS', value: '', is_active: true },
  { key: 'telegram', label: 'Telegram', value: '', is_active: true },
  { key: 'email_support', label: 'Email Support', value: '', is_active: true },
  { key: 'faq_link', label: 'Link FAQ / Bantuan', value: '', is_active: true },
  { key: 'operational_hours', label: 'Jam Operasional', value: '', is_active: true },
];

export async function listContacts() {
  const items = await readCollection('contacts');
  if (items.length === 0) {
    const seeded = DEFAULT_CONTACTS.map((c) => ({
      id: crypto.randomUUID(),
      key: c.key,
      label: c.label,
      value: c.value,
      is_active: c.is_active,
      updated_at: new Date().toISOString(),
      updated_by: null,
    }));
    await writeCollection('contacts', seeded);
    return seeded;
  }
  return items;
}

export async function getContact(key) {
  const items = await readCollection('contacts');
  return items.find((c) => c.key === key) ?? null;
}

export async function upsertContact(key, fields) {
  return withCollection('contacts', (items) => {
    let c = items.find((x) => x.key === key);
    const now = new Date().toISOString();
    if (!c) {
      c = {
        id: crypto.randomUUID(),
        key,
        label: fields.label || key,
        value: fields.value ?? '',
        is_active: fields.is_active !== undefined ? !!fields.is_active : true,
        updated_at: now,
        updated_by: fields.updated_by || null,
      };
      items.push(c);
    } else {
      if (fields.label !== undefined) c.label = fields.label;
      if (fields.value !== undefined) c.value = fields.value;
      if (fields.is_active !== undefined) c.is_active = !!fields.is_active;
      c.updated_at = now;
      if (fields.updated_by !== undefined) c.updated_by = fields.updated_by;
    }
    return c;
  });
}

export async function updateContact(key, fields) {
  return upsertContact(key, fields);
}

export async function deleteContact(key) {
  return withCollection('contacts', (items) => {
    const idx = items.findIndex((c) => c.key === key);
    if (idx < 0) return false;
    items.splice(idx, 1);
    return true;
  });
}

/* UTIL */
export function currentMonth(date = new Date(), timeZone = getTimezone()) {
  const p = zonedParts(date instanceof Date ? date : new Date(date), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function previousMonth(date = new Date(), timeZone = getTimezone()) {
  const [y, m] = currentMonth(date, timeZone).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

const MONTH_NAMES_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

export function formatMonthLabel(month) {
  if (!month) return 'Semua waktu';
  const [y, m] = String(month).split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return String(month);
  return `${MONTH_NAMES_ID[m - 1]} ${y}`;
}

export const setTimezone = setUserTimezone;
export const getTimezoneForUser = getUserTimezone;
export const setUserTimeZone = setUserTimezone;
export const getUserTimeZone = getUserTimezone;

export function formatRupiah(value) {
  const rounded = Math.round(Number(value) || 0);
  const sign = rounded < 0 ? '-' : '';
  const digits = Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}Rp ${digits}`;
}
