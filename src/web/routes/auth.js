import { Router } from 'express';
import {
  findAdminByUsername,
  findAdminById,
  verifyPassword,
  signAccessToken,
  signRefreshToken,
  verifyToken,
  stripPassword,
  updateAdminUser,
} from '../auth.js';
import { addAuditLog } from '../audit.js';

const router = Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Username & password wajib' } });
    const user = await findAdminByUsername(username);
    if (!user) return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Kredensial salah' } });
    const ok = await verifyPassword(user, password);
    if (!ok) return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Kredensial salah' } });
    const access = signAccessToken(user);
    const refresh = signRefreshToken(user);
    res.cookie('access_token', access, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 60 * 1000 });
    res.cookie('refresh_token', refresh, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    await updateAdminUser(user.id, { last_login: new Date().toISOString() });
    await addAuditLog({ adminId: user.id, action: 'login', entity: 'admin_user', entityId: user.id, ip: req.ip, userAgent: req.get('user-agent') });
    res.json({ success: true, data: { user: stripPassword(user), access_token: access } });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('access_token');
  res.clearCookie('refresh_token');
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  const token = req.cookies?.access_token;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Login diperlukan' } });
  res.json({ success: true, data: { user: payload } });
});

router.post('/refresh', async (req, res) => {
  const rt = req.cookies?.refresh_token;
  const payload = rt ? verifyToken(rt) : null;
  if (!payload || payload.type !== 'refresh') return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Refresh token invalid' } });
  const user = await findAdminById(payload.sub);
  if (!user) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'User tidak ditemukan' } });
  const access = signAccessToken(user);
  res.cookie('access_token', access, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 60 * 1000 });
  res.json({ success: true, data: { access_token: access } });
});

export default router;
