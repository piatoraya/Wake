import { Router } from 'express';
import { authMiddleware } from '../auth.js';
import { addAuditLog } from '../audit.js';
import { listContacts, getContact, upsertContact } from '../../config/database.js';

const router = Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const items = await listContacts();
    res.json({ success: true, data: items });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.get('/:key', async (req, res) => {
  try {
    const item = await getContact(req.params.key);
    if (!item) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Kontak tidak ditemukan' } });
    res.json({ success: true, data: item });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

router.put('/:key', async (req, res) => {
  try {
    const before = await getContact(req.params.key);
    const { label, value, is_active } = req.body || {};
    // validasi ringan
    if (value !== undefined && typeof value !== 'string') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'value harus string' } });
    }
    const updated = await upsertContact(req.params.key, {
      label,
      value,
      is_active,
      updated_by: req.user.sub,
    });
    await addAuditLog({ adminId: req.user.sub, action: 'update', entity: 'contact', entityId: req.params.key, before, after: updated, ip: req.ip, userAgent: req.get('user-agent') });
    // invalidate cache
    invalidateContactCache();
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// cache publik sederhana
let contactCache = { data: null, expires: 0 };
export function invalidateContactCache() { contactCache = { data: null, expires: 0 }; }
export async function getPublicContacts() {
  if (contactCache.data && Date.now() < contactCache.expires) return contactCache.data;
  const items = await listContacts();
  const data = items.filter((c) => c.is_active).map((c) => ({ key: c.key, label: c.label, value: c.value }));
  contactCache = { data, expires: Date.now() + 5 * 60 * 1000 };
  return data;
}

export default router;
