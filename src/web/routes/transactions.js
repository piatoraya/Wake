import { Router } from 'express';
import { authMiddleware } from '../auth.js';
import { addAuditLog } from '../audit.js';
import {
  listUsers,
  listTransactions,
  addTransaction,
  getTransactionById,
  updateTransaction,
  deleteTransaction,
  getStats,
} from '../../config/database.js';

const router = Router();
router.use(authMiddleware);

function parseFilters(req) {
  const { phone, month, type, category, wallet, source, from, to, q } = req.query;
  return { phone, month, type, category, wallet, source, from, to, q };
}

async function collect(req) {
  const users = await listUsers();
  const targetUsers = req.query.phone ? users.filter((u) => u.phone === req.query.phone) : users;
  const all = [];
  for (const u of targetUsers) {
    let txs = await listTransactions(u.phone, {
      month: req.query.month || null,
      type: req.query.type || null,
    });
    if (req.query.category) txs = txs.filter((t) => t.category === req.query.category);
    if (req.query.wallet) txs = txs.filter((t) => t.wallet === req.query.wallet);
    if (req.query.source) txs = txs.filter((t) => t.source === req.query.source);
    if (req.query.from) txs = txs.filter((t) => new Date(t.date) >= new Date(req.query.from));
    if (req.query.to) txs = txs.filter((t) => new Date(t.date) <= new Date(req.query.to));
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      txs = txs.filter((t) => (t.description || '').toLowerCase().includes(q) || (t.category || '').toLowerCase().includes(q));
    }
    all.push(...txs.map((t) => ({ ...t, user_name: u.name || u.phone })));
  }
  all.sort((a, b) => new Date(b.date) - new Date(a.date));
  return all;
}

router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const all = await collect(req);
    const total = all.length;
    const items = all.slice((page - 1) * limit, page * limit);
    res.json({ success: true, data: items, meta: { page, limit, total } });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const tx = await getTransactionById(req.params.id);
    if (!tx) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Transaksi tidak ditemukan' } });
    res.json({ success: true, data: tx });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.post('/', async (req, res) => {
  try {
    const { user_phone, type, amount, category, wallet, description, date, items, source } = req.body || {};
    if (!user_phone) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'user_phone wajib' } });
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'amount harus > 0' } });
    const tx = await addTransaction({ user_phone, type, amount: amt, category, wallet, description, date, items, source: source || 'web' });
    await addAuditLog({ adminId: req.user.sub, action: 'create', entity: 'transaction', entityId: tx.id, after: tx, ip: req.ip, userAgent: req.get('user-agent') });
    res.status(201).json({ success: true, data: tx });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const before = await getTransactionById(req.params.id);
    if (!before) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Transaksi tidak ditemukan' } });
    const updated = await updateTransaction(req.params.id, req.body || {});
    await addAuditLog({ adminId: req.user.sub, action: 'update', entity: 'transaction', entityId: req.params.id, before, after: updated, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const before = await getTransactionById(req.params.id);
    if (!before) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Transaksi tidak ditemukan' } });
    const ok = await deleteTransaction(req.params.id);
    if (!ok) return res.status(400).json({ success: false, error: { code: 'DELETE_FAILED', message: 'Gagal menghapus' } });
    await addAuditLog({ adminId: req.user.sub, action: 'delete', entity: 'transaction', entityId: req.params.id, before, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

export default router;
