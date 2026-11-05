'use strict';
/**
 * دورة العطاء الإلكتروني: بوابة المشتريات + بوابة المقاول.
 * المالي لا يعاد من API التقييم إلا بعد اجتياز الحد الفني.
 */
const express = require('express');
const multer = require('multer');
const config = require('../config');
const S = require('../lib/storage');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const O = require('../lib/org');
const { AppError } = require('../lib/errors');
const { audit } = require('../lib/audit');

const router = express.Router();
router.use(A.requireAuth);
const buyer = A.requireRole('buyer', 'admin');
/* إجراءات المشتريات: دور «مشتريات» أو «مدير الجهة» فقط (يُنشأ للجهة مديرها تلقائياً عند أول استخدام) */
const procOnly = [buyer, (req, res, next) => {
  if (req.user.role === 'admin') return next();
  const m = O.ensureOrg(req.user);
  if (!m || !['manager', 'procurement'].includes(m.role)) return next(E.forbidden('هذه الإجراءات لدور المشتريات أو مدير الجهة.'));
  return next();
}];
const contractor = A.requireRole('contractor', 'admin');
const addendumUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_BYTES, files: 5 },
  fileFilter: (req, file, cb) => {
    try { S.assertAllowed(file.originalname, 0); cb(null, true); }
    catch (err) { cb(err); }
  }
});

function cleanRequirement(r, i) {
  return {
    id: r.id || uid('req_'),
    title: String(r.title || '').trim().slice(0, 240),
    description: String(r.description || '').trim().slice(0, 2000),
    titleEn: String(r.titleEn || '').trim().slice(0, 240),
    descriptionEn: String(r.descriptionEn || '').trim().slice(0, 2000),
    weight: Math.max(0, Number(r.weight) || 0),
    mandatory: r.mandatory ? 1 : 0,
    sortOrder: i
  };
}

/** نهاية يوم الإغلاق بتوقيت الأردن (UTC+3 ثابت). الصيغة المقبولة YYYY-MM-DD أو YYYY-MM-DDTHH:mm */
function deadlineOf(closing, country) {
  const s = String(closing || '').trim();
  if (!s) return null;
  const tz = O.tzOf(country);
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(s + 'T23:59:59' + tz)
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s) ? Date.parse(s + tz) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
const isExpired = (closing, country) => { const d = deadlineOf(closing, country); return d !== null && Date.now() > d; };

function tenderShape(t, requirements) {
  return {
    id: t.id, name: t.name, nameEn: t.name_en || null, reference: t.reference, authority: t.authority,
    closing: t.closing, expired: isExpired(t.closing, t.country), country: t.country || 'JO', currency: (O.COUNTRIES[t.country] || O.COUNTRIES.JO).currency, notes: t.notes, notesEn: t.notes_en || null, status: t.procurement_status,
    technicalWeight: t.technical_weight, financialWeight: t.financial_weight,
    technicalThreshold: t.technical_threshold, requirements: requirements || []
  };
}

function getTender(id) {
  const db = getDB();
  const t = db.prepare('SELECT * FROM tenders WHERE id = ?').get(id);
  if (!t) throw E.notFound('العطاء غير موجود.');
  const reqs = db.prepare('SELECT * FROM tender_requirements WHERE tender_id = ? ORDER BY sort_order').all(id)
    .map((r) => ({ id: r.id, title: r.title, titleEn: r.title_en || null, description: r.description, descriptionEn: r.description_en || null, weight: r.weight, mandatory: !!r.mandatory, sortOrder: r.sort_order }));
  return { db, t, reqs };
}

function ensureBuyerOwn(req, id) {
  const x = getTender(id);
  if (req.user.role !== 'admin' && !O.canManageUserTenders(req.user, x.t.user_id)) throw E.notFound('العطاء غير موجود.');
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

function fidicOf(t) {
  if (!t.request_id) return null;
  const r = getDB().prepare('SELECT fidic_book, fidic_edition, particular_notes FROM project_requests WHERE id = ?').get(t.request_id);
  if (!r || !r.fidic_book) return null;
  const bk = O.FIDIC_BOOKS[r.fidic_book] || {};
  return { book: r.fidic_book, bookAr: bk.ar || r.fidic_book, bookEn: bk.en || r.fidic_book, edition: r.fidic_edition, notes: r.particular_notes || null, url: O.FIDIC_URL };
}
function publicDocs(t) {
  if (!t.request_id) return [];
  return getDB().prepare('SELECT id, kind, original_name name, mime, size FROM request_docs WHERE request_id = ? AND kind IN (' + O.PUBLIC_DOC_KINDS.map(() => '?').join(',') + ') ORDER BY uploaded_at').all(t.request_id, ...O.PUBLIC_DOC_KINDS);
}
const withIssuer = (t, reqs) => ({ ...tenderShape(t, reqs), issuer: O.issuerOf(t.user_id), fidic: fidicOf(t), documentsCount: publicDocs(t).length });


/* Public clarifications for published MMC tenders. Contractor identities stay private to other bidders. */
router.get('/tenders/:id/clarifications', wrap(async (req,res) => {
  const x=getTender(req.params.id), isBuyer=['buyer','admin'].includes(req.user.role);
  if(isBuyer) ensureBuyerOwn(req,req.params.id);
  else if(req.user.role!=='contractor'||x.t.procurement_status!=='published'||!O.ownerVerified(x.t.user_id)) throw E.notFound('العطاء غير متاح.');
  const rows=x.db.prepare('SELECT r.id,r.user_id,r.text,r.status,r.created_at,u.name questioner FROM requests r JOIN users u ON u.id=r.user_id WHERE r.tender_id=? AND r.kind=? ORDER BY r.created_at,r.id').all(x.t.id,'question');
  const answers=x.db.prepare('SELECT a.request_id,a.text,a.created_at,u.name answerer FROM request_answers a JOIN users u ON u.id=a.user_id JOIN requests r ON r.id=a.request_id WHERE r.tender_id=? AND r.kind=? ORDER BY a.created_at,a.id').all(x.t.id,'question');
  const byQuestion=new Map();
  for(const a of answers){if(!byQuestion.has(a.request_id))byQuestion.set(a.request_id,[]);byQuestion.get(a.request_id).push({text:a.text,createdAt:a.created_at,answerer:isBuyer?a.answerer:'جهة الطرح'});}
  res.json({clarifications:rows.map(r=>({id:r.id,question:r.text,status:r.status,createdAt:r.created_at,isMine:!isBuyer&&r.user_id===req.user.id,questioner:isBuyer?r.questioner:null,answers:byQuestion.get(r.id)||[]}))});
}));

router.post('/tenders/:id/clarifications', contractor, wrap(async(req,res)=>{
  const x=getTender(req.params.id), question=String(req.body?.question||req.body?.text||'').trim().slice(0,3000);
  if(x.t.procurement_status!=='published')throw E.conflict('العطاء غير منشور حالياً.');
  if(!O.ownerVerified(x.t.user_id))throw E.conflict('جهة العطاء غير موثقة حالياً.');
  if(isExpired(x.t.closing,x.t.country))throw E.conflict('انتهى موعد استلام الاستفسارات لهذا العطاء.');
  if(question.length<5)throw E.validation('اكتب استفساراً واضحاً لا يقل عن 5 أحرف.');
  const id=uid('qst_');
  x.db.prepare("INSERT INTO requests (id,tender_id,user_id,kind,text,status) VALUES (?,?,?,'question',?,'open')").run(id,x.t.id,req.user.id,question);
  audit({action:'tender_clarification_asked',entity:'tender',entityId:x.t.id,userId:req.user.id,ip:req.ip,detail:{clarificationId:id}});
  res.status(201).json({clarification:{id,question,status:'open',createdAt:Math.floor(Date.now()/1000),isMine:true,answers:[]}});
}));

router.post('/clarifications/:id/answer', procOnly, wrap(async(req,res)=>{
  const db=getDB(), answer=String(req.body?.answer||req.body?.text||'').trim().slice(0,4000);
  if(answer.length<2)throw E.validation('اكتب إجابة واضحة للاستفسار.');
  const row=db.prepare("SELECT r.*,t.user_id buyer_id,t.procurement_status,t.id tender_id FROM requests r JOIN tenders t ON t.id=r.tender_id WHERE r.id=? AND r.kind='question'").get(req.params.id);
  if(!row||(req.user.role!=='admin'&&!O.canManageUserTenders(req.user,row.buyer_id)))throw E.notFound('الاستفسار غير موجود.');
  if(row.status==='closed')throw E.conflict('تمت الإجابة عن هذا الاستفسار مسبقاً.');
  const id=uid('ans_');
  db.transaction(()=>{
    db.prepare('INSERT INTO request_answers (id,request_id,user_id,text) VALUES (?,?,?,?)').run(id,row.id,req.user.id,answer);
    db.prepare("UPDATE requests SET status='closed' WHERE id=?").run(row.id);
  })();
  audit({action:'tender_clarification_answered',entity:'tender',entityId:row.tender_id,userId:req.user.id,ip:req.ip,detail:{clarificationId:row.id,answerId:id}});
  res.status(201).json({answer:{id,text:answer,createdAt:Math.floor(Date.now()/1000)},status:'closed'});
}));


/* Tender addenda: text and files are attached to one tender/addendum, not orphaned request documents. */
router.get('/tenders/:id/addenda', wrap(async(req,res)=>{
 const x=getTender(req.params.id),isBuyer=['buyer','admin'].includes(req.user.role);
 if(isBuyer)ensureBuyerOwn(req,req.params.id);
 else if(req.user.role!=='contractor'||x.t.procurement_status!=='published'||!O.ownerVerified(x.t.user_id))throw E.notFound('العطاء غير متاح.');
 const rows=x.db.prepare('SELECT id,title,body,created_at FROM tender_addenda WHERE tender_id=? ORDER BY created_at,id').all(x.t.id);
 const docs=x.db.prepare('SELECT id,addendum_id,original_name name,mime,size FROM tender_addendum_documents WHERE addendum_id IN (SELECT id FROM tender_addenda WHERE tender_id=?) ORDER BY uploaded_at,id').all(x.t.id);
 const byId=new Map();
 for(const d of docs){if(!byId.has(d.addendum_id))byId.set(d.addendum_id,[]);byId.get(d.addendum_id).push({id:d.id,name:d.name,mime:d.mime,size:d.size});}
 res.json({addenda:rows.map(r=>({...r,createdAt:r.created_at,documents:byId.get(r.id)||[]}))});
}));
router.post('/tenders/:id/addenda',procOnly,addendumUpload.array('files',5),wrap(async(req,res)=>{
 const x=ensureBuyerOwn(req,req.params.id);
 if(x.t.procurement_status!=='published')throw E.conflict('لا يمكن إصدار ملحق قبل نشر العطاء.');
 const title=String(req.body?.title||'').trim().slice(0,200),body=String(req.body?.body||'').trim().slice(0,5000);
 const files=req.files||[];
 if(title.length<3||(!body||body.length<5)&&!files.length)throw E.validation('أدخل عنوان الملحق ونصاً واضحاً أو أرفق ملفاً واحداً على الأقل.');
 const id=uid('add_'),db=x.db,store=S.getStorage(),saved=[];
 try{
  for(const f of files){
   const key=`tender-addenda/${x.t.id}/${id}/${S.makeStoredName(f.originalname)}`;
   const put=await store.put(key,f.buffer,{mime:f.mimetype,originalName:S.displayName(f.originalname)});
   saved.push({id:uid('adddoc_'),key,driver:store.DRIVER,name:S.displayName(f.originalname),mime:f.mimetype,size:f.size,checksum:put.checksum});
  }
  db.transaction(()=>{
   db.prepare('INSERT INTO tender_addenda (id,tender_id,user_id,title,body) VALUES (?,?,?,?,?)').run(id,x.t.id,req.user.id,title,body||'مرفق وثيقة ملحق العطاء.');
   const ins=db.prepare('INSERT INTO tender_addendum_documents (id,addendum_id,storage_key,storage_driver,original_name,mime,size,checksum,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)');
   for(const d of saved)ins.run(d.id,id,d.key,d.driver,d.name,d.mime,d.size,d.checksum,req.user.id);
  })();
 }catch(err){
  for(const d of saved){try{await store.delete(d.key);}catch(_){}}
  throw err;
 }
 audit({action:'tender_addendum_issued',entity:'tender',entityId:x.t.id,userId:req.user.id,ip:req.ip,detail:{addendumId:id,title,documents:saved.length}});
 res.status(201).json({addendum:{id,title,body:body||'مرفق وثيقة ملحق العطاء.',createdAt:Math.floor(Date.now()/1000),documents:saved.map(d=>({id:d.id,name:d.name,mime:d.mime,size:d.size}))}});
}));
router.get('/tenders/:id/addenda/:addendumId/documents/:docId',wrap(async(req,res)=>{
 const x=getTender(req.params.id);
 if(!docsAccess(req,x.t))throw E.notFound('العطاء غير متاح.');
 const d=x.db.prepare('SELECT * FROM tender_addendum_documents WHERE id=? AND addendum_id=? AND addendum_id IN (SELECT id FROM tender_addenda WHERE tender_id=?)').get(req.params.docId,req.params.addendumId,x.t.id);
 if(!d)throw E.notFound('وثيقة الملحق غير موجودة.');
 const store=d.storage_driver==='s3'?require('../lib/storage/s3'):require('../lib/storage/local');
 if(!(await store.exists(d.storage_key)))throw E.notFound('ملف الوثيقة غير موجود في التخزين.');
 res.setHeader('Content-Type',d.mime||'application/octet-stream');
 res.setHeader('Content-Disposition', "attachment; filename*=UTF-8\'\'" + encodeURIComponent(d.original_name));
 res.setHeader('Cache-Control','private, no-store');
 store.stream(d.storage_key).pipe(res);
}));

/* قائمة العطاءات المنشورة للمقاول */
router.get('/open-tenders', contractor, wrap(async (req, res) => {
  const db = getDB();
  const rows = db.prepare("SELECT * FROM tenders WHERE procurement_status = 'published' ORDER BY closing ASC, created_at DESC").all().filter((t) => O.ownerVerified(t.user_id));
  const submitted = new Set(db.prepare('SELECT tender_id FROM bid_submissions WHERE contractor_id = ?').all(req.user.id).map((r) => r.tender_id));
  res.json({ tenders: rows.map((t) => ({ ...withIssuer(t), alreadySubmitted: submitted.has(t.id) })) });
}));

/* إنشاء العطاء ومعايير التقييم من قبل المشتريات */
/** إنشاء ونشر عطاء. يُستدعى من مسار المشتريات ومن تسليم الطلبات (opts.requestId) */
function createTender(user, b, opts = {}) {
  const requirements = (Array.isArray(b.requirements) ? b.requirements : []).map(cleanRequirement).filter((r) => r.title);
  validateWeights(requirements);
  const technicalWeight = Number(b.technicalWeight ?? 60);
  const financialWeight = Number(b.financialWeight ?? 40);
  const threshold = Number(b.technicalThreshold ?? 50);
  if (technicalWeight + financialWeight !== 100 || threshold <= 0 || threshold > technicalWeight) {
    throw E.validation('يجب أن يكون مجموع الأوزان 100، وأن يكون الحد الفني بين 1 والوزن الفني.');
  }
  const db = getDB();
  if (!O.canPublish(user)) {
    throw new AppError(403, 'ORG_NOT_VERIFIED', 'لا يمكنك نشر عطاءات قبل توثيق جهتك. قدّم طلب التوثيق من أعلى هذه الصفحة وانتظر اعتماد الإدارة.');
  }
  const orgRow = O.getVerification(user.id);
  const tenderCountry = orgRow && O.COUNTRIES[orgRow.country] ? orgRow.country : 'JO';
  const member = user.role === 'buyer' ? O.ensureOrg(user) : null;
  if (user.role !== 'admin') {
    const { plan } = A.planAndUsage(O.billingUserId(user));
    if (plan.maxTenders !== null) {
      const since = Math.floor(Date.now() / 1000) - 365 * 86400;
      const ids = member ? O.orgMemberIds(member.org_id) : [user.id];
      const used = db.prepare('SELECT COUNT(*) AS n FROM tenders WHERE user_id IN (' + ids.map(() => '?').join(',') + ') AND created_at >= ?').get(...ids, since).n;
      if (used >= plan.maxTenders) {
        throw E.forbidden('بلغت حد باقتك (' + plan.maxTenders + ' عطاءات سنوياً). رقِّ الباقة من صفحة الاشتراك لنشر المزيد.');
      }
    }
  }
  const id = uid('tnd_');
  db.transaction(() => {
    db.prepare(`INSERT INTO tenders
      (id,user_id,name,authority,closing,notes,status,reference,technical_weight,financial_weight,technical_threshold,procurement_status,country,name_en,notes_en,org_id,request_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'published',?,?,?,?,?)`)
      .run(id, user.id, String(b.name || '').trim().slice(0, 200), b.authority || null, b.closing || null,
        b.notes || null, 'new', String(b.reference || id).trim().slice(0, 80), technicalWeight, financialWeight, threshold, tenderCountry,
        String(b.nameEn || '').trim().slice(0, 200) || null, String(b.notesEn || '').trim().slice(0, 2000) || null,
        member ? member.org_id : null, opts.requestId || null);
    const ins = db.prepare('INSERT INTO tender_requirements (id,tender_id,title,description,weight,mandatory,sort_order,title_en,description_en) VALUES (?,?,?,?,?,?,?,?,?)');
    requirements.forEach((r, i) => ins.run(r.id, id, r.title, r.description || null, r.weight, r.mandatory, i, r.titleEn || null, r.descriptionEn || null));
  })();
  return id;
}

router.post('/tenders', procOnly, wrap(async (req, res) => {
  const id = createTender(req.user, req.body || {});
  const out = getTender(id);
  res.status(201).json({ tender: tenderShape(out.t, out.reqs), message: 'تم نشر العطاء ومعايير التقييم.' });
}));

router.get('/tenders', procOnly, wrap(async (req, res) => {
  const db = getDB();
  const m = req.user.role === 'buyer' ? O.ensureOrg(req.user) : null;
  const ids = m ? O.orgMemberIds(m.org_id) : [req.user.id];
  const rows = req.user.role === 'admin' ? db.prepare('SELECT * FROM tenders ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM tenders WHERE user_id IN (' + ids.map(() => '?').join(',') + ') ORDER BY created_at DESC').all(...ids);
  res.json({ tenders: rows.map((t) => tenderShape(t)), count: rows.length });
}));

router.get('/tenders/:id', wrap(async (req, res) => {
  const x = getTender(req.params.id);
  const isBuyer = req.user.role === 'buyer' || req.user.role === 'admin';
  if (isBuyer) ensureBuyerOwn(req, req.params.id);
  if (!isBuyer && x.t.procurement_status !== 'published') throw E.notFound('العطاء غير متاح.');
  res.json({ tender: isBuyer ? tenderShape(x.t, x.reqs) : withIssuer(x.t, x.reqs) });
}));

/* تقديم فني ومالي؛ المالي يخزن في القاعدة لكنه لا يخرج للمقيم قبل الفتح */
router.post('/tenders/:id/submit', contractor, wrap(async (req, res) => {
  const x = getTender(req.params.id);
  if (x.t.procurement_status !== 'published') throw E.conflict('العطاء غير منشور أو مغلق.');
  if (!O.ownerVerified(x.t.user_id)) throw E.conflict('جهة هذا العطاء غير موثّقة حالياً، فلا تُقبل عروض جديدة عليه.');
  if (isExpired(x.t.closing, x.t.country)) throw E.conflict('انتهى موعد استلام العروض لهذا العطاء (' + x.t.closing + ').');
  if (req.user.role !== 'admin') {
    const { plan, usage } = A.planAndUsage(req.user.id);
    if (plan.maxSubmissions !== null && usage.submissions >= plan.maxSubmissions) {
      throw E.forbidden('بلغت حد باقتك من التقديمات الإلكترونية (' + plan.maxSubmissions + ' خلال 365 يوماً). رقِّ باقتك من صفحة الاشتراك للمتابعة.');
    }
  }
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
      O.BID_CURRENCIES.includes(String(b.financialCurrency || '').toUpperCase()) ? String(b.financialCurrency).toUpperCase() : (O.COUNTRIES[x.t.country] || O.COUNTRIES.JO).currency);
    const ins = db.prepare('INSERT INTO bid_responses (id,submission_id,requirement_id,answer,score) VALUES (?,?,?,?,?)');
    calc.details.forEach((d) => ins.run(uid('rsp_'), id, d.requirementId, d.answer, d.score));
  });
  tx();
  res.status(201).json({ submissionId: id, technicalPoints: calc.points, message: 'تم استلام العرض الفني والمالي، والمالي محفوظ ومقفل أمام لجنة التقييم.' });
}));

/* التقييم/الفتح والترتيب */
router.get('/tenders/:id/evaluations', procOnly, wrap(async (req, res) => {
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
      responses: db.prepare(`SELECT r.requirement_id requirementId, q.title, q.title_en titleEn, r.answer, r.score, r.evaluator_note evaluatorNote
        FROM bid_responses r JOIN tender_requirements q ON q.id=r.requirement_id WHERE r.submission_id=? ORDER BY q.sort_order`).all(r.id) };
  });
  out.sort((a,b) => (b.totalScore ?? -1) - (a.totalScore ?? -1));
  res.json({ tender:tenderShape(x.t,x.reqs), submissions:out, lowestEligiblePrice:lowest });
}));

router.post('/submissions/:id/evaluate', procOnly, wrap(async (req, res) => {
  const db = getDB();
  const s = db.prepare('SELECT s.*, t.user_id buyer_id, t.technical_weight, t.financial_weight, t.technical_threshold FROM bid_submissions s JOIN tenders t ON t.id=s.tender_id WHERE s.id=?').get(req.params.id);
  if (!s || (req.user.role !== 'admin' && !O.canManageUserTenders(req.user, s.buyer_id))) throw E.notFound('التقديم غير موجود.');
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

/* وثائق العطاء (المخططات والمواصفات والشروط) — للمقاول بعد النشر ولأعضاء الجهة */
function docsAccess(req, t) {
  const staff = req.user.role === 'admin' || (req.user.role === 'buyer' && O.canManageUserTenders(req.user, t.user_id));
  if (staff) return true;
  return req.user.role === 'contractor' && t.procurement_status === 'published' && O.ownerVerified(t.user_id);
}
router.get('/tenders/:id/documents', wrap(async (req, res) => {
  const x = getTender(req.params.id);
  if (!docsAccess(req, x.t)) throw E.notFound('العطاء غير متاح.');
  res.json({ documents: publicDocs(x.t).map((d) => ({ id: d.id, kind: d.kind, name: d.name, mime: d.mime, size: d.size })), fidic: fidicOf(x.t) });
}));
router.get('/tenders/:id/documents/:docId', wrap(async (req, res) => {
  const x = getTender(req.params.id);
  if (!docsAccess(req, x.t)) throw E.notFound('العطاء غير متاح.');
  const d = getDB().prepare('SELECT * FROM request_docs WHERE id = ? AND request_id = ?').get(req.params.docId, x.t.request_id || '');
  if (!d || !O.PUBLIC_DOC_KINDS.includes(d.kind)) throw E.notFound('الوثيقة غير موجودة.');
  const store = d.storage_driver === 's3' ? require('../lib/storage/s3') : require('../lib/storage/local');
  if (!(await store.exists(d.storage_key))) throw E.notFound('ملف الوثيقة غير موجود في التخزين.');
  res.setHeader('Content-Type', d.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(d.original_name));
  res.setHeader('Cache-Control', 'private, no-store');
  store.stream(d.storage_key).pipe(res);
}));

router.createTender = createTender;
module.exports = router;
