import { Router } from 'express';
import { authMiddleware } from '../auth.js';
import {
  listUsers,
  listTransactions,
  getStats,
  getWalletBalances,
  getCategoryExpenses,
  currentMonth,
  previousMonth,
  formatMonthLabel,
} from '../../config/database.js';

const router = Router();
router.use(authMiddleware);

router.get('/summary', async (req, res) => {
  try {
    const month = req.query.month || currentMonth();
    const users = await listUsers();
    let totalIncome = 0, totalExpense = 0, totalCount = 0;
    for (const u of users) {
      const s = await getStats(u.phone, month);
      totalIncome += s.income;
      totalExpense += s.expense;
      totalCount += s.count;
    }
    const prev = previousMonth(new Date(month + '-01'));
    let prevIncome = 0, prevExpense = 0;
    for (const u of users) {
      const s = await getStats(u.phone, prev);
      prevIncome += s.income;
      prevExpense += s.expense;
    }
    const walletMap = new Map();
    for (const u of users) {
      const ws = await getWalletBalances(u.phone);
      for (const w of ws) {
        const cur = walletMap.get(w.name) || { name: w.name, initial_balance: 0, income: 0, expense: 0, balance: 0 };
        cur.initial_balance += w.initial_balance;
        cur.income += w.income;
        cur.expense += w.expense;
        cur.balance += w.balance;
        walletMap.set(w.name, cur);
      }
    }
    res.json({
      success: true,
      data: {
        month,
        monthLabel: formatMonthLabel(month),
        totalIncome,
        totalExpense,
        net: totalIncome - totalExpense,
        totalCount,
        userCount: users.length,
        prevIncome,
        prevExpense,
        wallets: [...walletMap.values()],
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.get('/cashflow', async (req, res) => {
  try {
    const users = await listUsers();
    const granularity = req.query.granularity === 'monthly' ? 'monthly' : 'daily';
    const month = req.query.month;
    const buckets = new Map();
    for (const u of users) {
      const txs = await listTransactions(u.phone, month ? { month } : {});
      for (const t of txs) {
        const key = granularity === 'monthly' ? String(t.date).slice(0, 7) : String(t.date).slice(0, 10);
        if (!buckets.has(key)) buckets.set(key, { period: key, income: 0, expense: 0 });
        const b = buckets.get(key);
        if (t.type === 'income') b.income += t.amount; else b.expense += t.amount;
      }
    }
    const data = [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period));
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.get('/categories', async (req, res) => {
  try {
    const month = req.query.month || currentMonth();
    const users = await listUsers();
    const agg = {};
    for (const u of users) {
      const ce = await getCategoryExpenses(u.phone, month);
      for (const [k, v] of Object.entries(ce)) agg[k] = (agg[k] || 0) + v;
    }
    const data = Object.entries(agg).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
    res.json({ success: true, data, meta: { month } });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.get('/recent', async (req, res) => {
  try {
    const users = await listUsers();
    const all = [];
    for (const u of users) {
      const txs = await listTransactions(u.phone);
      all.push(...txs.map((t) => ({ ...t, user_name: u.name || u.phone })));
    }
    all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ success: true, data: all.slice(0, 10) });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

export default router;
