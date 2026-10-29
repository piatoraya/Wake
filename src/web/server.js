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

import { seedDefaultAdmins, authPage } from './auth.js';
import { csrfProtection } from './csrf.js';
import { assertWebSecurity, warnInsecureConfig } from '../config/envCheck.js';
import { scanCorruptCollections } from '../config/database.js';
import { getActivePlans } from '../services/features.js';
import { buildPricingTable } from '../services/pricing.js';
import { getPaymentConfig } from '../config/paymentConfig.js';
import { DURATION_MONTHS, DEFAULT_PLAN_BENEFITS, DEFAULT_PLAN_FEATURES } from '../config/plans.js';

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
import pricingRoutes from './routes/pricing.js';
import webhookRoutes from './routes/webhook.js';
import adminPlanRoutes from './routes/adminPlans.js';
import voucherRoutes from './routes/vouchers.js';
import adminTransactionRoutes from './routes/adminTransactions.js';

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
  // ------------------------------------------------------------------
  //  PENTING: simpan raw body SEBELUM express.json() memakannya.
  //
  //  Callback Tripay ditandatangani dengan HMAC atas byte mentah. Begitu
  //  express.json() mengurai body, byte asli hilang dan tanda tangan tidak
  //  bisa diverifikasi lagi — artinya webhook tidak bisa dipercaya sama
  //  sekali. Middleware ini menyalin buffer mentah ke req.rawBody lebih
  //  dulu, dan hanya untuk route webhook supaya memori tidak terbuang.
  // ------------------------------------------------------------------
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/webhook')) return next();
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      // Batas aman: callback Tripay hanya beberapa KB.
      if (raw.length > 256 * 1024) {
        raw = '';
        req.destroy();
      }
    });
    req.on('end', () => {
      req.rawBody = raw;
      next();
    });
    req.on('error', next);
  });

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(morgan('combined'));
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 }));
  app.use(csrfProtection());

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

  // Langganan & pembayaran. Urutan penting: webhook didaftarkan lebih dulu
  // agar tidak pernah tertutup route lain yang kebetulan cocok.
  app.use('/api/webhook', webhookRoutes);
  app.use('/api/pricing', pricingRoutes);
  app.use('/api/admin-plans', adminPlanRoutes);
  app.use('/api/vouchers', voucherRoutes);
  app.use('/api/admin-transactions', adminTransactionRoutes);

  app.get('/health', async (req, res) => {
    let corrupt = [];
    try {
      corrupt = await scanCorruptCollections();
    } catch {
      /* jangan gagalkan health check karena error I/O */
    }
    res.status(corrupt.length ? 503 : 200).json({
      success: corrupt.length === 0,
      status: corrupt.length ? 'degraded' : 'ok',
      // Nama koleksi yang rusak. Data lama TIDAK ditimpa — penulisan diblokir
      // sampai file diperbaiki. Status 503 agar monitoring/proxy ikut tahu.
      data: { corruptCollections: corrupt.map((c) => c.name) },
    });
  });

  // Halaman dashboard dilindungi authPage (redirect ke /login bila belum login).
  const pageGuard = authPage;

  app.get('/', (req, res) => res.render('home', { title: 'CatatAja', user: null }));
  app.get('/home', (req, res) => res.render('home', { title: 'CatatAja', user: null }));
  app.get('/fitur', (req, res) => res.render('fitur', { title: 'Fitur', user: null }));
  app.get('/harga', async (req, res) => {
    // Harga SELALU dihitung di server dari koleksi `subscription_plans`,
    // lalu diserahkan ke view sebagai JSON. Client hanya menampilkan.
    try {
      const [plans, payment] = await Promise.all([getActivePlans(), getPaymentConfig()]);
      const paidPlans = buildPricingTable(plans);
      const free = plans.find((p) => p.slug === 'free') || {};
      const freePlan = {
        slug: 'free',
        label: free.label || 'Gratis',
        benefits: Array.isArray(free.benefits) && free.benefits.length
          ? free.benefits
          : DEFAULT_PLAN_BENEFITS.free,
        features: free.features || DEFAULT_PLAN_FEATURES.free,
      };
      return res.render('harga', {
        title: 'Harga',
        user: req.user || null,
        freePlan,
        paidPlans,
        durations: DURATION_MONTHS,
        paymentEnabled: Boolean(payment?.configured),
      });
    } catch (e) {
      // Halaman publik tidak boleh 500 hanya karena DB/payment belum siap.
      return res.render('harga', {
        title: 'Harga',
        user: req.user || null,
        freePlan: { slug: 'free', label: 'Gratis', benefits: DEFAULT_PLAN_BENEFITS.free, features: DEFAULT_PLAN_FEATURES.free },
        paidPlans: [],
        durations: DURATION_MONTHS,
        paymentEnabled: false,
      });
    }
  });
  app.get('/kontak', (req, res) => res.render('kontak', { title: 'Kontak', user: null }));

  /**
   * Halaman checkout. Angka harga tidak dikirim di sini — view meminta
   * /api/pricing/quote supaya sumber kebenaran tetap satu (server).
   */
  app.get('/checkout', async (req, res) => {
    const fallback = {
      title: 'Checkout',
      user: req.user || null,
      paidPlans: [],
      durations: DURATION_MONTHS,
      paymentEnabled: false,
      initialPlan: '',
      initialMonths: DURATION_MONTHS[0],
    };
    try {
      const [plans, payment] = await Promise.all([getActivePlans(), getPaymentConfig()]);
      const paidPlans = buildPricingTable(plans);
      const requested = String(req.query.plan || '').toLowerCase();
      const months = DURATION_MONTHS.includes(Number(req.query.months))
        ? Number(req.query.months)
        : DURATION_MONTHS[0];
      return res.render('checkout', {
        ...fallback,
        paidPlans,
        paymentEnabled: Boolean(payment?.configured),
        // Paket yang diminta dipakai bila memang dijual; kalau tidak, paket pertama.
        initialPlan: paidPlans.some((p) => p.slug === requested)
          ? requested
          : (paidPlans[0]?.slug || ''),
        initialMonths: months,
      });
    } catch (e) {
      return res.render('checkout', fallback);
    }
  });

  /**
   * Halaman status pembayaran. `ref` = merchant_ref. Halaman ini memantau
   * /api/pricing/status/:ref, jadi tidak perlu data awal dari server.
   */
  app.get('/pembayaran/:ref', (req, res) =>
    res.render('pembayaran', {
      title: 'Status Pembayaran',
      user: req.user || null,
      merchantRef: String(req.params.ref || ''),
    }),
  );
  app.get('/privasi', (req, res) => res.render('privasi', { title: 'Kebijakan Privasi', user: null }));
  app.get('/syarat', (req, res) => res.render('syarat', { title: 'Syarat & Ketentuan', user: null }));
  app.get('/login', (req, res) => res.render('login', { title: 'Login' }));
  app.get('/dashboard', pageGuard, (req, res) => res.render('dashboard', { title: 'Dashboard', user: req.user }));
  app.get('/transactions', pageGuard, (req, res) => res.render('transactions', { title: 'Transaksi', user: req.user }));
  app.get('/categories', pageGuard, (req, res) => res.render('categories', { title: 'Kategori', user: req.user }));
  app.get('/contacts', pageGuard, (req, res) => res.render('contacts', { title: 'Kontak & Support', user: req.user }));
  app.get('/users', pageGuard, (req, res) => res.render('users', { title: 'Pengguna', user: req.user }));
  app.get('/reports', pageGuard, (req, res) => res.render('reports', { title: 'Laporan', user: req.user }));
  app.get('/system', pageGuard, (req, res) => res.render('system', { title: 'System Monitor', user: req.user }));
  app.get('/settings', pageGuard, (req, res) => res.render('settings', { title: 'Pengaturan', user: req.user }));
  app.get('/admin-users', pageGuard, (req, res) => res.render('adminUsers', { title: 'Admin Users', user: req.user }));
  app.get('/admin-plans', pageGuard, (req, res) => res.render('adminPlans', { title: 'Paket Langganan', user: req.user }));
  app.get('/admin-vouchers', pageGuard, (req, res) => res.render('adminVouchers', { title: 'Voucher', user: req.user }));
  app.get('/admin-transactions', pageGuard, (req, res) => res.render('adminTransactions', { title: 'Transaksi Langganan', user: req.user }));
  app.get('/bot-instances', pageGuard, (req, res) => res.render('botInstances', { title: 'Bot Instances (Sultan)', user: req.user }));

  app.use((req, res) => res.status(404).render('error', { title: '404', message: 'Halaman tidak ditemukan', user: req.user || null }));
  app.use((err, req, res, next) => {
    console.error('[WEB] error:', err?.message);
    if (req.path.startsWith('/api/')) return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err?.message || 'Internal error' } });
    res.status(500).render('error', { title: '500', message: err?.message || 'Internal error', user: req.user || null });
  });

  return app;
}

export async function startWebServer(port = Number(process.env.WEB_PORT || 3000)) {
  // Fail-fast: jangan pernah menyalakan dashboard dengan secret default.
  assertWebSecurity();
  warnInsecureConfig();
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
