'use strict';
/**
 * دورة العطاء الإلكتروني: بوابة المشتريات + بوابة المقاول.
 * المالي لا يعاد من API التقييم إلا بعد اجتياز الحد الفني.
 */
const express = require('express');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');

const router = express.Router();
router.use(A.requireAuth);
const buyer = A.requireRole('buyer', 'admin');
const contractor = A.requireRole('contractor', 'admin');

function cleanRequirement(r, i) {
  return {
    id: r.id || uid('req_'),
    title: String(r.title || '').trim().slice(0, 240),
    description: String(r.description || '').trim().slice(0, 2000),
    weight: Math.max(0, Number(r.weight) || 0),
    mandatory: r.mandatory ? 1 : 0,
    sortOrder: i
  };
}

function tenderShape(t, requirements) {
  return {
    id: t.id, name: t.name, reference: t.reference, authority: t.authority,
    closing: t.closing, notes: t.notes, status: t.procurement_status,
    technicalWeight: t.technical_weight, financialWeight: t.financial_weight,
    technicalThreshold: t.technical_threshold, requirements: requirements || []
  };
}

function getTender(id) {
  const db = getDB();
  const t = db.prepare('SELECT * FROM tenders WHERE id = ?').get(id);
  if (!t) throw E.notFound('العطاء غير موجود.');
  const reqs = db.prepare('SELECT * FROM tender_requirements WHERE tender_id = ? ORDER BY sort_order').all(id)
    .map((r) => ({ id: r.id, title: r.title, description: r.description, weight: r.weight, mandatory: !!r.mandatory, sortOrder: r.sort_order }));
  return { db, t, reqs };
}

function ensureBuyerOwn(req, id) {
  const x = getTender(id);
  if (req.user.role !== 'admin' && x.t.user_id !== req.user.id) throw E.notFound('العطاء غير موجود.');
  return x;
}

function validateWeights(reqs) {
  const total = reqs.reduce((a, r) => a + r.weight, 0);
  if (!reqs.length || total <= 0 || Math.abs(total - 100) > 0.01) {
    throw E.validation('يجب إدخال متطلبات فنية ومجموع أوزانها يساوي 100%.');
  }
}

function calculateTechnical(reqs, answers, technicalWeight) {
  const map = new Map((answers || []).map((a) => [a.requirementId, a]));
  let normalized = 0;
  let missingMandatory = false;
  const details = reqs.map((r) => {
    const a = map.get(r.id) || {};
    const answer = String(a.answer || '').trim();
    const score = answer ? 100 : 0;
    if (r.mandatory && !answer) missingMandatory = true;
    normalized += r.weight * score / 100;
    return { requirementId: r.id, answer, score };
  });
  const points = normalized * (Number(technicalWeight) / 100);
  return { normalized, points, missingMandatory, details };
}

/* قائمة العطاءات المنشورة للمقاول */
router.get('/open-tenders', contractor, wrap(async (req, res) => {
  const db = getDB();
  const rows = db.prepare("SELECT * FROM tenders WHERE procurement_status = 'published' ORDER BY closing ASC, created_at DESC").all();
  const submitted = new Set(db.prepare('SELECT tender_id FROM bid_submissions WHERE contractor_id = ?').all(req.user.id).map((r) => r.tender_id));
  res.json({ tenders: rows.map((t) => ({ ...tenderShape(t), alreadySubmitted: submitted.has(t.id) })) });
}));

/* إنشاء العطاء ومعايير التقييم من قبل المشتريات */
router.post('/tenders', buyer, wrap(async (req, res) => {
  const b = req.body || {};
  const requirements = (Array.isArray(b.requirements) ? b.requirements : []).map(cleanRequirement).filter((r) => r.title);
  validateWeights(requirements);
  const technicalWeight = Number(b.technicalWeight ?? 60);
  const financialWeight = Number(b.financialWeight ?? 40);
  const threshold = Number(b.technicalThreshold ?? 50);
  if (technicalWeight + financialWeight !== 100 || threshold <= 0 || threshold > technicalWeight) {
    throw E.validation('يجب أن يكون مجموع الأوزان 100، وأن يكون الحد الفني بين 1 والوزن الفني.');
  }
  const db = getDB();
  if (req.user.role !== 'admin') {
    const { plan } = A.planAndUsage(req.user.id);
    if (plan.maxTenders !== null) {
      const since = Math.floor(Date.now() / 1000) - 365 * 86400;
      const used = db.prepare('SELECT COUNT(*) AS n FROM tenders WHERE user_id = ? AND created_at >= ?').get(req.user.id, since).n;
      if (used >= plan.maxTenders) {
        throw E.forbidden('بلغت حد باقتك (' + plan.maxTenders + ' عطاءات سنوياً). رقِّ الباقة من صفحة الاشتراك لنشر المزيد.');
      }
    }
  }
  const id = uid('tnd_');
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO tenders
      (id,user_id,name,authority,closing,notes,status,reference,technical_weight,financial_weight,technical_threshold,procurement_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'published')`)
      .run(id, req.user.id, String(b.name || '').trim().slice(0, 200), b.authority || null, b.closing || null,
        b.notes || null, 'new', String(b.reference || id).trim().slice(0, 80), technicalWeight, financialWeight, threshold);
    const ins = db.prepare('INSERT INTO tender_requirements (id,tender_id,title,description,weight,mandatory,sort_order) VALUES (?,?,?,?,?,?,?)');
    requirements.forEach((r, i) => ins.run(r.id, id, r.title, r.description || null, r.weight, r.mandatory, i));
  });
  tx();
  const out = getTender(id);
  res.status(201).json({ tender: tenderShape(out.t, out.reqs), message: 'تم نشر العطاء ومعايير التقييم.' });
}));

router.get('/tenders', buyer, wrap(async (req, res) => {
  const db = getDB();
  const rows = req.user.role === 'admin' ? db.prepare('SELECT * FROM tenders ORDER BY created_at DESC').all() : db.prepare('SELECT * FROM tenders WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ tenders: rows.map((t) => tenderShape(t)), count: rows.length });
}));

router.get('/tenders/:id', wrap(async (req, res) => {
  const x = getTender(req.params.id);
  const isBuyer = req.user.role === 'buyer' || req.user.role === 'admin';
  if (isBuyer) ensureBuyerOwn(req, req.params.id);
  if (!isBuyer && x.t.procurement_status !== 'published') throw E.notFound('العطاء غير متاح.');
  res.json({ tender: tenderShape(x.t, x.reqs) });
}));

/* تقديم فني ومالي؛ المالي يخزن في القاعدة لكنه لا يخرج للمقيم قبل الفتح */
router.post('/tenders/:id/submit', contractor, wrap(async (req, res) => {
  const x = getTender(req.params.id);
  if (x.t.procurement_status !== 'published') throw E.conflict('العطاء غير منشور أو مغلق.');
  const b = req.body || {};
  const amount = Number(b.financialAmount);
  if (!Number.isFinite(amount) || amount <= 0) throw E.validation('أدخل قيمة مالية صحيحة.');
  if (!Array.isArray(b.answers) || b.answers.length !== x.reqs.length) throw E.validation('يجب الإجابة عن جميع المتطلبات الفنية.');
  if (getDB().prepare('SELECT id FROM bid_submissions WHERE tender_id = ? AND contractor_id = ?').get(x.t.id, req.user.id)) throw E.conflict('سبق تقديم العرض لهذا العطاء.');
  const calc = calculateTechnical(x.reqs, b.answers, x.t.technical_weight);
  const db = getDB();
  const id = uid('sub_');
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO bid_submissions
      (id,tender_id,contractor_id,technical_score,technical_points,technical_passed,financial_amount,financial_currency)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, x.t.id, req.user.id, calc.normalized, calc.points,
      calc.points >= x.t.technical_threshold && !calc.missingMandatory ? 1 : 0, amount,
      String(b.financialCurrency || 'JOD').slice(0, 8).toUpperCase());
    const ins = db.prepare('INSERT INTO bid_responses (id,submission_id,requirement_id,answer,score) VALUES (?,?,?,?,?)');
    calc.details.forEach((d) => ins.run(uid('rsp_'), id, d.requirementId, d.answer, d.score));
  });
  tx();
  res.status(201).json({ submissionId: id, technicalPoints: calc.points, message: 'تم استلام العرض الفني والمالي، والمالي محفوظ ومقفل أمام لجنة التقييم.' });
}));

/* التقييم/الفتح والترتيب */
router.get('/tenders/:id/evaluations', buyer, wrap(async (req, res) => {
  const x = ensureBuyerOwn(req, req.params.id);
  const db = x.db;
  const rows = db.prepare(`SELECT s.*, u.name contractor_name, u.company contractor_company
    FROM bid_submissions s JOIN users u ON u.id=s.contractor_id WHERE s.tender_id=? ORDER BY s.submitted_at`).all(x.t.id);
  const eligible = rows.filter((r) => r.technical_passed && r.financial_unlocked && r.financial_amount > 0);
  const lowest = eligible.length ? Math.min(...eligible.map((r) => r.financial_amount)) : null;
  const out = rows.map((r) => {
    const opened = !!r.financial_unlocked;
    const financialScore = opened && lowest ? (lowest / r.financial_amount) * x.t.financial_weight : null;
    const total = financialScore === null ? null : r.technical_points + financialScore;
    return { id:r.id, contractorName:r.contractor_name, company:r.contractor_company, technicalScore:r.technical_score,
      technicalPoints:r.technical_points, technicalPassed:!!r.technical_passed, financialOpened:opened,
      financialAmount:opened ? r.financial_amount : null, financialCurrency:opened ? r.financial_currency : null,
      financialScore, totalScore:total, submittedAt:r.submitted_at,
      responses: db.prepare(`SELECT r.requirement_id requirementId, q.title, r.answer, r.score, r.evaluator_note evaluatorNote
        FROM bid_responses r JOIN tender_requirements q ON q.id=r.requirement_id WHERE r.submission_id=? ORDER BY q.sort_order`).all(r.id) };
  });
  out.sort((a,b) => (b.totalScore ?? -1) - (a.totalScore ?? -1));
  res.json({ tender:tenderShape(x.t,x.reqs), submissions:out, lowestEligiblePrice:lowest });
}));

router.post('/submissions/:id/evaluate', buyer, wrap(async (req, res) => {
  const db = getDB();
  const s = db.prepare('SELECT s.*, t.user_id buyer_id, t.technical_weight, t.financial_weight, t.technical_threshold FROM bid_submissions s JOIN tenders t ON t.id=s.tender_id WHERE s.id=?').get(req.params.id);
  if (!s || (req.user.role !== 'admin' && s.buyer_id !== req.user.id)) throw E.notFound('التقديم غير موجود.');
  const reqs = db.prepare('SELECT * FROM tender_requirements WHERE tender_id=? ORDER BY sort_order').all(s.tender_id);
  const scores = new Map((Array.isArray(req.body?.scores) ? req.body.scores : []).map((a) => [a.requirementId, Math.max(0, Math.min(100, Number(a.score) || 0))]));
  const responses = db.prepare('SELECT * FROM bid_responses WHERE submission_id=?').all(s.id);
  const scoreMap = new Map(responses.map((r) => [r.requirement_id, r]));
  let normalized=0, missing=false;
  const update = db.prepare('UPDATE bid_responses SET score=?, evaluator_note=? WHERE id=?');
  for (const r of reqs) {
    const row=scoreMap.get(r.id); const score=scores.has(r.id)?scores.get(r.id):(row ? row.score : 0);
    if (r.mandatory && (!row || !String(row.answer).trim() || score < 50)) missing=true;
    normalized += r.weight * score / 100;
    if (row) update.run(score, String((req.body?.notes || {})[r.id] || '').slice(0,1000) || null, row.id);
  }
  const points=normalized*s.technical_weight/100;
  const passed=points>=s.technical_threshold && !missing;
  db.prepare(`UPDATE bid_submissions SET technical_score=?,technical_points=?,technical_passed=?,financial_unlocked=?,status='evaluated',evaluated_at=unixepoch(),financial_score=NULL,total_score=NULL ${passed ? ', financial_unlocked=1' : ''} WHERE id=?`)
    .run(normalized, points, passed?1:0, passed?1:0, s.id);
  if (passed) db.prepare('UPDATE tenders SET financial_opened_at=COALESCE(financial_opened_at,unixepoch()) WHERE id=?').run(s.tender_id);
  res.json({ ok:true, technicalScore:normalized, technicalPoints:points, passed, financialOpened:passed, message:passed?'اجتاز العرض الفني؛ تم فتح المالي آلياً.':'لم يبلغ العرض الحد الفني؛ بقي المالي مقفلاً.' });
}));

module.exports = router;
