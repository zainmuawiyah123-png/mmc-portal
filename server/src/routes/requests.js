'use strict';
/**
 * دورة الطلبات: المالك/الطالب ← دائرة المشاريع (مخططات ومواصفات وشروط العقد حسب FIDIC)
 * ← المشتريات (تنشر العطاء) ← المقاول (المسار القائم).
 */
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const S = require('../lib/storage');
const O = require('../lib/org');
const procurement = require('./procurement');
const { audit } = require('../lib/audit');

const router = express.Router();
const buyerOnly = [A.requireAuth, A.requireRole('buyer')];
const clip = (s, n) => String(s || '').trim().slice(0, n);
const SERVICE_TYPES = ['works', 'consultancy', 'supply', 'other'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_BYTES, files: 5 },
  fileFilter: (req, file, cb) => { try { S.assertAllowed(file.originalname, 0); cb(null, true); } catch (e) { cb(e); } }
});

/* ---------- الصلاحيات ---------- */
const isOwnReq = (u, r) => r.requester_id === u.id;
const WHO = {
  requesterOrManager: (m, u, r) => m.role === 'manager' || (m.role === 'requester' && isOwnReq(u, r)),
  projects: (m) => ['projects', 'manager'].includes(m.role),
  procurement: (m) => ['procurement', 'manager'].includes(m.role)
};
const TRANSITIONS = {
  submit: { from: ['draft', 'returned'], who: WHO.requesterOrManager, to: () => 'submitted' },
  take: { from: ['submitted'], who: WHO.projects, to: () => 'in_study' },
  return: { from: ['submitted', 'in_study'], who: WHO.projects, to: () => 'returned', note: true },
  ready: { from: ['in_study'], who: WHO.projects, to: (m) => (m.require_approval ? 'awaiting_approval' : 'ready') },
  approve: { from: ['awaiting_approval'], who: WHO.requesterOrManager, to: () => 'ready' },
  reject: { from: ['awaiting_approval'], who: WHO.requesterOrManager, to: () => 'in_study', note: true },
  send_back: { from: ['ready'], who: WHO.procurement, to: () => 'in_study', note: true },
  cancel: { from: ['draft', 'submitted', 'returned'], who: WHO.requesterOrManager, to: () => 'cancelled' }
};

function canView(m, u, r) {
  if (r.org_id !== m.org_id) return false;
  if (m.role === 'manager') return true;
  if (m.role === 'requester') return isOwnReq(u, r);
  if (m.role === 'projects') return r.status !== 'draft';
  if (m.role === 'procurement') return ['ready', 'published'].includes(r.status);
  return false;
}
function actionsFor(m, u, r) {
  const acts = Object.entries(TRANSITIONS).filter(([, t]) => t.from.includes(r.status) && t.who(m, u, r)).map(([k]) => k);
  if (r.status === 'ready' && WHO.procurement(m)) acts.push('publish');
  return acts;
}
const canEditBasic = (m, u, r) => (m.role === 'requester' && isOwnReq(u, r) && ['draft', 'returned'].includes(r.status))
  || (m.role === 'manager' && ['draft', 'returned', 'submitted', 'in_study'].includes(r.status));
const canEditTech = (m, r) => WHO.projects(m) && r.status === 'in_study';
function canUploadKind(m, u, r, kind) {
  if (kind === 'brief') return (m.role === 'manager' && ['draft', 'returned', 'submitted'].includes(r.status)) || (m.role === 'requester' && isOwnReq(u, r) && ['draft', 'returned'].includes(r.status));
  return WHO.projects(m) && r.status === 'in_study';
}

/* ---------- أدوات ---------- */
function load(m, u, id) {
  const r = getDB().prepare('SELECT * FROM project_requests WHERE id = ?').get(id);
  if (!r || !canView(m, u, r)) throw E.notFound('الطلب غير موجود.');
  return r;
}
function event(r, user, action, from, to, note) {
  getDB().prepare('INSERT INTO request_events (id, request_id, user_id, action, from_status, to_status, note) VALUES (?,?,?,?,?,?,?)')
    .run(uid('evt_'), r.id, user.id, action, from || null, to || null, note || null);
}
function docsOf(requestId) {
  return getDB().prepare('SELECT d.id, d.kind, d.original_name name, d.size, d.uploaded_at, u.name uploader FROM request_docs d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.request_id = ? ORDER BY d.uploaded_at').all(requestId)
    .map((d) => ({ id: d.id, kind: d.kind, name: d.name, size: d.size, uploadedAt: d.uploaded_at, uploader: d.uploader, public: O.PUBLIC_DOC_KINDS.includes(d.kind) }));
}
function shape(r, m, u, withDetail) {
  const names = getDB().prepare('SELECT (SELECT name FROM users WHERE id = ?) requester, (SELECT name FROM users WHERE id = ?) assignee').get(r.requester_id, r.assigned_to || '');
  const bk = O.FIDIC_BOOKS[r.fidic_book] || null;
  const out = {
    id: r.id, title: r.title, titleEn: r.title_en || null, description: r.description || '', location: r.location || '', country: r.country || null,
    serviceType: r.service_type || null, budget: r.budget, currency: r.currency || null, neededBy: r.needed_by || null,
    status: r.status, fidicBook: r.fidic_book || null, fidicBookAr: bk ? bk.ar : null, fidicBookEn: bk ? bk.en : null, fidicEdition: r.fidic_edition || null,
    particularNotes: r.particular_notes || '', reviewNote: r.review_note || null, tenderId: r.tender_id || null,
    requester: names.requester, assignee: names.assignee || null, createdAt: r.created_at, submittedAt: r.submitted_at, updatedAt: r.updated_at,
    actions: actionsFor(m, u, r), canEditBasic: canEditBasic(m, u, r), canEditTech: canEditTech(m, r)
  };
  if (withDetail) {
    out.docs = docsOf(r.id);
    out.events = getDB().prepare('SELECT e.action, e.from_status, e.to_status, e.note, e.at, u.name who FROM request_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.request_id = ? ORDER BY e.at, e.rowid').all(r.id)
      .map((e) => ({ action: e.action, from: e.from_status, to: e.to_status, note: e.note, at: e.at, who: e.who }));
    out.uploadKinds = O.DOC_KINDS.filter((k) => canUploadKind(m, u, r, k));
  }
  return out;
}
function cleanBasic(b) {
  const f = {
    title: clip(b.title, 200), titleEn: clip(b.titleEn, 200), description: clip(b.description, 4000), location: clip(b.location, 200),
    country: clip(b.country, 2).toUpperCase(), serviceType: clip(b.serviceType, 20), currency: clip(b.currency, 3).toUpperCase(),
    neededBy: clip(b.neededBy, 10), budget: b.budget === '' || b.budget == null ? null : Number(b.budget)
  };
  if (f.title.length < 3) throw E.validation('اكتب عنواناً واضحاً للطلب.');
  if (f.country && !O.COUNTRIES[f.country]) throw E.validation('الدولة غير مدعومة.');
  if (f.serviceType && !SERVICE_TYPES.includes(f.serviceType)) throw E.validation('نوع الخدمة غير صحيح.');
  if (f.budget !== null && (!Number.isFinite(f.budget) || f.budget < 0)) throw E.validation('الميزانية يجب أن تكون رقماً موجباً.');
  if (f.currency && !O.BID_CURRENCIES.includes(f.currency)) throw E.validation('العملة غير مدعومة.');
  if (f.neededBy && !/^\d{4}-\d{2}-\d{2}$/.test(f.neededBy)) throw E.validation('صيغة التاريخ YYYY-MM-DD.');
  return f;
}

/* ---------- المسارات ---------- */
router.get('/meta', wrap(async (req, res) => {
  res.json({
    fidicUrl: O.FIDIC_URL,
    fidicBooks: Object.entries(O.FIDIC_BOOKS).map(([key, v]) => ({ key, ar: v.ar, en: v.en })),
    fidicEditions: O.FIDIC_EDITIONS, docKinds: O.DOC_KINDS, publicDocKinds: O.PUBLIC_DOC_KINDS, serviceTypes: SERVICE_TYPES,
    countries: Object.entries(O.COUNTRIES).map(([code, c]) => ({ code, ar: c.ar, en: c.en, currency: c.currency })), currencies: O.BID_CURRENCIES
  });
}));

router.get('/', buyerOnly, wrap(async (req, res) => {
  const m = O.ensureOrg(req.user);
  const rows = getDB().prepare('SELECT * FROM project_requests WHERE org_id = ? ORDER BY updated_at DESC, created_at DESC').all(m.org_id).filter((r) => canView(m, req.user, r));
  const counts = {};
  rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  res.json({ myRole: m.role, requests: rows.map((r) => shape(r, m, req.user, false)), counts });
}));

router.post('/', buyerOnly, wrap(async (req, res) => {
  const m = O.ensureOrg(req.user);
  if (!['requester', 'manager'].includes(m.role)) throw E.forbidden('تقديم الطلبات لدور المالك/الطالب أو مدير الجهة.');
  const f = cleanBasic(req.body || {});
  const id = uid('req_');
  getDB().prepare(`INSERT INTO project_requests (id, org_id, requester_id, title, title_en, description, location, country, service_type, budget, currency, needed_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, m.org_id, req.user.id, f.title, f.titleEn || null, f.description, f.location, f.country || null, f.serviceType || null, f.budget, f.currency || null, f.neededBy || null);
  const r = getDB().prepare('SELECT * FROM project_requests WHERE id = ?').get(id);
  event(r, req.user, 'create', null, 'draft');
  audit({ action: 'request_create', entity: 'request', entityId: id, userId: req.user.id, ip: req.ip });
  res.status(201).json({ request: shape(r, m, req.user, true) });
}));

router.get('/:id', buyerOnly, wrap(async (req, res) => {
  const m = O.ensureOrg(req.user);
  res.json({ request: shape(load(m, req.user, req.params.id), m, req.user, true) });
}));

router.patch('/:id', buyerOnly, wrap(async (req, res) => {
  const m = O.ensureOrg(req.user);
  const r = load(m, req.user, req.params.id);
  const b = req.body || {};
  const db = getDB();
  let changed = false;
  if (canEditBasic(m, req.user, r) && b.title !== undefined) {
    const f = cleanBasic({ ...r, titleEn: r.title_en, serviceType: r.service_type, neededBy: r.needed_by, ...b });
    db.prepare('UPDATE project_requests SET title=?,title_en=?,description=?,location=?,country=?,service_type=?,budget=?,currency=?,needed_by=?,updated_at=unixepoch() WHERE id=?')
      .run(f.title, f.titleEn || null, f.description, f.location, f.country || null, f.serviceType || null, f.budget, f.currency || null, f.neededBy || null, r.id);
    changed = true;
  }
  if (canEditTech(m, r) && (b.fidicBook !== undefined || b.fidicEdition !== undefined || b.particularNotes !== undefined)) {
    const book = b.fidicBook === '' || b.fidicBook == null ? null : clip(b.fidicBook, 10);
    const ed = b.fidicEdition === '' || b.fidicEdition == null ? null : clip(b.fidicEdition, 10);
    if (book && !O.FIDIC_BOOKS[book]) throw E.validation('نوع عقد FIDIC غير صحيح.');
    if (ed && !O.FIDIC_EDITIONS.includes(ed)) throw E.validation('إصدار FIDIC غير صحيح.');
    db.prepare('UPDATE project_requests SET fidic_book=?, fidic_edition=?, particular_notes=?, updated_at=unixepoch() WHERE id=?').run(book, ed, clip(b.particularNotes, 3000), r.id);
    changed = true;
  }
  if (!changed) throw E.forbidden('لا يمكنك تعديل هذا الطلب في حالته الحالية.');
  event(r, req.user, 'edit', r.status, r.status);
  res.json({ request: shape(db.prepare('SELECT * FROM project_requests WHERE id = ?').get(r.id), m, req.user, true) });
}));

router.post('/:id/transition', buyerOnly, wrap(async (req, res) => {
  const m = O.ensureOrg(req.user);
  const r = load(m, req.user, req.params.id);
  const action = clip(req.body?.action, 20);
  const note = clip(req.body?.note, 1000);
  const t = TRANSITIONS[action];
  if (!t) throw E.validation('إجراء غير معروف.');
  if (!t.who(m, req.user, r)) throw E.forbidden('هذا الإجراء ليس من صلاحيات دورك.');
  if (!t.from.includes(r.status)) throw E.conflict('لا يمكن تنفيذ هذا الإجراء في حالة الطلب الحالية.');
  if (t.note && note.length < 3) throw E.validation('اكتب ملاحظة توضح السبب.');
  const db = getDB();
  if (action === 'ready') {
    const publicDocs = db.prepare('SELECT COUNT(*) n FROM request_docs WHERE request_id = ? AND kind IN (' + O.PUBLIC_DOC_KINDS.map(() => '?').join(',') + ')').get(r.id, ...O.PUBLIC_DOC_KINDS).n;
    if (!publicDocs) throw E.validation('أرفق وثيقة واحدة على الأقل من وثائق العطاء (مخططات أو مواصفات أو جدول كميات أو شروط).');
    if (!r.fidic_book) throw E.validation('حدّد نوع عقد FIDIC (أو «عقد آخر») قبل تجهيز الحزمة.');
  }
  const to = t.to(m);
  db.prepare(`UPDATE project_requests SET status = ?, review_note = ?, assigned_to = CASE WHEN ? = 'take' THEN ? ELSE assigned_to END,
    submitted_at = CASE WHEN ? = 'submit' THEN unixepoch() ELSE submitted_at END, updated_at = unixepoch() WHERE id = ?`)
    .run(to, ['return', 'reject', 'send_back'].includes(action) ? note : null, action, req.user.id, action, r.id);
  event(r, req.user, action, r.status, to, note);
  audit({ action: 'request_' + action, entity: 'request', entityId: r.id, userId: req.user.id, ip: req.ip, detail: { from: r.status, to } });
  res.json({ request: shape(db.prepare('SELECT * FROM project_requests WHERE id = ?').get(r.id), m, req.user, true) });
}));

router.post('/:id/docs', buyerOnly, upload.array('files', 5), wrap(async (req, res) => {
  const m = O.ensureOrg(req.user);
  const r = load(m, req.user, req.params.id);
  const kind = clip(req.body?.kind, 30);
  if (!O.DOC_KINDS.includes(kind)) throw E.validation('نوع الوثيقة غير صحيح.');
  if (!canUploadKind(m, req.user, r, kind)) throw E.forbidden('لا يمكنك إضافة هذا النوع من الوثائق في الحالة الحالية.');
  const files = req.files || [];
  if (!files.length) throw E.validation('اختر ملفاً للرفع.');
  const store = S.getStorage();
  const db = getDB();
  for (const f of files) {
    const key = `requests/${r.id}/${S.makeStoredName(f.originalname)}`;
    const put = await store.put(key, f.buffer, { mime: f.mimetype, originalName: S.displayName(f.originalname) });
    db.prepare('INSERT INTO request_docs (id, request_id, kind, storage_key, storage_driver, original_name, mime, size, checksum, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(uid('rdoc_'), r.id, kind, key, store.DRIVER, S.displayName(f.originalname), f.mimetype, f.size, put.checksum, req.user.id);
  }
  db.prepare('UPDATE project_requests SET updated_at = unixepoch() WHERE id = ?').run(r.id);
  event(r, req.user, 'docs', r.status, r.status, kind + ' × ' + files.length);
  res.status(201).json({ docs: docsOf(r.id) });
}));

router.get('/:id/docs/:docId', buyerOnly, wrap(async (req, res) => {
  const m = O.ensureOrg(req.user);
  const r = load(m, req.user, req.params.id);
  const d = getDB().prepare('SELECT * FROM request_docs WHERE id = ? AND request_id = ?').get(req.params.docId, r.id);
  if (!d) throw E.notFound('الوثيقة غير موجودة.');
  const store = d.storage_driver === 's3' ? require('../lib/storage/s3') : require('../lib/storage/local');
  if (!(await store.exists(d.storage_key))) throw E.notFound('الملف غير موجود في التخزين.');
  res.setHeader('Content-Type', d.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(d.original_name));
  res.setHeader('Cache-Control', 'private, no-store');
  store.stream(d.storage_key).pipe(res);
}));

router.delete('/:id/docs/:docId', buyerOnly, wrap(async (req, res) => {
  const m = O.ensureOrg(req.user);
  const r = load(m, req.user, req.params.id);
  const db = getDB();
  const d = db.prepare('SELECT * FROM request_docs WHERE id = ? AND request_id = ?').get(req.params.docId, r.id);
  if (!d) throw E.notFound('الوثيقة غير موجودة.');
  if (!canUploadKind(m, req.user, r, d.kind)) throw E.forbidden('لا يمكنك حذف هذه الوثيقة في الحالة الحالية.');
  db.prepare('DELETE FROM request_docs WHERE id = ?').run(d.id);
  try { await S.getStorage().delete(d.storage_key); } catch (_) { /* ملف يتيم لا يضر */ }
  event(r, req.user, 'doc_delete', r.status, r.status, d.original_name);
  res.json({ ok: true });
}));

/* التسليم للمشتريات: ينشئ العطاء وينشره (يمرّ بشروط التوثيق وحدود الباقة نفسها) */
router.post('/:id/tender', buyerOnly, wrap(async (req, res) => {
  const m = O.ensureOrg(req.user);
  const r = load(m, req.user, req.params.id);
  if (!WHO.procurement(m)) throw E.forbidden('نشر العطاء لدور المشتريات أو مدير الجهة.');
  if (r.status !== 'ready') throw E.conflict('الطلب ليس جاهزاً للنشر.');
  const b = req.body || {};
  const v = O.getVerification(req.user.id);
  const body = {
    ...b,
    name: clip(b.name, 200) || r.title, nameEn: clip(b.nameEn, 200) || r.title_en || '',
    notes: b.notes !== undefined ? b.notes : r.description, authority: (v && v.org_name) || m.org_name,
    reference: clip(b.reference, 80) || ('REQ-' + r.id.slice(-6).toUpperCase())
  };
  const tenderId = procurement.createTender(req.user, body, { requestId: r.id });
  const db = getDB();
  db.prepare("UPDATE project_requests SET status = 'published', tender_id = ?, updated_at = unixepoch() WHERE id = ?").run(tenderId, r.id);
  event(r, req.user, 'publish', 'ready', 'published', body.reference);
  audit({ action: 'request_publish', entity: 'request', entityId: r.id, userId: req.user.id, ip: req.ip, detail: { tenderId } });
  res.status(201).json({ tenderId, request: shape(db.prepare('SELECT * FROM project_requests WHERE id = ?').get(r.id), m, req.user, true), message: 'تم نشر العطاء وربطه بالطلب.' });
}));

module.exports = router;
