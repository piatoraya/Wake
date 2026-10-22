import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { seedDefaultAdmins, authMiddleware, verifyToken } from './auth.js';

import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import contactRoutes from './routes/contacts.js';
import publicRoutes from './routes/public.js';
import transactionRoutes from './routes/transactions.js';
import categoryRoutes from './routes/categories.js';
import userRoutes from './routes/users.js';
import reportRoutes from './routes/reports.js';
import botRoutes from './routes/bot.js';
import adminRoutes from './routes/adminUsers.js';
import auditRoutes from './routes/audit.js';
import settingsRoutes from './routes/settings.js';
import restoreRoutes from './routes/restore.js';
import botInstanceRoutes from './routes/botInstances.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

export function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(PROJECT_ROOT, 'views'));

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(compression());
  // Origin yang diizinkan: dari .env (WEB_ORIGIN) dan/atau domain yang
  // diatur owner lewat dashboard (data/web_settings.json). Dibaca tiap
  // request supaya perubahan domain langsung berlaku tanpa restart.
  function resolveAllowedOrigins() {
    const set = new Set();
    if (process.env.WEB_ORIGIN && process.env.WEB_ORIGIN !== '*') set.add(process.env.WEB_ORIGIN);
    const dataDir = path.resolve(process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data'));
    try {
      const raw = fs.readFileSync(path.join(dataDir, 'web_settings.json'), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.domain) set.add(parsed.domain);
    } catch { /* file belum ada */ }
    return set;
  }
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const allowed = resolveAllowedOrigins();
      if (allowed.size === 0) return callback(null, true);
      if (allowed.has(origin)) return callback(null, true);
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return callback(null, true);
      callback(new Error('Origin tidak diizinkan oleh konfigurasi CORS'));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(morgan('combined'));
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 }));

  app.use('/assets', express.static(path.join(PROJECT_ROOT, 'public', 'assets')));

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

  app.use('/api/auth', loginLimiter, authRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/transactions', transactionRoutes);
  app.use('/api/categories', categoryRoutes);
  app.use('/api/contacts', contactRoutes);
  app.use('/api/public', publicRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/bot', botRoutes);
  app.use('/api/admin-users', adminRoutes);
  app.use('/api/audit-logs', auditRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/restore', restoreRoutes);
  app.use('/api/bot-instances', botInstanceRoutes);

  app.get('/health', (req, res) => res.json({ success: true, status: 'ok' }));

  const guard = (req, res, next) => {
    const token = req.cookies?.access_token;
    const payload = token ? verifyToken(token) : null;
    if (!payload) return res.redirect('/login');
    req.user = payload;
    next();
  };

  app.get('/', (req, res) => res.render('home', { title: 'CatatAja', user: null }));
  app.get('/home', (req, res) => res.render('home', { title: 'CatatAja', user: null }));
  app.get('/fitur', (req, res) => res.render('fitur', { title: 'Fitur', user: null }));
  app.get('/harga', (req, res) => res.render('harga', { title: 'Harga', user: null }));
  app.get('/kontak', (req, res) => res.render('kontak', { title: 'Kontak', user: null }));
  app.get('/privasi', (req, res) => res.render('privasi', { title: 'Kebijakan Privasi', user: null }));
  app.get('/syarat', (req, res) => res.render('syarat', { title: 'Syarat & Ketentuan', user: null }));
  app.get('/login', (req, res) => res.render('login', { title: 'Login' }));
  app.get('/dashboard', guard, (req, res) => res.render('dashboard', { title: 'Dashboard', user: req.user }));
  app.get('/transactions', guard, (req, res) => res.render('transactions', { title: 'Transaksi', user: req.user }));
  app.get('/categories', guard, (req, res) => res.render('categories', { title: 'Kategori', user: req.user }));
  app.get('/contacts', guard, (req, res) => res.render('contacts', { title: 'Kontak & Support', user: req.user }));
  app.get('/users', guard, (req, res) => res.render('users', { title: 'Pengguna', user: req.user }));
  app.get('/reports', guard, (req, res) => res.render('reports', { title: 'Laporan', user: req.user }));
  app.get('/system', guard, (req, res) => res.render('system', { title: 'System Monitor', user: req.user }));
  app.get('/settings', guard, (req, res) => res.render('settings', { title: 'Pengaturan', user: req.user }));
  app.get('/admin-users', guard, (req, res) => res.render('adminUsers', { title: 'Admin Users', user: req.user }));
  app.get('/bot-instances', guard, (req, res) => res.render('botInstances', { title: 'Bot Instances (Sultan)', user: req.user }));

  app.use((req, res) => res.status(404).render('error', { title: '404', message: 'Halaman tidak ditemukan', user: req.user || null }));
  app.use((err, req, res, next) => {
    console.error('[WEB] error:', err?.message);
    if (req.path.startsWith('/api/')) return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err?.message || 'Internal error' } });
    res.status(500).render('error', { title: '500', message: err?.message || 'Internal error', user: req.user || null });
  });

  return app;
}

export async function startWebServer(port = Number(process.env.WEB_PORT || 3000)) {
  await seedDefaultAdmins();
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`[WEB] Dashboard berjalan di http://localhost:${port}`);
      resolve(server);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWebServer().catch((e) => { console.error(e); process.exit(1); });
}
