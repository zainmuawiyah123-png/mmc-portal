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
const verificationRoutes = require('./routes/verification');
const orgRoutes = require('./routes/org');
const requestRoutes = require('./routes/requests');
const projectFinanceRoutes = require('./routes/project-finance');
const opportunitiesRoutes = require('./routes/opportunities');
const consultingRoutes = require('./routes/consulting');
const mmcAiRoutes = require('./routes/mmc-ai');
const mmcAiDocumentRoutes = require('./routes/mmc-ai-documents');

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

  const WEB_ROOT_HEALTH = config.WEB_ROOT || path.resolve(config.ROOT, '..', 'webpages', 'technical-proposal-kit_v5');

  /* ---------------- API ---------------- */
  app.get('/api/health', (req, res) => {
    const db = require('./db').getDB();
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const tenders = db.prepare('SELECT COUNT(*) AS n FROM tenders').get().n;
    res.json({
      ok: true, service: 'tpkit-portal', phase: 2, env: config.NODE_ENV,
      time: new Date().toISOString(),
      storage: { driver: config.STORAGE_DRIVER, signedUrlTtl: config.SIGNED_URL_TTL },
      scheduler: require('./lib/scheduler').schedulerStatus(),
      counts: { users, tenders },
      web: { // أعلام فقط — بلا مسارات الخادم
        rootExists: fs.existsSync(WEB_ROOT_HEALTH),
        login: fs.existsSync(path.join(WEB_ROOT_HEALTH, 'portal', 'pt-9f3c7a1e5b2d', 'login.html')),
        procurement: fs.existsSync(path.join(WEB_ROOT_HEALTH, 'procurement', 'index.html')),
        bid: fs.existsSync(path.join(WEB_ROOT_HEALTH, 'bid', 'index.html')),
        admin: fs.existsSync(path.join(WEB_ROOT_HEALTH, 'admin', 'index.html')),
        consultant: fs.existsSync(path.join(WEB_ROOT_HEALTH, 'consultant', 'index.html'))
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
  app.use('/api/verification', verificationRoutes);
  app.use('/api/org', orgRoutes);
  app.use('/api/requests', requestRoutes);
  app.use('/api/project-finance', projectFinanceRoutes);
  app.use('/api/opportunities', opportunitiesRoutes);
  app.use('/api/procurement', procurementRoutes);
  app.use('/api/consulting', consultingRoutes);
  app.use('/api/mmc-ai', mmcAiRoutes);
  app.use('/api/mmc-ai', mmcAiDocumentRoutes);
  app.use('/api/committee', require('./routes/committee'));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'نقطة API غير موجودة: ' + req.method + ' ' + req.originalUrl } });
  });

  /* ---------------- الواجهة (صفحات البوابة والحزمة) ---------------- */
  // WEB_ROOT: جذر الملفات الثابتة. في المرحلة الأولى كان الخادم داخل مجلد الحزمة،
  // والآن أصبح مجلداً مستقلاً (portal-server-v5) — افتراضياً نخدم مجلد النسخة v5،
  // ويُضبط صراحةً عبر WEB_ROOT حين تُنشر الحزمة في مسار آخر.
  const WEB_ROOT = config.WEB_ROOT || path.resolve(config.ROOT, '..', 'webpages', 'technical-proposal-kit_v5');
  if (!fs.existsSync(WEB_ROOT)) {
    console.warn('  ⚠ WEB_ROOT غير موجود: ' + WEB_ROOT + ' — الواجهة لن تُخدم. اضبط WEB_ROOT.');
  }
  // صفحة دورة المشروع تحتوي بيانات مالية؛ لا تُقدَّم كملف ثابت قبل التحقق من الجلسة.
  // يسمح للمقاول والجهة المشترية فقط، بينما تبقى صلاحيات كل عملية مفروضة في API.
  app.get(['/project-finance', '/project-finance/', '/project-finance/index.html'], (req, res, next) => {
    const A = require('./lib/auth');
    A.requireAuth(req, res, (err) => {
      if (err) return res.redirect(302, '/portal/pt-9f3c7a1e5b2d/login.html');
      if (!['buyer', 'contractor'].includes(req.user.role)) {
        return res.status(403).type('text').send('ليس لديك صلاحية الوصول إلى هذه الصفحة.');
      }
      return sendFromWeb('project-finance/index.html', res, next);
    });
  });

  // Independent consulting-firm portal entry. Keep it separate from the evaluator workspace at /consultant/.
  app.get(['/consulting', '/consulting/', '/consulting/index.html'], (req, res, next) => {
    const A = require('./lib/auth');
    A.requireAuth(req, res, (err) => {
      if (err) return res.redirect(302, '/portal/pt-9f3c7a1e5b2d/login.html?next=/consulting/');
      if (req.user.role !== 'consultant') {
        return res.redirect(302, '/portal/pt-9f3c7a1e5b2d/register.html?role=consultant&switch=1');
      }
      return sendFromWeb('consulting/index.html', res, next);
    });
  });

  // Separate requester workspace for the consultancy marketplace; not the procurement portal.
  app.get(['/consulting/requester', '/consulting/requester/', '/consulting/requester/index.html'], (req, res, next) => {
    const A = require('./lib/auth');
    A.requireAuth(req, res, (err) => {
      if (err) return res.redirect(302, '/portal/pt-9f3c7a1e5b2d/login.html?next=/consulting/requester/');
      if (req.user.role !== 'buyer') return res.status(403).type('text').send('هذه المساحة مخصصة للجهات الطالبة للخدمات الاستشارية.');
      return sendFromWeb('consulting/requester/index.html', res, next);
    });
  });

  app.use(express.static(WEB_ROOT, {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  }));

  // ملفات التنزيل (Excel/PDF) فقط من مجلد documents — بقية ملفاته داخلية ولا تُخدم أبداً
  const DOCS_ROOT = config.DOCS_ROOT || path.resolve(config.ROOT, '..', 'documents');
  app.use('/documents', (req, res, next) => {
    if (!/\.(xlsx|pdf)$/i.test(req.path)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'غير موجود.' } });
    next();
  }, express.static(DOCS_ROOT, {
    index: false, dotfiles: 'deny',
    setHeaders: (res, filePath) => {
      if (/\.xlsx$/i.test(filePath)) {
        // بدون هذا الرأس لا تعرض المتصفحات المدمجة (مثل متصفح التطبيقات على الآيفون) شيئاً عند فتح ملف Excel
        res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(require('path').basename(filePath)));
      }
    }
  }));

  // مسارات صريحة للبوابات + /portal، مع رسالة 404 واضحة (دون كشف مسارات الخادم)
  function sendFromWeb(relPath, res, next) {
    const root = path.resolve(WEB_ROOT);
    const target = path.resolve(root, relPath);
    if (!target.startsWith(root + path.sep)) return res.status(400).type('text').send('Bad path');
    if (!fs.existsSync(target)) return res.status(404).type('text').send('File not found: /' + relPath.replace(/\\/g, '/'));
    // Explicit portal routes bypass express.static; prevent stale HTML from being retained by browsers or proxies.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.sendFile(target, (err) => { if (err) next(err); });
  }
  app.get(['/procurement', '/procurement/', '/procurement/index.html'], (req, res, next) => sendFromWeb('procurement/index.html', res, next));
  app.get(['/bid', '/bid/', '/bid/index.html'], (req, res, next) => sendFromWeb('bid/index.html', res, next));
  app.get(['/admin', '/admin/', '/admin/index.html'], (req, res, next) => sendFromWeb('admin/index.html', res, next));
  app.get(['/consultant', '/consultant/', '/consultant/index.html'], (req, res, next) => sendFromWeb('consultant/index.html', res, next));
  app.get(['/org', '/org/', '/org/index.html'], (req, res, next) => sendFromWeb('org/index.html', res, next));

  // MMC AI is an independent workspace within MMC, not a tender portal role.
  app.get(['/mmc-ai', '/mmc-ai/', '/mmc-ai/index.html'], (req, res, next) => {
    const A = require('./lib/auth');
    A.requireAuth(req, res, (err) => {
      if (err) return res.redirect(302, '/portal/pt-9f3c7a1e5b2d/login.html?next=/mmc-ai/');
      return sendFromWeb('mmc-ai/index.html', res, next);
    });
  });


  app.get(/^\/portal(\/.*)?$/, (req, res, next) => {
    let rel = req.path.replace(/^\/portal\/?/, '') || 'pt-9f3c7a1e5b2d/login.html';
    if (rel.endsWith('/')) rel += 'index.html';
    sendFromWeb(path.join('portal', rel), res, next);
  });

  app.use(errorHandler);
  return app;
}

/** يبدأ الخادم بعد التهيئة */
function start() {
  fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
  migrate(config.DB_PATH);              // idempotent

  // The verified GAM snapshot is curated in source control; import it after
  // migrations so new deployments populate the tender directory automatically.
  const gamSyncStartedAt = Date.now();
  try {
    const result = require('./lib/gam-curated-sync').syncGAMCurated();
    require('./lib/scheduler').persistOpportunitySync('amman', gamSyncStartedAt, { ok: true, ...result });
    console.log(`[GAM] snapshot imported: received=${result.received}, added=${result.added}, updated=${result.updated}, verified=${result.verifiedAt}`);
  } catch (err) {
    try { require('./lib/scheduler').persistOpportunitySync('amman', gamSyncStartedAt, { ok: false, error: err.message }); } catch (_) {}
    console.error('[GAM] snapshot import failed; server will continue:', err.message);
  }

  const jpmcSyncStartedAt = Date.now();
  try {
    const result = require('./lib/jpmc-curated-sync').syncJPMCCurated();
    require('./lib/scheduler').persistOpportunitySync('jpmc', jpmcSyncStartedAt, { ok: true, ...result });
    console.log(`[JPMC] verified snapshot imported: received=${result.received}, added=${result.added}, updated=${result.updated}, verified=${result.verifiedAt}`);
  } catch (err) {
    try { require('./lib/scheduler').persistOpportunitySync('jpmc', jpmcSyncStartedAt, { ok: false, error: err.message }); } catch (_) {}
    console.error('[JPMC] snapshot import failed; server will continue:', err.message);
  }

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
