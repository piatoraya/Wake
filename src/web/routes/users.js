import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth.js';
import { addAuditLog } from '../audit.js';
import {
  listUsers,
  getUser,
  getUserTimezone,
  listTransactions,
  getStats,
  getWalletBalances,
  getBudgets,
  getWallets,
} from '../../config/database.js';

const router = Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const users = await listUsers();
    const data = [];
    for (const u of users) {
      const stats = await getStats(u.phone);
      data.push({ ...u, stats });
    }
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.get('/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const user = await getUser(phone);
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Pengguna tidak ditemukan' } });
    const tz = await getUserTimezone(phone);
    const txs = await listTransactions(phone);
    const stats = await getStats(phone);
    const wallets = await getWalletBalances(phone);
    const budgets = await getBudgets(phone);
    res.json({ success: true, data: { user, timezone: tz, transactions: txs, stats, wallets, budgets } });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// reset data pengguna (Owner only)
router.delete('/:phone/data', requireRole('owner'), async (req, res) => {
  try {
    const phone = req.params.phone;
    const { withCollection } = await import('../../config/database.js');
    await withCollection('transactions', (list) => {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].user_phone === phone) list.splice(i, 1);
    });
    await withCollection('wallets', (list) => {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].user_phone === phone) list.splice(i, 1);
    });
    await withCollection('budgets', (list) => {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].user_phone === phone) list.splice(i, 1);
    });
    await addAuditLog({ adminId: req.user.sub, action: 'reset_user_data', entity: 'user', entityId: phone, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

export default router;
