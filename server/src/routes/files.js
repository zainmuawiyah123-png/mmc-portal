'use strict';
/**
 * نقاط الملفات — تعمل عبر طبقة التخزين المجرّدة (local | s3) بلا أي فرق في الواجهة.
 *
 *  POST   /api/tenders/:id/files        رفع (multipart)
 *  GET    /api/tenders/:id/files        قائمة ملفات العطاء
 *  GET    /api/files/:id/url            رابط موقّع قصير الصلاحية (5 دقائق)
 *  GET    /api/files/:id/download       تحميل محمي مباشر (يتحقق من الملكية)
 *  DELETE /api/files/:id                حذف
 *  GET    /api/storage/local            تنزيل عبر رابط محلي موقّع
 *  GET    /api/health/storage           فحص صحة التخزين
 *
 * كل نقطة تتحقق أن المستخدم يملك الملف/العطاء فعلاً.
 */
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const S = require('../lib/storage');
const { audit } = require('../lib/audit');

const router = express.Router();
// ملاحظة: هذا الراوتر يُركَّب على /api مباشرة، لذا الحماية لكل مسار على حدة
// وإلا التقط أي مسار /api غير معروف وأرجع 401 بدل 404.
const auth = A.requireAuth;

/** multer: الذاكرة أولاً ثم نكتب عبر المشغّل بعد التحقق */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_BYTES, files: config.MAX_FILES_PER_REQUEST },
  fileFilter: (req, file, cb) => {
    try {
      S.assertAllowed(file.originalname, file.size || 0);
      cb(null, true);
    } catch (err) { cb(err); }
  }
});

const shapeFile = (f) => ({
  id: f.id, name: f.name, category: f.category, size: f.size,
  mime: f.mime, uploadedAt: f.uploaded_at, tenderId: f.tender_id,
  driver: f.storage_driver || 'local',
  checksum: f.checksum_sha256 || null,
  migratedAt: f.migrated_at || null
});

/** يحمّل مشغّلاً محدّداً — الملف قد يكون على مشغّل غير النشط أثناء الترحيل */
function loadDriver(name) {
  return name === 's3' ? require('../lib/storage/s3') : require('../lib/storage/local');
}

/* ---------------- POST /api/tenders/:id/files ---------------- */
router.post('/tenders/:id/files', auth, upload.array('files', config.MAX_FILES_PER_REQUEST), wrap(async (req, res) => {
  const tender = A.ownTender(req, req.params.id);
  const db = getDB();
  const files = req.files || [];
  const store = S.getStorage();
  const driverName = store.DRIVER;

  if (!files.length) throw E.badRequest('لم يصل أي ملف. أرفق ملفاً واحداً على الأقل في الحقل files.');

  // حدود الباقة على المساحة
  const { plan, usage } = A.planAndUsage(req.user.id);
  const incoming = files.reduce((a, f) => a + f.size, 0);
  if (plan.maxBytes !== null && usage.bytes + incoming > plan.maxBytes) {
    throw E.planLimit(
      'حجم الرفع (' + (incoming / 1048576).toFixed(1) + ' م.ب) يتجاوز ما تبقى في باقتك (' +
      ((plan.maxBytes - usage.bytes) / 1048576).toFixed(1) + ' م.ب). رقِّ الباقة أو احذف ملفات.',
      { maxBytes: plan.maxBytes, used: usage.bytes, incoming, plan: plan.key }
    );
  }

  let cats = [];
  if (req.body && req.body.categories) {
    try { cats = JSON.parse(req.body.categories); } catch (_) { cats = []; }
  }
  const fallbackCat = S.normalizeCategory(req.body && req.body.category);

  const inserted = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const cat = S.normalizeCategory(cats[i] || fallbackCat);
    const storedName = S.makeStoredName(f.originalname);
    const key = S.buildKey(req.user.id, tender.id, storedName);

    // الرفع عبر الطبقة المجرّدة — يعيد checksum محسوباً على المحتوى الفعلي
    const put = await store.put(key, f.buffer, {
      mime: f.mimetype || 'application/octet-stream',
      originalName: S.displayName(f.originalname)
    });

    const id = uid('fil_');
    db.prepare(`INSERT INTO files
        (id, tender_id, user_id, name, stored_name, rel_path, storage_key, storage_driver,
         checksum_sha256, category, size, mime)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, tender.id, req.user.id, S.displayName(f.originalname), storedName, key, key, driverName,
           put.checksum, cat, f.size, f.mimetype || 'application/octet-stream');

    audit({
      action: 'upload', entity: 'file', entityId: id, userId: req.user.id,
      driver: driverName, ip: req.ip,
      detail: { key, size: f.size, category: cat, checksum: put.checksum }
    });

    inserted.push(db.prepare('SELECT * FROM files WHERE id = ?').get(id));
  }

  db.prepare("UPDATE tenders SET status = 'ready', updated_at = unixepoch() WHERE id = ?").run(tender.id);

  res.status(201).json({
    files: inserted.map(shapeFile),
    count: inserted.length,
    driver: driverName,
    message: 'تم رفع ' + inserted.length + ' ملف/ملفات بنجاح' + (driverName === 's3' ? ' إلى التخزين السحابي.' : ' إلى التخزين المحلي.')
  });
}));

/* ---------------- GET /api/tenders/:id/files ---------------- */
router.get('/tenders/:id/files', auth, wrap(async (req, res) => {
  const tender = A.ownTender(req, req.params.id);
  const rows = getDB().prepare('SELECT * FROM files WHERE tender_id = ? ORDER BY uploaded_at DESC').all(tender.id);
  res.json({ files: rows.map(shapeFile), count: rows.length, driver: S.getStorage().DRIVER });
}));

/* ---------------- GET /api/files/:id/url ----------------
   رابط موقّع مؤقت. الملكية تُتحقَّق هنا قبل إصدار أي رابط —
   لا يمكن لمستخدم الحصول على رابط لملف غيره حتى لو خمّن المعرّف.
------------------------------------------------------------ */
router.get('/files/:id/url', auth, wrap(async (req, res) => {
  const f = A.ownFile(req, req.params.id);
  const key = f.storage_key || f.rel_path;
  const fileDriver = f.storage_driver || 'local';
  const effective = loadDriver(fileDriver);

  if (!(await effective.exists(key))) {
    throw E.notFound('الملف غير موجود في التخزين. قد يكون حُذف.');
  }

  const signed = await effective.signedUrl(key, {
    expiresIn: config.SIGNED_URL_TTL,
    downloadName: f.name
  });

  audit({
    action: 'signed_url', entity: 'file', entityId: f.id, userId: req.user.id,
    driver: fileDriver, ip: req.ip, detail: { key, expiresIn: signed.expiresIn }
  });

  res.json({
    url: signed.url,
    expiresIn: signed.expiresIn,
    driver: fileDriver,
    name: f.name,
    size: f.size,
    checksum: f.checksum_sha256 || null
  });
}));

/* ---------------- GET /api/files/:id/download ---------------- */
router.get('/files/:id/download', auth, wrap(async (req, res) => {
  const f = A.ownFile(req, req.params.id);
  const key = f.storage_key || f.rel_path;
  const fileDriver = f.storage_driver || 'local';
  const effective = loadDriver(fileDriver);

  if (!(await effective.exists(key))) {
    throw E.notFound('الملف غير موجود على الخادم. قد يكون حُذف.');
  }

  audit({
    action: 'download', entity: 'file', entityId: f.id, userId: req.user.id,
    driver: fileDriver, ip: req.ip, detail: { key }
  });

  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(f.name) + '"');
  if (f.size) res.setHeader('Content-Length', f.size);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');

  if (fileDriver === 's3') {
    // تدفّق مباشر من السحابة إلى العميل — لا نحمّل الملف في الذاكرة
    const s = await effective.stream(key);
    s.body.pipe(res);
  } else {
    effective.stream(key).pipe(res);
  }
}));

/* ---------------- GET /api/storage/local?k&e&s ----------------
   مسار التحميل للرابط المحلي الموقّع. التوقيع يمنع العبث بالمفتاح،
   لكنه لا يغني عن فحص الملكية: المفتاح نفسه يحتوي معرّف المستخدم.
------------------------------------------------------------ */
router.get('/storage/local', wrap(async (req, res) => {
  const local = require('../lib/storage/local');
  const key = String(req.query.k || '');
  const v = local.verifySignedUrl(key, req.query.e, req.query.s);
  if (!v.ok) {
    return res.status(403).json({
      error: {
        code: 'SIGNED_URL_INVALID',
        message: v.reason === 'expired' ? 'انتهت صلاحية الرابط. أعد طلب رابط جديد.' : 'رابط غير صالح.'
      }
    });
  }

  // المفتاح يبدأ بـ users/<user_id>/... — لازم تكون الجلسة لنفس المستخدم
  const owner = key.split('/')[1];
  const token = A.extractToken(req);
  let sessionUser = null;
  if (token) {
    try { sessionUser = A.verifyToken(token).sub; } catch (_) { sessionUser = null; }
  }
  if (!sessionUser || sessionUser !== owner) {
    const db = getDB();
    const rec = db.prepare('SELECT * FROM files WHERE storage_key = ? OR rel_path = ?').get(key, key);
    if (!rec || rec.user_id !== sessionUser) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'الملف غير موجود.' } });
    }
  }

  if (!(await local.exists(key))) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'الملف غير موجود في التخزين.' } });
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, no-store');
  local.stream(key).pipe(res);
}));

/* ---------------- GET /api/health/storage ---------------- */
router.get('/health/storage', wrap(async (req, res) => {
  const store = S.getStorage();
  const h = await store.health();
  const db = getDB();
  const byDriver = db.prepare('SELECT storage_driver AS d, COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM files GROUP BY storage_driver').all();
  res.status(h.ok ? 200 : 503).json({
    storage: h,
    configured: config.STORAGE_DRIVER,
    signedUrlTtl: config.SIGNED_URL_TTL,
    filesByDriver: byDriver
  });
}));

/* ---------------- DELETE /api/files/:id ---------------- */
router.delete('/files/:id', auth, wrap(async (req, res) => {
  const f = A.ownFile(req, req.params.id);
  const db = getDB();
  const key = f.storage_key || f.rel_path;
  const fileDriver = f.storage_driver || 'local';
  const effective = loadDriver(fileDriver);

  db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
  try { await effective.delete(key); } catch (err) {
    console.warn('[files] فشل حذف الكائن من التخزين:', key, err.message);
  }

  audit({
    action: 'delete', entity: 'file', entityId: f.id, userId: req.user.id,
    driver: fileDriver, ip: req.ip, detail: { key, name: f.name, size: f.size }
  });

  const left = db.prepare('SELECT COUNT(*) AS n FROM files WHERE tender_id = ?').get(f.tender_id).n;
  db.prepare('UPDATE tenders SET status = ?, updated_at = unixepoch() WHERE id = ?')
    .run(left ? 'ready' : 'new', f.tender_id);

  res.json({ ok: true, remaining: left, message: 'تم حذف الملف.' });
}));

module.exports = router;
