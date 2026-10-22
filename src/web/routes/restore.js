import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth.js';
import { addAuditLog } from '../audit.js';
import { restoreUserBackup } from '../../config/database.js';

const router = Router();
router.use(authMiddleware);

router.post('/', requireRole('owner'), async (req, res) => {
  try {
    const { phone, data, backup, mode } = req.body || {};
    const payload = backup || data;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Payload backup tidak valid' } });
    }
    const result = await restoreUserBackup(phone, payload, mode === 'merge' ? 'merge' : 'replace');
    await addAuditLog({ adminId: req.user.sub, action: 'restore', entity: 'user', entityId: result.phone, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

export default router;