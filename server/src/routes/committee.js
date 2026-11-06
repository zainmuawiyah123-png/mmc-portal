'use strict';
/**
 * لجنة تقييم العروض الفنية.
 * - المقيّمون (مكتب استشاري أو أعضاء من الجهة) يمنحون درجات مستقلة لكل بند وكل عارض.
 * - يرى المقيّم العروض بأسماء مجهولة (عارض A/B/..) ودون أي أرقام مالية.
 * - لا يرى المقيّم درجات زملائه؛ صاحب العطاء وحده يرى المصفوفة وفروق التقدير.
 * - الاعتماد يحسب متوسط درجات اللجنة ويكتب النتيجة الفنية بالمعادلة نفسها المستخدمة في التقييم الفردي،
 *   ثم يبقى فتح العرض المالي إجراءً منفصلاً كما كان.
 */
const express = require('express');
const { getDB } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const O = require('../lib/org');
const C = require('../lib/committee');
const Mail = require('../lib/mailer');
const { audit } = require('../lib/audit');

const router = express.Router();
router.use(A.requireAuth);
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const SPREAD_FLAG = 30; // فرق بين أعلى وأدنى درجة لنفس البند يستحق مراجعة اللجنة

function ownerTender(req, id) {
  const t = getDB().prepare('SELECT * FROM tenders WHERE id=?').get(id);
  const ok = t && (req.user.role === 'admin' || (req.user.role === 'buyer' && O.canManageUserTenders(req.user, t.user_id)));
  if (!ok || !['published', 'closed'].includes(t.procurement_status)) throw E.notFound('العطاء غير موجود.');
  return t;
}
function evaluatorTender(req, id) {
  const t = getDB().prepare('SELECT * FROM tenders WHERE id=?').get(id);
  if (!t || !C.isEvaluator(req.user.id, id)) throw E.notFound('العطاء غير موجود ضمن تكليفاتك.');
  return t;
}
const reqsOf = (id) => getDB().prepare('SELECT * FROM tender_requirements WHERE tender_id=? ORDER BY sort_order').all(id);
const subsOf = (id) => getDB().prepare("SELECT s.*, u.name contractor_name, u.company contractor_company FROM bid_submissions s JOIN users u ON u.id=s.contractor_id WHERE s.tender_id=? AND s.status IN ('submitted','evaluated') ORDER BY s.submitted_at, s.id").all(id);
const normalized = (reqs, scoreOf) => reqs.reduce((a, r) => a + r.weight * (scoreOf(r) || 0) / 100, 0);

/* ───────── المقيّم ───────── */
router.get('/my-assignments', wrap(async (req, res) => {
  const db = getDB();
  const rows = db.prepare(`SELECT e.tender_id, e.member_role, t.name, t.reference, t.authority, t.closing, t.procurement_status
    FROM tender_evaluators e JOIN tenders t ON t.id=e.tender_id WHERE e.user_id=? ORDER BY e.created_at DESC`).all(req.user.id);
  res.json({ assignments: rows.map((r) => {
    const total = reqsOf(r.tender_id).length * subsOf(r.tender_id).length;
    const done = db.prepare(`SELECT COUNT(*) n FROM evaluator_scores sc JOIN bid_submissions s ON s.id=sc.submission_id WHERE s.tender_id=? AND sc.evaluator_id=?`).get(r.tender_id, req.user.id).n;
    return { tenderId: r.tender_id, name: r.name, reference: r.reference, authority: r.authority, closing: r.closing, memberRole: r.member_role,
      progress: { done, total }, finalized: C.isFinalized(r.tender_id) };
  }) });
}));

router.get('/tenders/:id/work', wrap(async (req, res) => {
  const t = evaluatorTender(req, req.params.id), db = getDB();
  const reqs = reqsOf(t.id), subs = subsOf(t.id);
  const mine = new Map(db.prepare(`SELECT sc.* FROM evaluator_scores sc JOIN bid_submissions s ON s.id=sc.submission_id WHERE s.tender_id=? AND sc.evaluator_id=?`).all(t.id, req.user.id).map((r) => [r.submission_id + '|' + r.requirement_id, r]));
  res.json({
    tender: { id: t.id, name: t.name, reference: t.reference, authority: t.authority, technicalThreshold: t.technical_threshold, finalized: C.isFinalized(t.id) },
    requirements: reqs.map((r) => ({ id: r.id, title: r.title, titleEn: r.title_en || null, description: r.description, weight: r.weight, mandatory: !!r.mandatory })),
    bidders: subs.map((s, i) => ({
      submissionId: s.id, label: C.bidderLabel(i),
      documents: db.prepare("SELECT id, original_name, size FROM bid_submission_docs WHERE submission_id=? AND doc_class='technical' ORDER BY uploaded_at").all(s.id).map((d) => ({ id: d.id, name: d.original_name, size: d.size })),
      responses: reqs.map((r) => {
        const a = db.prepare('SELECT answer FROM bid_responses WHERE submission_id=? AND requirement_id=?').get(s.id, r.id);
        const m = mine.get(s.id + '|' + r.id);
        return { requirementId: r.id, answer: a ? a.answer : '', myScore: m ? m.score : null, myNote: m ? m.note : null };
      })
    }))
  });
}));

router.post('/tenders/:id/scores', wrap(async (req, res) => {
  const t = evaluatorTender(req, req.params.id), db = getDB();
  if (C.isFinalized(t.id)) throw E.conflict('اعتُمدت نتيجة اللجنة ولا يمكن تعديل الدرجات.');
  const list = Array.isArray(req.body?.scores) ? req.body.scores.slice(0, 2000) : [];
  if (!list.length) throw E.validation('لا توجد درجات.');
  const okSub = new Set(subsOf(t.id).map((s) => s.id)), okReq = new Set(reqsOf(t.id).map((r) => r.id));
  const up = db.prepare(`INSERT INTO evaluator_scores (submission_id,requirement_id,evaluator_id,score,note) VALUES (?,?,?,?,?)
    ON CONFLICT(submission_id,requirement_id,evaluator_id) DO UPDATE SET score=excluded.score, note=excluded.note, updated_at=unixepoch()`);
  db.transaction(() => {
    for (const x of list) {
      const score = Number(x.score);
      if (!okSub.has(x.submissionId) || !okReq.has(x.requirementId) || !Number.isFinite(score) || score < 0 || score > 100) throw E.validation('درجة أو بند أو عارض غير صالح (الدرجة من 0 إلى 100).');
      up.run(x.submissionId, x.requirementId, req.user.id, score, clip(x.note, 1000) || null);
    }
  })();
  audit({ action: 'committee_scores_saved', entity: 'tender', entityId: t.id, userId: req.user.id, ip: req.ip, detail: { count: list.length } });
  res.json({ ok: true, saved: list.length });
}));

/* ───────── صاحب العطاء ───────── */
function members(tenderId) {
  const db = getDB(), total = reqsOf(tenderId).length * subsOf(tenderId).length;
  return db.prepare(`SELECT e.user_id, e.member_role, u.name, u.company, u.email, u.role FROM tender_evaluators e JOIN users u ON u.id=e.user_id WHERE e.tender_id=? ORDER BY e.created_at`).all(tenderId).map((m) => ({
    userId: m.user_id, name: m.name, company: m.company, email: m.email, memberRole: m.member_role,
    scored: db.prepare('SELECT COUNT(*) n FROM evaluator_scores sc JOIN bid_submissions s ON s.id=sc.submission_id WHERE s.tender_id=? AND sc.evaluator_id=?').get(tenderId, m.user_id).n, total
  }));
}

router.get('/tenders/:id', wrap(async (req, res) => {
  const t = ownerTender(req, req.params.id), db = getDB();
  const reqs = reqsOf(t.id), subs = subsOf(t.id), mem = members(t.id);
  const all = db.prepare('SELECT sc.* FROM evaluator_scores sc JOIN bid_submissions s ON s.id=sc.submission_id WHERE s.tender_id=?').all(t.id);
  const by = new Map(all.map((r) => [r.submission_id + '|' + r.requirement_id + '|' + r.evaluator_id, r.score]));
  const bidders = subs.map((s, i) => {
    const perEvaluator = mem.map((m) => ({ userId: m.userId, normalized: normalized(reqs, (r) => by.get(s.id + '|' + r.id + '|' + m.userId)) }));
    const flags = reqs.filter((r) => {
      const v = mem.map((m) => by.get(s.id + '|' + r.id + '|' + m.userId)).filter((x) => x !== undefined);
      return v.length >= 2 && Math.max(...v) - Math.min(...v) >= SPREAD_FLAG;
    }).map((r) => ({ requirementId: r.id, title: r.title }));
    const avg = perEvaluator.length ? perEvaluator.reduce((a, x) => a + x.normalized, 0) / perEvaluator.length : null;
    return { submissionId: s.id, label: C.bidderLabel(i), contractorName: s.contractor_name, company: s.contractor_company, perEvaluator, committeeAverage: avg, divergentRequirements: flags };
  });
  res.json({ tender: { id: t.id, name: t.name, technicalWeight: t.technical_weight, technicalThreshold: t.technical_threshold }, finalized: C.isFinalized(t.id), members: mem, bidders, requirementCount: reqs.length, spreadFlag: SPREAD_FLAG });
}));

router.post('/tenders/:id/members', wrap(async (req, res) => {
  const t = ownerTender(req, req.params.id), db = getDB();
  if (C.isFinalized(t.id)) throw E.conflict('اعتُمدت نتيجة اللجنة.');
  const email = clip(req.body?.email, 254).toLowerCase();
  const u = db.prepare('SELECT id,name,role,email FROM users WHERE lower(email)=?').get(email);
  if (!u) throw E.notFound('لا يوجد حساب بهذا البريد. اطلب من المقيّم التسجيل أولاً (مكتب استشاري)، ثم أضفه.');
  if (!['consultant', 'buyer'].includes(u.role)) throw E.validation('يمكن إضافة حسابات الاستشاريين أو الجهات المشترية فقط.');
  if (db.prepare('SELECT 1 FROM bid_submissions WHERE tender_id=? AND contractor_id=?').get(t.id, u.id)) throw E.conflict('هذا الحساب مقدّم عرضاً على العطاء نفسه.');
  const role = ['chair', 'member', 'consultant'].includes(req.body?.memberRole) ? req.body.memberRole : (u.role === 'consultant' ? 'consultant' : 'member');
  const r = db.prepare('INSERT OR IGNORE INTO tender_evaluators (tender_id,user_id,member_role,invited_by) VALUES (?,?,?,?)').run(t.id, u.id, role, req.user.id);
  if (!r.changes) throw E.conflict('العضو مضاف مسبقاً.');
  audit({ action: 'committee_member_added', entity: 'tender', entityId: t.id, userId: req.user.id, ip: req.ip, detail: { memberId: u.id, role } });
  Mail.notify(u.email, 'تكليف بتقييم عطاء / Tender evaluation assignment',
    'تم تكليفك بعضوية لجنة تقييم العطاء: ' + t.name + (t.reference ? ' (' + t.reference + ')' : '') + '\nادخل إلى مساحة المقيّم لتقييم العروض الفنية: ' + (Mail.link('/consultant/index.html') || '/consultant/index.html') +
    '\n\nYou were assigned to the evaluation committee of: ' + t.name + '.');
  res.status(201).json({ ok: true, members: members(t.id) });
}));

router.delete('/tenders/:id/members/:userId', wrap(async (req, res) => {
  const t = ownerTender(req, req.params.id);
  if (C.isFinalized(t.id)) throw E.conflict('اعتُمدت نتيجة اللجنة.');
  getDB().transaction(() => {
    getDB().prepare('DELETE FROM evaluator_scores WHERE evaluator_id=? AND submission_id IN (SELECT id FROM bid_submissions WHERE tender_id=?)').run(req.params.userId, t.id);
    getDB().prepare('DELETE FROM tender_evaluators WHERE tender_id=? AND user_id=?').run(t.id, req.params.userId);
  })();
  audit({ action: 'committee_member_removed', entity: 'tender', entityId: t.id, userId: req.user.id, ip: req.ip, detail: { memberId: req.params.userId } });
  res.json({ ok: true, members: members(t.id) });
}));

router.post('/tenders/:id/finalize', wrap(async (req, res) => {
  const t = ownerTender(req, req.params.id), db = getDB();
  if (C.isFinalized(t.id)) throw E.conflict('اعتُمدت النتيجة مسبقاً.');
  if (t.financial_opened_at) throw E.conflict('فُتحت العروض المالية، ولا يجوز إعادة التقييم الفني.');
  const mem = members(t.id), reqs = reqsOf(t.id), subs = subsOf(t.id);
  if (mem.length < 2) throw E.conflict('يلزم عضوان على الأقل في اللجنة قبل الاعتماد.');
  if (!subs.length) throw E.conflict('لا توجد عروض للتقييم.');
  const incomplete = mem.filter((m) => m.scored < m.total);
  if (incomplete.length) throw E.conflict('لم يكمل كل الأعضاء تقييمهم: ' + incomplete.map((m) => m.name).join('، '));
  const rows = db.prepare('SELECT sc.* FROM evaluator_scores sc JOIN bid_submissions s ON s.id=sc.submission_id WHERE s.tender_id=?').all(t.id);
  const memberIds = new Set(mem.map((m) => m.userId));
  const results = [];
  db.transaction(() => {
    for (const s of subs) {
      const avgOf = (r) => { const v = rows.filter((x) => x.submission_id === s.id && x.requirement_id === r.id && memberIds.has(x.evaluator_id)); return v.reduce((a, x) => a + x.score, 0) / v.length; };
      const responses = new Map(db.prepare('SELECT * FROM bid_responses WHERE submission_id=?').all(s.id).map((r) => [r.requirement_id, r]));
      let norm = 0, missing = false;
      for (const r of reqs) {
        const score = avgOf(r), row = responses.get(r.id);
        if (r.mandatory && (!row || !String(row.answer).trim() || score < 50)) missing = true;
        norm += r.weight * score / 100;
        const notes = rows.filter((x) => x.submission_id === s.id && x.requirement_id === r.id && x.note).map((x) => x.note).join(' | ').slice(0, 1000) || null;
        if (row) db.prepare('UPDATE bid_responses SET score=?, evaluator_note=? WHERE id=?').run(score, notes, row.id);
      }
      const points = norm * t.technical_weight / 100, passed = points >= t.technical_threshold && !missing;
      db.prepare(`UPDATE bid_submissions SET technical_score=?,technical_points=?,technical_passed=?,financial_unlocked=0,status='evaluated',evaluated_at=unixepoch(),financial_score=NULL,total_score=NULL WHERE id=?`).run(norm, points, passed ? 1 : 0, s.id);
      results.push({ submissionId: s.id, technicalPoints: points, passed });
    }
    db.prepare('INSERT INTO tender_committee (tender_id,finalized_at,finalized_by) VALUES (?,unixepoch(),?) ON CONFLICT(tender_id) DO UPDATE SET finalized_at=unixepoch(), finalized_by=excluded.finalized_by').run(t.id, req.user.id);
  })();
  audit({ action: 'committee_evaluation_finalized', entity: 'tender', entityId: t.id, userId: req.user.id, ip: req.ip, detail: { members: mem.length, bidders: results.length, qualified: results.filter((r) => r.passed).length } });
  for (const m of mem) Mail.notify(m.email, 'اعتماد نتيجة التقييم الفني / Technical evaluation finalized', 'تم اعتماد نتيجة التقييم الفني للعطاء: ' + t.name + '\nشكراً لمشاركتكم في اللجنة.');
  res.json({ ok: true, results, message: 'اعتُمدت نتيجة اللجنة. فتح العرض المالي ما زال إجراءً منفصلاً.' });
}));

module.exports = router;
