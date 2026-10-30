'use strict';
/**
 * توثيق الجهات: طلب الجهة + مراجعة الإدارة.
 * المنصة تتحقق من هوية الجهة فقط، وليست جهة اعتماد حكومية.
 */
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const S = require('../lib/storage');
const O = require('../lib/org');
const { audit } = require('../lib/audit');

const router = express.Router();
const auth = A.requireAuth;
const buyer = [auth, A.requireRole('buyer')];
const admin = [auth, A.requireRole('admin')];
const DOC_MAX = Math.min(config.MAX_FILE_BYTES, 10 * 1024 * 1024);
const DOC_EXTS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp']);

const docsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOC_MAX, files: 3 },
  fileFilter: (req, file, cb) => {
    if (!DOC_EXTS.has(S.safeExt(file.originalname))) return cb(E.unsupported('الوثائق يجب أن تكون PDF أو JPG أو PNG أو WEBP.'));
    try { S.assertAllowed(file.originalname, 0); cb(null, true); } catch (err) { cb(err); }
  }
});

const clip = (s, n) => String(s || '').trim().slice(0, n);
function docsOf(verificationId) {
  return getDB().prepare('SELECT id, original_name, mime, size, uploaded_at FROM org_verification_docs WHERE verification_id = ? ORDER BY uploaded_at')
    .all(verificationId).map((d) => ({ id: d.id, name: d.original_name, mime: d.mime, size: d.size }));
}
function shape(v, withUser) {
  const out = {
    id: v.id, orgName: v.org_name, orgType: v.org_type, orgTypeAr: O.ORG_TYPES[v.org_type] || v.org_type, orgTypeEn: O.ORG_TYPES_EN[v.org_type] || v.org_type,
    country: v.country, countryAr: (O.COUNTRIES[v.country] || {}).ar || v.country, countryEn: (O.COUNTRIES[v.country] || {}).en || v.country,
    regNumber: v.reg_number, officialPhone: v.official_phone, officialEmail: v.official_email,
    onBehalfOf: v.on_behalf_of || null, website: v.website || null,
    status: v.status, effective: O.isVerifiedRow(v) ? 'verified' : (v.status === 'verified' ? 'expired' : v.status),
    reviewNote: v.review_note || null, verifiedAt: v.verified_at || null, expiresAt: v.expires_at || null,
    submittedAt: v.submitted_at, docs: docsOf(v.id)
  };
  if (withUser) { out.userName = v.user_name; out.userEmail = v.user_email; out.userId = v.user_id; }
  return out;
}

router.get('/meta', wrap(async (req, res) => {
  res.json({
    required: config.REQUIRE_ORG_VERIFICATION,
    countries: Object.entries(O.COUNTRIES).map(([code, c]) => ({ code, ar: c.ar, en: c.en, currency: c.currency })),
    orgTypes: Object.entries(O.ORG_TYPES).map(([key, ar]) => ({ key, ar, en: O.ORG_TYPES_EN[key] }))
  });
}));

/* ---------- الجهة ---------- */
router.get('/', buyer, wrap(async (req, res) => {
  const v = O.getVerification(req.user.id);
  res.json({ verification: v ? shape(v) : null, required: config.REQUIRE_ORG_VERIFICATION });
}));

router.post('/', buyer, docsUpload.array('docs', 3), wrap(async (req, res) => {
  const b = req.body || {};
  const f = {
    orgName: clip(b.orgName, 200), orgType: clip(b.orgType, 30), country: clip(b.country, 2).toUpperCase(),
    regNumber: clip(b.regNumber, 60), officialPhone: clip(b.officialPhone, 30), officialEmail: clip(b.officialEmail, 120).toLowerCase(),
    onBehalfOf: clip(b.onBehalfOf, 200), website: clip(b.website, 200)
  };
  if (f.orgName.length < 3) throw E.validation('أدخل اسم الجهة كما هو في وثائقها الرسمية.');
  if (!O.ORG_TYPES[f.orgType]) throw E.validation('اختر نوع الجهة.');
  if (!O.COUNTRIES[f.country]) throw E.validation('اختر الدولة.');
  if (f.regNumber.length < 3) throw E.validation('أدخل رقم التسجيل أو الترخيص.');
  if (!/^[+\d][\d\s()-]{5,28}$/.test(f.officialPhone)) throw E.validation('أدخل هاتفاً رسمياً صحيحاً (أرقام ورمز + فقط).');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.officialEmail)) throw E.validation('أدخل بريداً رسمياً صحيحاً.');
  const files = req.files || [];
  if (!files.length) throw E.validation('أرفق وثيقة واحدة على الأقل (سجل تجاري أو ترخيص أو كتاب تفويض).');

  const db = getDB();
  const existing = O.getVerification(req.user.id);
  if (existing && existing.status === 'pending') throw E.conflict('طلبك قيد المراجعة. انتظر قرار الإدارة.');
  if (existing && O.isVerifiedRow(existing)) throw E.conflict('جهتك موثّقة وسارية. للتعديل تواصل مع الإدارة.');

  const store = S.getStorage();
  const id = existing ? existing.id : uid('org_');
  const stored = [];
  for (const file of files) {
    const key = `users/${req.user.id}/verification/${id}/${S.makeStoredName(file.originalname)}`;
    const put = await store.put(key, file.buffer, { mime: file.mimetype, originalName: S.displayName(file.originalname) });
    stored.push({ key, name: S.displayName(file.originalname), mime: file.mimetype, size: file.size, checksum: put.checksum });
  }
  const oldDocs = existing ? db.prepare('SELECT * FROM org_verification_docs WHERE verification_id = ?').all(id) : [];
  db.transaction(() => {
    if (existing) {
      db.prepare(`UPDATE org_verifications SET org_name=?,org_type=?,country=?,reg_number=?,official_phone=?,official_email=?,on_behalf_of=?,website=?,
        status='pending',review_note=NULL,reviewed_by=NULL,reviewed_at=NULL,verified_at=NULL,expires_at=NULL,submitted_at=unixepoch(),updated_at=unixepoch() WHERE id=?`)
        .run(f.orgName, f.orgType, f.country, f.regNumber, f.officialPhone, f.officialEmail, f.onBehalfOf || null, f.website || null, id);
      db.prepare('DELETE FROM org_verification_docs WHERE verification_id = ?').run(id);
    } else {
      db.prepare(`INSERT INTO org_verifications (id,user_id,org_name,org_type,country,reg_number,official_phone,official_email,on_behalf_of,website)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, req.user.id, f.orgName, f.orgType, f.country, f.regNumber, f.officialPhone, f.officialEmail, f.onBehalfOf || null, f.website || null);
    }
    const ins = db.prepare('INSERT INTO org_verification_docs (id,verification_id,storage_key,storage_driver,original_name,mime,size,checksum) VALUES (?,?,?,?,?,?,?,?)');
    stored.forEach((d) => ins.run(uid('odoc_'), id, d.key, store.DRIVER, d.name, d.mime, d.size, d.checksum));
  })();
  for (const d of oldDocs) { try { await store.delete(d.storage_key); } catch (_) { /* ملف يتيم لا يضر */ } }
  audit({ action: 'org_verification_submit', entity: 'org_verification', entityId: id, userId: req.user.id, ip: req.ip, detail: { country: f.country, type: f.orgType, docs: stored.length } });
  res.status(201).json({ verification: shape(O.getVerification(req.user.id)), message: 'استلمنا طلب التوثيق وسنراجعه قريباً.' });
}));

/* ---------- الإدارة ---------- */
function adminQuery(where = '', params = []) {
  return getDB().prepare(`SELECT v.*, u.name user_name, u.email user_email FROM org_verifications v JOIN users u ON u.id=v.user_id ${where}
    ORDER BY CASE v.status WHEN 'pending' THEN 0 ELSE 1 END, v.submitted_at DESC`).all(...params);
}
router.get('/admin', admin, wrap(async (req, res) => {
  const status = clip(req.query.status, 20);
  const rows = adminQuery(status ? 'WHERE v.status = ?' : '', status ? [status] : []);
  res.json({ verifications: rows.map((v) => shape(v, true)), count: rows.length });
}));
router.get('/admin/:id/docs/:docId', admin, wrap(async (req, res) => {
  const d = getDB().prepare('SELECT * FROM org_verification_docs WHERE id = ? AND verification_id = ?').get(req.params.docId, req.params.id);
  if (!d) throw E.notFound('الوثيقة غير موجودة.');
  const store = d.storage_driver === 's3' ? require('../lib/storage/s3') : require('../lib/storage/local');
  if (!(await store.exists(d.storage_key))) throw E.notFound('ملف الوثيقة غير موجود في التخزين.');
  res.setHeader('Content-Type', d.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(d.original_name) + '"');
  res.setHeader('Cache-Control', 'private, no-store');
  store.stream(d.storage_key).pipe(res);
}));
function load(id) {
  const v = getDB().prepare('SELECT * FROM org_verifications WHERE id = ?').get(id);
  if (!v) throw E.notFound('طلب التوثيق غير موجود.');
  return v;
}
router.post('/admin/:id/approve', admin, wrap(async (req, res) => {
  const v = load(req.params.id);
  if (v.status === 'verified') throw E.conflict('هذه الجهة موثّقة بالفعل.');
  const days = Math.min(Math.max(Number(req.body?.days) || config.VERIFICATION_DAYS, 30), 1095);
  const now = Math.floor(Date.now() / 1000);
  getDB().prepare("UPDATE org_verifications SET status='verified',review_note=?,reviewed_by=?,reviewed_at=?,verified_at=?,expires_at=?,updated_at=? WHERE id=?")
    .run(clip(req.body?.note, 500) || null, req.user.id, now, now, now + days * 86400, now, v.id);
  audit({ action: 'org_verification_approve', entity: 'org_verification', entityId: v.id, userId: req.user.id, ip: req.ip, detail: { days } });
  res.json({ ok: true, message: 'تم توثيق الجهة لمدة ' + days + ' يوماً.' });
}));
router.post('/admin/:id/reject', admin, wrap(async (req, res) => {
  const v = load(req.params.id);
  const note = clip(req.body?.note, 500);
  if (note.length < 3) throw E.validation('اكتب سبب الرفض ليتمكن صاحب الطلب من التصحيح.');
  getDB().prepare("UPDATE org_verifications SET status='rejected',review_note=?,reviewed_by=?,reviewed_at=unixepoch(),verified_at=NULL,expires_at=NULL,updated_at=unixepoch() WHERE id=?").run(note, req.user.id, v.id);
  audit({ action: 'org_verification_reject', entity: 'org_verification', entityId: v.id, userId: req.user.id, ip: req.ip, detail: { note } });
  res.json({ ok: true, message: 'تم رفض الطلب وإبلاغ الجهة بالسبب.' });
}));
router.post('/admin/:id/revoke', admin, wrap(async (req, res) => {
  const v = load(req.params.id);
  if (v.status !== 'verified') throw E.conflict('لا يمكن سحب توثيق غير ساري.');
  const note = clip(req.body?.note, 500);
  if (note.length < 3) throw E.validation('اكتب سبب سحب التوثيق.');
  getDB().prepare("UPDATE org_verifications SET status='revoked',review_note=?,reviewed_by=?,reviewed_at=unixepoch(),expires_at=NULL,updated_at=unixepoch() WHERE id=?").run(note, req.user.id, v.id);
  audit({ action: 'org_verification_revoke', entity: 'org_verification', entityId: v.id, userId: req.user.id, ip: req.ip, detail: { note } });
  res.json({ ok: true, message: 'تم سحب التوثيق. لن تُقبل عروض جديدة على عطاءات هذه الجهة.' });
}));

module.exports = router;
