import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth.js';
import { botState, getBotUptime } from '../state.js';

const router = Router();
router.use(authMiddleware);

router.get('/status', async (req, res) => {
  let gemini = null;
  try {
    const m = await import('../../services/gemini.js');
    if (typeof m.getRotationStatus === 'function') gemini = m.getRotationStatus();
  } catch {}
  // Fallback file-based status (written by bot process) when web runs standalone.
  let fileStatus = null;
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const file = path.resolve(process.env.DATA_DIR || './data', 'bot_status.json');
    const raw = await fs.readFile(file, 'utf8');
    fileStatus = JSON.parse(raw);
  } catch {}
  const status = botState.status !== 'offline' ? botState.status : (fileStatus?.status || 'offline');
  const phone = botState.phone || fileStatus?.phone || '';
  const method = botState.method || fileStatus?.method || '';
  const uptime = botState.status !== 'offline' ? getBotUptime() : (fileStatus?.uptime || 0);
  const lastError = botState.lastError || fileStatus?.lastError || '';
  res.json({
    success: true,
    data: { status, phone, method, uptime, lastError, gemini },
  });
});

router.get('/gemini-status', async (req, res) => {
  try {
    const m = await import('../../services/gemini.js');
    const status = typeof m.getRotationStatus === 'function' ? m.getRotationStatus() : null;
    res.json({ success: true, data: status });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.post('/reconnect', requireRole('owner'), async (req, res) => {
  if (typeof globalThis.__botReconnect === 'function') {
    try {
      await globalThis.__botReconnect();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
    }
  } else {
    res.status(501).json({ success: false, error: { code: 'NOT_AVAILABLE', message: 'Kontrol bot tidak tersedia (mode web-only)' } });
  }
});

export default router;
