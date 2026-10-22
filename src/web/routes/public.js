import { Router } from 'express';
import { getPublicContacts } from './contacts.js';

const router = Router();

router.get('/contacts', async (req, res) => {
  try {
    const data = await getPublicContacts();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

export default router;
