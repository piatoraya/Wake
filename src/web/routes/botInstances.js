import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth.js';
import { addAuditLog } from '../audit.js';
import { getUser } from '../../config/database.js';
import {
  listInstances,
  createInstance,
  getInstance,
  deleteInstance,
} from '../../services/sultanBotManager.js';

const router = Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const ownerPhone = req.user.role === 'owner' ? null : undefined;
    // admin/owner lihat semua; user biasa (bukan admin) tidak akses web ini
    const data = await listInstances();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.post('/', async (req, res) => {
  try {
    const { owner_phone, name } = req.body || {};
    if (!owner_phone || !name) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'owner_phone dan name wajib' } });
    }
    // hanya owner/admin boleh membuat via web
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Akses ditolak' } });
    }
    const meta = await createInstance(owner_phone, name);
    await addAuditLog({ adminId: req.user.sub, action: 'create', entity: 'bot_instance', entityId: meta.bot_id, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true, data: meta });
  } catch (e) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: e.message } });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Instance tidak ditemukan' } });
    res.json({ success: true, data: inst });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.delete('/:id', requireRole('owner'), async (req, res) => {
  try {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Instance tidak ditemukan' } });
    await deleteInstance(inst.owner_phone, req.params.id, true);
    await addAuditLog({ adminId: req.user.sub, action: 'delete', entity: 'bot_instance', entityId: req.params.id, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

export default router;