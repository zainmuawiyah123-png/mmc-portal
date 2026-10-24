'use strict';
/**
 * نقاط العطاءات: إنشاء، قائمة، قراءة، تحديث، حذف.
 * كل نقطة تتحقق أن العطاء يملكه المستخدم الحالي.
 */
const express = require('express');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const { tenderCreateSchema, tenderUpdateSchema, parse } = require('../lib/validate');
const A = require('../lib/auth');
const S = require('../lib/storage');
const config = require('../config');

const router = express.Router();
router.use(A.requireAuth);

/** يحسب حجم الملفات لكل عطاء دفعة واحدة (بدل استعلام لكل صف) */
function fileStats(db, userId) {
  const rows = db.prepare(
    'SELECT tender_id, COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM files WHERE user_id = ? GROUP BY tender_id'
  ).all(userId);
  const map = new Map();
  rows.forEach((r) => map.set(r.tender_id, { count: r.n, bytes: r.bytes }));
  return map;
}

function shape(t, stats) {
  const s = stats || { count: 0, bytes: 0 };
  return {
    id: t.id, name: t.name, authority: t.authority, closing: t.closing, notes: t.notes,
    status: t.status, createdAt: t.created_at, updatedAt: t.updated_at,
    fileCount: s.count, bytes: s.bytes
  };
}

/* ---------------- GET /api/tenders ---------------- */
router.get('/', wrap(async (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT * FROM tenders WHERE user_id = ? ORDER BY updated_at DESC').all(req.user.id);
  const stats = fileStats(db, req.user.id);
  res.json({ tenders: rows.map((t) => shape(t, stats.get(t.id))), count: rows.length });
}));

/* ---------------- POST /api/tenders ---------------- */
router.post('/', wrap(async (req, res) => {
  const body = parse(tenderCreateSchema, req.body);
  const db = getDB();
  const { plan, usage } = A.planAndUsage(req.user.id);

  // حد الباقة
  if (plan.maxTenders !== null && usage.tenders >= plan.maxTenders) {
    throw E.planLimit(
      'وصلت إلى حد باقتك (' + plan.maxTenders + ' عطاء). رقِّ الباقة لإضافة المزيد.',
      { limit: plan.maxTenders, used: usage.tenders, plan: plan.key, upgradeUrl: '../upgrade.html' }
    );
  }

  const id = uid('tnd_');
  db.prepare('INSERT INTO tenders (id, user_id, name, authority, closing, notes, status) VALUES (?,?,?,?,?,?,?)')
    .run(id, req.user.id, body.name, body.authority, body.closing, body.notes, 'new');

  const row = db.prepare('SELECT * FROM tenders WHERE id = ?').get(id);
  res.status(201).json({ tender: shape(row), message: 'تم إنشاء العطاء.' });
}));

/* ---------------- GET /api/tenders/:id ---------------- */
router.get('/:id', wrap(async (req, res) => {
  const row = A.ownTender(req, req.params.id);
  const db = getDB();
  const files = db.prepare('SELECT * FROM files WHERE tender_id = ? ORDER BY uploaded_at DESC').all(row.id);
  const requests = db.prepare('SELECT * FROM requests WHERE tender_id = ? ORDER BY created_at DESC').all(row.id);
  const bytes = files.reduce((a, f) => a + f.size, 0);

  res.json({
    tender: shape(row, { count: files.length, bytes }),
    files: files.map((f) => ({
      id: f.id, name: f.name, category: f.category, size: f.size, mime: f.mime, uploadedAt: f.uploaded_at
    })),
    requests: requests.map((r) => ({
      id: r.id, kind: r.kind, text: r.text, status: r.status, createdAt: r.created_at
    }))
  });
}));

/* ---------------- PATCH /api/tenders/:id ---------------- */
router.patch('/:id', wrap(async (req, res) => {
  const row = A.ownTender(req, req.params.id);
  const body = parse(tenderUpdateSchema, req.body);
  const db = getDB();

  const sets = [];
  const vals = [];
  if (body.name !== undefined) { sets.push('name = ?'); vals.push(body.name); }
  if (body.authority !== undefined) { sets.push('authority = ?'); vals.push(body.authority || null); }
  if (body.closing !== undefined) { sets.push('closing = ?'); vals.push(body.closing || null); }
  if (body.notes !== undefined) { sets.push('notes = ?'); vals.push(body.notes || null); }
  if (body.status !== undefined) { sets.push('status = ?'); vals.push(body.status); }

  if (!sets.length) throw E.badRequest('لا يوجد أي حقل للتحديث.');
  sets.push('updated_at = unixepoch()');
  vals.push(row.id);

  db.prepare('UPDATE tenders SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
  const fresh = db.prepare('SELECT * FROM tenders WHERE id = ?').get(row.id);
  res.json({ tender: shape(fresh), message: 'تم تحديث العطاء.' });
}));

/* ---------------- DELETE /api/tenders/:id ---------------- */
router.delete('/:id', wrap(async (req, res) => {
  const row = A.ownTender(req, req.params.id);
  const db = getDB();
  // نجمع مشغّلات التخزين قبل الحذف — CASCADE يحذف صفوف الملفات فور حذف العطاء
  const drivers = new Set(
    db.prepare('SELECT DISTINCT storage_driver AS d FROM files WHERE tender_id = ?').all(row.id)
      .map((r) => r.d || 'local')
  );
  if (!drivers.size) drivers.add('local');

  // الملفات والطلبات تُحذف بالـ CASCADE، ونحذف الكائنات من التخزين صراحةً
  db.prepare('DELETE FROM tenders WHERE id = ?').run(row.id);

  // حذف من التخزين: بادئة العطاء كاملة عبر كل مشغّل يحمل ملفاته فعلاً
  const prefix = S.buildKey(req.user.id, row.id, '');
  for (const d of drivers) {
    try {
      const drv = d === 's3' ? require('../lib/storage/s3') : require('../lib/storage/local');
      await drv.deletePrefix(prefix);
    } catch (err) {
      console.warn('[tenders] تعذّر حذف بادئة التخزين:', prefix, err.message);
    }
  }

  res.json({ ok: true, message: 'تم حذف العطاء وكل ملفاته.' });
}));

/* ---------------- نظرة عامة للاستهلاك ---------------- */
router.get('/meta/usage', wrap(async (req, res) => {
  res.json(A.planAndUsage(req.user.id));
}));

module.exports = { router, shape, fileStats };