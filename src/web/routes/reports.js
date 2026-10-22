import { Router } from 'express';
import { authMiddleware } from '../auth.js';
import { addAuditLog } from '../audit.js';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import {
  listUsers,
  listTransactions,
  getStats,
  getCategoryExpenses,
  getWalletBalances,
  currentMonth,
  formatMonthLabel,
  formatRupiah,
} from '../../config/database.js';

const router = Router();
router.use(authMiddleware);

router.get('/summary', async (req, res) => {
  try {
    const month = req.query.month || currentMonth();
    const users = await listUsers();
    const perUser = [];
    const globalCategories = {};
    let totalIncome = 0, totalExpense = 0;
    for (const u of users) {
      const stats = await getStats(u.phone, month);
      const cats = await getCategoryExpenses(u.phone, month);
      for (const [k, v] of Object.entries(cats)) globalCategories[k] = (globalCategories[k] || 0) + v;
      totalIncome += stats.income;
      totalExpense += stats.expense;
      perUser.push({ phone: u.phone, name: u.name, ...stats, categories: cats });
    }
    res.json({
      success: true,
      data: {
        month,
        monthLabel: formatMonthLabel(month),
        totalIncome,
        totalExpense,
        net: totalIncome - totalExpense,
        perUser,
        categories: Object.entries(globalCategories).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.get('/export', async (req, res) => {
  try {
    const format = (req.query.format || 'csv').toLowerCase();
    const month = req.query.month || null;
    const phone = req.query.phone || null;
    const users = phone ? [{ phone }] : await listUsers();
    // gather transactions
    const all = [];
    for (const u of users) {
      const realUser = (await listUsers()).find((x) => x.phone === u.phone) || u;
      const txs = await listTransactions(u.phone, month ? { month } : {});
      all.push(...txs.map((t) => ({ ...t, user_name: realUser.name || u.phone })));
    }
    all.sort((a, b) => new Date(a.date) - new Date(b.date));

    await addAuditLog({ adminId: req.user.sub, action: 'export', entity: 'report', entityId: month || 'all', ip: req.ip, userAgent: req.get('user-agent') });

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="transaksi-${month || 'all'}.csv"`);
      const header = ['Tanggal', 'Pengguna', 'Jenis', 'Kategori', 'Wallet', 'Deskripsi', 'Jumlah', 'Sumber'];
      const rows = [header.join(',')];
      for (const t of all) {
        rows.push([t.date, t.user_name, t.type, t.category, t.wallet, `"${(t.description || '').replace(/"/g, '""')}"`, t.amount, t.source || ''].join(','));
      }
      return res.send(rows.join('\n'));
    }

    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Transaksi');
      ws.columns = [
        { header: 'Tanggal', key: 'date', width: 22 },
        { header: 'Pengguna', key: 'user_name', width: 18 },
        { header: 'Jenis', key: 'type', width: 10 },
        { header: 'Kategori', key: 'category', width: 18 },
        { header: 'Wallet', key: 'wallet', width: 12 },
        { header: 'Deskripsi', key: 'description', width: 30 },
        { header: 'Jumlah', key: 'amount', width: 14 },
        { header: 'Sumber', key: 'source', width: 10 },
      ];
      for (const t of all) ws.addRow(t);
      ws.getRow(1).font = { bold: true };
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="transaksi-${month || 'all'}.xlsx"`);
      await wb.xlsx.write(res);
      return res.end();
    }

    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="transaksi-${month || 'all'}.pdf"`);
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      doc.pipe(res);
      doc.fontSize(16).text('Laporan Transaksi', { align: 'center' });
      doc.fontSize(10).text(`Periode: ${month || 'Semua waktu'}`, { align: 'center' });
      doc.moveDown();
      const cols = ['Tanggal', 'Pengguna', 'Jenis', 'Kategori', 'Jumlah'];
      const widths = [110, 90, 60, 110, 80];
      let x = 40;
      doc.font('Helvetica-Bold').fontSize(9);
      cols.forEach((c, i) => { doc.text(c, x, doc.y, { width: widths[i], continued: i < cols.length - 1 }); x += widths[i]; });
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(9);
      for (const t of all.slice(0, 200)) {
        x = 40;
        const y = doc.y;
        const vals = [new Date(t.date).toLocaleString('id-ID'), t.user_name, t.type, t.category, formatRupiah(t.amount)];
        vals.forEach((v, i) => { doc.text(String(v).slice(0, 28), x, y, { width: widths[i] }); x += widths[i]; });
        doc.moveDown(0.4);
        if (doc.y > 750) doc.addPage();
      }
      doc.end();
      return;
    }

    res.status(400).json({ success: false, error: { code: 'BAD_FORMAT', message: 'Format harus csv/xlsx/pdf' } });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

export default router;
