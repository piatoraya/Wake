import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth.js';
import { addAuditLog } from '../audit.js';
import { validateBody, schemas } from '../validate.js';
import {
  getAdminUsers,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  stripPassword,
  findAdminById,
} from '../auth.js';

const router = Router();
router.use(authMiddleware);

router.get('/', requireRole('owner'), async (req, res) => {
  try {
    const users = await getAdminUsers();
    res.json({ success: true, data: users.map(stripPassword) });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.post('/', requireRole('owner'), validateBody(schemas.adminCreate), async (req, res) => {
  try {
    const { username, password, role, name } = req.body;
    const user = await createAdminUser({ username, password, role, name });
    await addAuditLog({ adminId: req.user.sub, action: 'create', entity: 'admin_user', entityId: user.id, after: user, ip: req.ip, userAgent: req.get('user-agent') });
    res.status(201).json({ success: true, data: user });
  } catch (e) {
    res.status(400).json({ success: false, error: { code: 'CREATE_FAILED', message: e.message } });
  }
});

router.put('/:id', requireRole('owner'), validateBody(schemas.adminUpdate), async (req, res) => {
  try {
    const before = await findAdminById(req.params.id);
    const updated = await updateAdminUser(req.params.id, req.body);
    if (!updated) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Admin tidak ditemukan' } });
    await addAuditLog({ adminId: req.user.sub, action: 'update', entity: 'admin_user', entityId: req.params.id, before: before ? stripPassword(before) : null, after: updated, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(400).json({ success: false, error: { code: 'UPDATE_FAILED', message: e.message } });
  }
});

router.delete('/:id', requireRole('owner'), async (req, res) => {
  try {
    if (req.params.id === req.user.sub) return res.status(400).json({ success: false, error: { code: 'FORBIDDEN', message: 'Tidak bisa menghapus diri sendiri' } });
    const before = await findAdminById(req.params.id);
    const ok = await deleteAdminUser(req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Admin tidak ditemukan' } });
    await addAuditLog({ adminId: req.user.sub, action: 'delete', entity: 'admin_user', entityId: req.params.id, before: before ? stripPassword(before) : null, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

export default router;
