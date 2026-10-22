import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth.js';
import { addAuditLog } from '../audit.js';
import { getWebSettings, setWebSettings, normalizeDomain } from '../settings.js';

const router = Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const settings = await getWebSettings();
    res.json({ success: true, data: settings });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.put('/', requireRole('owner'), async (req, res) => {
  try {
    const domain = normalizeDomain(req.body?.domain);
    if (domain === null) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Domain tidak valid. Contoh: https://catataja.id' } });
    }
    const before = await getWebSettings();
    const after = await setWebSettings({ domain });
    await addAuditLog({
      adminId: req.user.sub,
      action: 'update',
      entity: 'settings',
      entityId: 'domain',
      before,
      after,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json({ success: true, data: after });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

export default router;