import { Router } from 'express';
import { authMiddleware } from '../auth.js';
import { addAuditLog } from '../audit.js';
import { listCategories, getCategory, addCategory, updateCategory, deleteCategory } from '../../config/database.js';

const router = Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const cats = await listCategories();
    res.json({ success: true, data: cats });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const cat = await getCategory(req.params.id);
    if (!cat) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Kategori tidak ditemukan' } });
    res.json({ success: true, data: cat });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Nama kategori wajib' } });
    const cat = await addCategory(req.body);
    await addAuditLog({ adminId: req.user.sub, action: 'create', entity: 'category', entityId: cat.id, after: cat, ip: req.ip, userAgent: req.get('user-agent') });
    res.status(201).json({ success: true, data: cat });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const before = await getCategory(req.params.id);
    if (!before) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Kategori tidak ditemukan' } });
    const updated = await updateCategory(req.params.id, req.body || {});
    await addAuditLog({ adminId: req.user.sub, action: 'update', entity: 'category', entityId: req.params.id, before, after: updated, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const before = await getCategory(req.params.id);
    if (!before) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Kategori tidak ditemukan' } });
    const result = await deleteCategory(req.params.id);
    if (!result.ok) {
      const msg = result.reason === 'default' ? 'Kategori default tidak boleh dihapus' : result.reason === 'in_use' ? 'Kategori masih dipakai transaksi' : 'Gagal menghapus';
      return res.status(400).json({ success: false, error: { code: 'DELETE_FAILED', message: msg } });
    }
    await addAuditLog({ adminId: req.user.sub, action: 'delete', entity: 'category', entityId: req.params.id, before, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

export default router;
