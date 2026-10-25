import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth.js';
import { addAuditLog } from '../audit.js';
import { validateBody, schemas } from '../validate.js';
import {
  listInstances,
  createInstance,
  getInstance,
  deleteInstance,
  startInstance,
  stopInstance,
  requestPairingCode,
  isRunning,
  updateInstancePhone,
  resetAuth,
} from '../../services/sultanBotManager.js';

const router = Router();
router.use(authMiddleware);

// Semua route di bawah ini hanya untuk owner/admin dashboard.
// User biasa tidak punya akses ke dashboard web sama sekali.
router.use(requireRole('owner', 'admin'));

router.get('/', async (req, res) => {
  try {
    const data = await listInstances();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.post('/', validateBody(schemas.botInstanceCreate), async (req, res) => {
  try {
    const { owner_phone, name, phone, method } = req.body;
    const meta = await createInstance(owner_phone, name, phone, method);
    await addAuditLog({ adminId: req.user.sub, action: 'create', entity: 'bot_instance', entityId: meta.bot_id, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true, data: meta });
  } catch (e) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: e.message } });
  }
});

router.post('/:id/start', validateBody(schemas.botStart), async (req, res) => {
  try {
    const { method, force } = req.body;
    const result = await startInstance(req.params.id, method, !!force);
    await addAuditLog({ adminId: req.user.sub, action: 'start', entity: 'bot_instance', entityId: req.params.id, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: e.message } });
  }
});

router.get('/:id/qr', async (req, res) => {
  try {
    const inst = await getInstance(req.params.id);
    if (!inst || !inst.last_qr) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'QR belum tersedia' } });
    res.json({ success: true, data: { qr: inst.last_qr, ascii: inst.last_qr_ascii || '' } });
  } catch (e) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: e.message } });
  }
});

router.post('/:id/pairing-code', async (req, res) => {
  try {
    const result = await requestPairingCode(req.params.id);
    await addAuditLog({ adminId: req.user.sub, action: 'pairing_code', entity: 'bot_instance', entityId: req.params.id, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: e.message } });
  }
});

router.post('/:id/reset-auth', requireRole('owner'), async (req, res) => {
  try {
    const result = await resetAuth(req.params.id);
    await addAuditLog({ adminId: req.user.sub, action: 'reset_auth', entity: 'bot_instance', entityId: req.params.id, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: e.message } });
  }
});

router.post('/:id/stop', async (req, res) => {
  try {
    const result = await stopInstance(req.params.id);
    await addAuditLog({ adminId: req.user.sub, action: 'stop', entity: 'bot_instance', entityId: req.params.id, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: e.message } });
  }
});

router.put('/:id', validateBody(schemas.botInstanceUpdate), async (req, res) => {
  try {
    const { phone } = req.body;
    const updated = await updateInstancePhone(req.params.id, phone);
    await addAuditLog({ adminId: req.user.sub, action: 'update', entity: 'bot_instance', entityId: req.params.id, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true, data: updated });
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