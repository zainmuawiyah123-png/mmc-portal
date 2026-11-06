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

function profileShape(r) {
  if (!r) return { sectors: [], countries: [], minValue: null, maxValue: null, capabilities: '' };
  const parse = v => { try { return JSON.parse(v || '[]'); } catch (_) { return []; } };
  return { sectors: parse(r.sectors_json), countries: parse(r.countries_json), minValue: r.min_value, maxValue: r.max_value, capabilities: r.capabilities || '', updatedAt: r.updated_at };
}

router.get('/contractor-profile', auth, wrap(async (req, res) => {
  const row = getDB().prepare('SELECT * FROM contractor_profiles WHERE user_id=?').get(req.user.id);
  res.json({ profile: profileShape(row) });
}));

router.put('/contractor-profile', auth, wrap(async (req, res) => {
  const b = req.body || {}, cleanList = v => Array.isArray(v) ? [...new Set(v.map(x => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, 30) : [];
  const sectors = cleanList(b.sectors), countries = cleanList(b.countries);
  const min = b.minValue === '' || b.minValue == null ? null : Number(b.minValue), max = b.maxValue === '' || b.maxValue == null ? null : Number(b.maxValue);
  if ((min != null && !Number.isFinite(min)) || (max != null && !Number.isFinite(max)) || (min != null && max != null && min > max)) throw E.validation('نطاق قيمة العطاء غير صحيح.');
  const capabilities = String(b.capabilities || '').trim().slice(0, 2000) || null, db = getDB();
  db.prepare(`INSERT INTO contractor_profiles (user_id,sectors_json,countries_json,min_value,max_value,capabilities,updated_at) VALUES (?,?,?,?,?,?,unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET sectors_json=excluded.sectors_json,countries_json=excluded.countries_json,min_value=excluded.min_value,max_value=excluded.max_value,capabilities=excluded.capabilities,updated_at=unixepoch()`)
    .run(req.user.id, JSON.stringify(sectors), JSON.stringify(countries), min, max, capabilities);
  res.json({ profile: profileShape(db.prepare('SELECT * FROM contractor_profiles WHERE user_id=?').get(req.user.id)), message: 'تم حفظ تفضيلات المطابقة.' });
}));

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
  const aud = req.user.role === 'buyer' ? 'buyer' : 'contractor';
  const rows = getDB().prepare("SELECT * FROM plans WHERE audience = ? OR key = 'free' ORDER BY sort_order").all(aud);
  res.json({
    plans: rows.map((p) => ({
      key: p.key, nameAr: p.name_ar, nameEn: p.name_en,
      maxTenders: p.max_tenders === -1 ? null : p.max_tenders,
      maxSubmissions: p.max_submissions === -1 ? null : p.max_submissions,
      maxBytes: p.max_bytes === -1 ? null : p.max_bytes,
      priceMonth: p.price_month, priceYear: p.price_year, sortOrder: p.sort_order
    }))
  });
}));

/* ---------------- GET /api/usage ---------------- */
router.get('/usage', auth, wrap(async (req, res) => {
  res.json(A.planAndUsage(req.user.id));
}));

/* ---------------- POST /api/plan ----------------
   في هذه المرحلة: تبديل الباقة يدوياً (لا دفع). مقيّد بعدم تجاوز الحدود.
------------------------------------------------------------ */
router.post('/plan', auth, wrap(async (req, res) => {
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
  const planKey = String((req.body && req.body.planKey) || '').slice(0, 20);
  // في هذه المرحلة نسجّل الاهتمام فقط، بلا دفع
  console.log('[upgrade-interest]', req.user.email, planKey, new Date().toISOString());
  res.json({ ok: true, message: 'سُجّل اهتمامك بباقة ' + planKey + '. سيُربط الدفع في المرحلة الثالثة.' });
}));

module.exports = router;
