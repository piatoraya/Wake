/**
 * src/config/database.js
 * Database LOKAL berbasis file JSON (safe write).
 */
import fs from 'node:fs/promises';
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

export async function readCollection(name) {
  const file = fileOf(name);
  try {
    const raw = await fs.readFile(file, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error(`[DB] ${path.basename(file)} korup:`, err.message);
    try {
      await fs.rename(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* ignore */
    }
    return [];
  }
}

async function writeAtomic(name, records) {
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
    const records = await readCollection(name);
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

export async function upsertUser(phone, name = phone) {
  const { user, isNew } = await withCollection('users', (users) => {
    let found = users.find((u) => u.phone === phone);
    if (!found) {
      found = {
        phone,
        name: name || phone,
        created_at: new Date().toISOString(),
        timezone: getTimezone(),
      };
      users.push(found);
      return { user: found, isNew: true };
    }
    if (name && name !== phone) found.name = name;
    return { user: found, isNew: false };
  });

  if (isNew) await ensureDefaultWallets(phone);
  return user;
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
