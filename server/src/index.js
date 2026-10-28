'use strict';
/**
 * خادم بوابة العروض الفنية — المرحلة الأولى
 * Express + SQLite (better-sqlite3) + مصادقة JWT في httpOnly cookie.
 *
 * التشغيل:  npm start        (أو: node src/index.js)
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { migrate } = require('./migrate');
const { errorHandler } = require('./lib/errors');

const authRoutes = require('./routes/auth');
const { router: tenderRoutes } = require('./routes/tenders');
const fileRoutes = require('./routes/files');
const accountRoutes = require('./routes/account');
const procurementRoutes = require('./routes/procurement');
const billingRoutes = require('./routes/billing');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  // ترويسات أمان أساسية
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });

  // CORS اختياري — فقط إن كانت الواجهة على أصل مختلف
  if (config.CORS_ORIGIN) {
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', config.CORS_ORIGIN);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  /* ---------------- API ---------------- */
  app.get('/api/health', (req, res) => {
    const db = require('./db').getDB();
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const tenders = db.prepare('SELECT COUNT(*) AS n FROM tenders').get().n;
    const webRoot = config.WEB_ROOT || path.resolve(config.ROOT, '..', 'webpages', 'technical-proposal-kit_v5');
    const loginPath = path.join(webRoot, 'portal', 'pt-9f3c7a1e5b2d', 'login.html');
    res.json({
      ok: true, service: 'tpkit-portal', phase: 2, env: config.NODE_ENV,
      time: new Date().toISOString(),
      storage: { driver: config.STORAGE_DRIVER, signedUrlTtl: config.SIGNED_URL_TTL },
      scheduler: require('./lib/scheduler').schedulerStatus(),
      counts: { users, tenders },
      web: {
        root: webRoot,
        rootExists: fs.existsSync(webRoot),
        loginExists: fs.existsSync(loginPath),
        loginUrl: '/portal/pt-9f3c7a1e5b2d/login.html',
        procurementExists: fs.existsSync(path.join(webRoot, 'procurement', 'index.html')),
        bidExists: fs.existsSync(path.join(webRoot, 'bid', 'index.html')),
        adminExists: fs.existsSync(path.join(webRoot, 'admin', 'index.html'))
      }
    });
  });

  /* بيانات الدفع للعرض في الصفحات — عامة وبلا أسرار */
  app.get('/api/payment-info', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ payment: config.PAYMENT, ibanValid: config.PAYMENT_IBAN_VALID });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/tenders', tenderRoutes);
  app.use('/api', fileRoutes);
  app.use('/api', accountRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/api/procurement', procurementRoutes);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'نقطة API غير موجودة: ' + req.method + ' ' + req.originalUrl } });
  });

  /* ---------------- الواجهة (صفحات البوابة والحزمة) ---------------- */
  const WEB_ROOT = config.WEB_ROOT || path.resolve(config.ROOT, '..', 'webpages', 'technical-proposal-kit_v5');
  if (!fs.existsSync(WEB_ROOT)) {
    console.warn('  ⚠ WEB_ROOT غير موجود: ' + WEB_ROOT + ' — الواجهة لن تُخدم. اضبط WEB_ROOT.');
  } else {
    console.log('  WEB_ROOT   : ' + WEB_ROOT);
  }

  function sendFromWeb(relPath, res, next) {
    const target = path.resolve(WEB_ROOT, relPath);
    const rootResolved = path.resolve(WEB_ROOT);
    if (!target.startsWith(rootResolved + path.sep) && target !== rootResolved) {
      return res.status(400).type('text').send('Bad path');
    }
    if (!fs.existsSync(target)) {
      return res.status(404).type('text').send(
        'File not found: /' + relPath.replace(/\\/g, '/') +
        '\nWEB_ROOT=' + WEB_ROOT +
        '\nrootExists=' + fs.existsSync(WEB_ROOT) +
        '\nTip: ensure webpages/technical-proposal-kit_v5 is in the Git repo and Docker image.'
      );
    }
    return res.sendFile(target, (err) => { if (err) next(err); });
  }

  app.use(express.static(WEB_ROOT, {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  }));

  // ملفات التنزيل (Excel/PDF) فقط من مجلد documents
  const DOCS_ROOT = config.DOCS_ROOT || path.resolve(config.ROOT, '..', 'documents');
  app.use('/documents', (req, res, next) => {
    if (!/\.(xlsx|pdf)$/i.test(req.path)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'غير موجود.' } });
    next();
  }, express.static(DOCS_ROOT, { index: false, dotfiles: 'deny' }));

  // مسارات صريحة للبوابات (حتى لو فشل static لسبب ما)
  app.get(['/procurement', '/procurement/', '/procurement/index.html'], (req, res, next) => {
    sendFromWeb(path.join('procurement', 'index.html'), res, next);
  });
  app.get(['/bid', '/bid/', '/bid/index.html'], (req, res, next) => {
    sendFromWeb(path.join('bid', 'index.html'), res, next);
  });
  app.get(['/admin', '/admin/', '/admin/index.html'], (req, res, next) => {
    sendFromWeb(path.join('admin', 'index.html'), res, next);
  });
  app.get(/^\/portal(\/.*)?$/, (req, res, next) => {
    let rel = (req.path.replace(/^\/portal\/?/, '') || 'pt-9f3c7a1e5b2d/login.html');
    if (rel.endsWith('/')) rel += 'index.html';
    sendFromWeb(path.join('portal', rel), res, next);
  });

  app.get('/', (req, res) => {
    res.redirect(302, '/portal/pt-9f3c7a1e5b2d/login.html');
  });

  app.use(errorHandler);
  return app;
}

/** يبدأ الخادم بعد التهيئة */
function start() {
  fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
  migrate(config.DB_PATH);              // idempotent

  const app = createApp();
  const server = app.listen(config.PORT, config.HOST, async () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════════════╗');
    console.log('  ║  بوابة العروض الفنية — الخادم يعمل  (المرحلة الثانية)    ║');
    console.log('  ╚══════════════════════════════════════════════════════════╝');
    console.log('  العنوان      : http://localhost:' + config.PORT);
    console.log('  البيئة       : ' + config.NODE_ENV);
    console.log('  قاعدة البيانات: ' + config.DB_PATH);
    console.log('  مشغّل التخزين : ' + config.STORAGE_DRIVER +
      (config.STORAGE_DRIVER === 's3' ? '  → ' + (config.S3_ENDPOINT || 'AWS S3') + ' / ' + config.S3_BUCKET : '  → ' + config.UPLOAD_DIR));
    console.log('  النسخ الاحتياطي: ' + config.BACKUP_DIR);

    // فحص التخزين عند الإقلاع — نُحذّر ولا نُسقط الخادم
    try {
      const store = require('./lib/storage').getStorage();
      const h = await store.health();
      console.log('  صحة التخزين  : ' + (h.ok ? '✓ متصل' : '✗ غير متاح — ' + JSON.stringify(h.detail)));
      if (!h.ok) console.log('  ⚠ الرفع/التحميل سيفشل حتى تُصلح إعدادات التخزين. راجع /api/health/storage');
    } catch (e) {
      console.log('  صحة التخزين  : ✗ خطأ في التهيئة — ' + e.message);
    }

    require('./lib/scheduler').startScheduler();

    console.log('  البوابة      : http://localhost:' + config.PORT + '/portal/pt-9f3c7a1e5b2d/login.html');
    console.log('  الملفات      : ' + (config.WEB_ROOT || path.resolve(config.ROOT, '..', 'webpages', 'technical-proposal-kit_v5')));
    if (config.IS_DEFAULT_SECRET) {
      console.log('  ⚠ JWT_SECRET افتراضي — عيّنه قبل أي استخدام حقيقي.');
    }
    console.log('');
  });

  const shutdown = (sig) => {
    console.log('\n[' + sig + '] إيقاف الخادم...');
    server.close(() => {
      try { require('./db').closeDB(); } catch (_) {}
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) start();

module.exports = { createApp, start };
