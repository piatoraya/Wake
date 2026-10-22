import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth.js';
import { listAuditLogs } from '../audit.js';

const router = Router();
router.use(authMiddleware);

router.get('/', requireRole('owner'), async (req, res) => {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const offset = Number(req.query.offset) || 0;
    const result = await listAuditLogs({ limit, offset });
    res.json({ success: true, data: result.items, meta: { total: result.total, limit, offset } });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

export default router;
