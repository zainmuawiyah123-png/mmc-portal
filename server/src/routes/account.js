'use strict';
/**
 * نقاط الطلبات/الاستفسارات + الباقة والاستهلاك + قائمة الباقات.
 */
const express = require('express');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const { requestCreateSchema, planChangeSchema, parse } = require('../lib/validate');
const A = require('../lib/auth');

const router = express.Router();
// نفس السبب كما في files.js: حماية لكل مسار بدل router.use
const auth = A.requireAuth;

const shapeReq = (r) => ({
  id: r.id, tenderId: r.tender_id, kind: r.kind, text: r.text,
  status: r.status, createdAt: r.created_at
});

/* ---------------- POST /api/tenders/:id/requests ---------------- */
router.post('/tenders/:id/requests', auth, wrap(async (req, res) => {
  const tender = A.ownTender(req, req.params.id);
  const body = parse(requestCreateSchema, req.body);
  const db = getDB();
  const id = uid('req_');
  db.prepare('INSERT INTO requests (id, tender_id, user_id, kind, text) VALUES (?,?,?,?,?)')
    .run(id, tender.id, req.user.id, body.kind, body.text);
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  res.status(201).json({ request: shapeReq(row), message: 'تم تسجيل الطلب.' });
}));

/* ---------------- GET /api/tenders/:id/requests ---------------- */
router.get('/tenders/:id/requests', auth, wrap(async (req, res) => {
  const tender = A.ownTender(req, req.params.id);
  const rows = getDB().prepare('SELECT * FROM requests WHERE tender_id = ? ORDER BY created_at DESC').all(tender.id);
  res.json({ requests: rows.map(shapeReq), count: rows.length });
}));

/* ---------------- DELETE /api/requests/:id ---------------- */
router.delete('/requests/:id', auth, wrap(async (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!row || row.user_id !== req.user.id) throw E.notFound('الطلب غير موجود.');
  db.prepare('DELETE FROM requests WHERE id = ?').run(row.id);
  res.json({ ok: true, message: 'تم حذف الطلب.' });
}));

/* ---------------- GET /api/plans ---------------- */
router.get('/plans', auth, wrap(async (req, res) => {
  if (req.user.role === 'buyer') {
    const free = A.planAndUsage(req.user.id).plan;
    return res.json({ plans: [{ key: 'free', nameAr: free.nameAr, nameEn: free.nameEn,
      maxTenders: null, maxSubmissions: null, maxBytes: null, priceMonth: 0, priceYear: 0, sortOrder: 0 }], buyerCoreFree: true });
  }
  const rows = getDB().prepare("SELECT * FROM plans WHERE audience = 'contractor' OR key = 'free' ORDER BY sort_order").all();
  res.json({ plans: rows.map((p) => ({
    key: p.key, nameAr: p.name_ar, nameEn: p.name_en,
    maxTenders: p.max_tenders === -1 ? null : p.max_tenders,
    maxSubmissions: p.max_submissions === -1 ? null : p.max_submissions,
    maxBytes: p.max_bytes === -1 ? null : p.max_bytes,
    priceMonth: p.price_month, priceYear: p.price_year, sortOrder: p.sort_order
  })), buyerCoreFree: false });
}));

/* ---------------- GET /api/usage ---------------- */
router.get('/usage', auth, wrap(async (req, res) => {
  res.json(A.planAndUsage(req.user.id));
}));

/* ---------------- POST /api/plan ----------------
   في هذه المرحلة: تبديل الباقة يدوياً (لا دفع). مقيّد بعدم تجاوز الحدود.
------------------------------------------------------------ */
router.post('/plan', auth, wrap(async (req, res) => {
  if (req.user.role === 'buyer') throw E.forbidden('بوابة المشتريات الأساسية مجانية دائماً ولا يمكن تغييرها إلى باقة مدفوعة.');
  const body = parse(planChangeSchema, req.body);
  const db = getDB();

  const target = db.prepare('SELECT * FROM plans WHERE key = ?').get(body.planKey);
  if (!target) throw E.notFound('الباقة غير موجودة.');

  const current = A.planAndUsage(req.user.id);
  // منع التراجع إلى باقة لا تتسع للاستهلاك الحالي
  if (target.max_tenders !== -1 && current.usage.tenders > target.max_tenders) {
    throw E.conflict('لا يمكن الانتقال إلى ' + target.name_ar + ': لديك ' + current.usage.tenders +
      ' عطاء والحد ' + target.max_tenders + '. احذف عطاءات أولاً.');
  }
  if (target.max_bytes !== -1 && current.usage.bytes > target.max_bytes) {
    throw E.conflict('لا يمكن الانتقال إلى ' + target.name_ar + ': حجم ملفاتك يتجاوز حد الباقة.');
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE subscriptions SET status = ? WHERE user_id = ? AND status = ?')
      .run('cancelled', req.user.id, 'active');
    db.prepare('UPDATE users SET plan_key = ?, plan_started_at = unixepoch() WHERE id = ?')
      .run(body.planKey, req.user.id);
    db.prepare('INSERT INTO subscriptions (id, user_id, plan_key, status, source) VALUES (?,?,?,?,?)')
      .run(uid('sub_'), req.user.id, body.planKey, 'active', 'manual');
  });
  tx();

  res.json({
    ...A.planAndUsage(req.user.id),
    message: 'تم تفعيل باقة ' + target.name_ar + '. (لا يوجد دفع فعلي في هذه المرحلة.)'
  });
}));

/* ---------------- طلب تسجيل اهتمام (صفحة ترقية الباقة) ---------------- */
router.post('/upgrade-interest', auth, wrap(async (req, res) => {
  if (req.user.role === 'buyer') throw E.forbidden('لا توجد باقات اشتراك لبوابة المشتريات الأساسية.');
  const planKey = String((req.body && req.body.planKey) || '').slice(0, 20);
  // في هذه المرحلة نسجّل الاهتمام فقط، بلا دفع
  console.log('[upgrade-interest]', req.user.email, planKey, new Date().toISOString());
  res.json({ ok: true, message: 'سُجّل اهتمامك بباقة ' + planKey + '. سيُربط الدفع في المرحلة الثالثة.' });
}));

module.exports = router;
