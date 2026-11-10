'use strict';
/** Independent consulting-firm identity and verification. Never uses buyer orgs or evaluator assignments. */
const express = require('express');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const { audit } = require('../lib/audit');
const router = express.Router();
router.use(A.requireAuth);
const clip = (v,n) => String(v == null ? '' : v).trim().slice(0,n);
const identity = (country, registration) => country + ':' + registration.toUpperCase().replace(/[^A-Z0-9]/g,'');
function firmFor(userId) {
  return getDB().prepare(`SELECT f.*, m.member_role, m.status member_status FROM consulting_firm_members m JOIN consulting_firms f ON f.id=m.firm_id WHERE m.user_id=?`).get(userId) || null;
}
function requireConsultant(req) { if (req.user.role !== 'consultant') throw E.forbidden('هذه الخدمة مخصصة لحسابات المكاتب الاستشارية.'); }
function requireOwner(req, firm) { if (!firm || firm.member_status !== 'active' || firm.member_role !== 'owner') throw E.notFound('ملف المكتب غير موجود.'); }
function requireFirmManager(req) { const firm=requireVerifiedFirm(req); if(!['owner','manager'].includes(firm.member_role)) throw E.forbidden('تتطلب هذه العملية صلاحية مالك المكتب أو مديره.'); return firm; }

router.get('/me', wrap(async (req,res) => {
  requireConsultant(req);
  let firm=firmFor(req.user.id);
  res.setHeader('Cache-Control','no-store');
  res.json({ firm: firm ? { id:firm.id, legalName:firm.legal_name, country:firm.country, registrationNumber:firm.registration_number, contactEmail:firm.contact_email, contactPhone:firm.contact_phone, specializations:JSON.parse(firm.specializations_json||'[]'), experienceSummary:firm.experience_summary, website:firm.website, verificationStatus:firm.verification_status, verificationNote:firm.verification_note, memberRole:firm.member_role, memberStatus:firm.member_status } : null, subscription: { plan:'free', professionalAvailable:false, professionalPrice:20, currency:'USD', billingCycle:'monthly' } });
}));

router.post('/firms', wrap(async (req,res) => {
  requireConsultant(req);
  const db=getDB();
  if (firmFor(req.user.id)) throw E.conflict('هذا الحساب مرتبط مسبقاً بملف مكتب استشاري.');
  const legalName=clip(req.body?.legalName,180), country=clip(req.body?.country,2).toUpperCase(), registration=clip(req.body?.registrationNumber,80), contactEmail=clip(req.body?.contactEmail,254).toLowerCase(), contactPhone=clip(req.body?.contactPhone,40);
  if(legalName.length<3) throw E.validation('الاسم القانوني للمكتب مطلوب.');
  if(!['JO','SA','AE'].includes(country)) throw E.validation('الدولة غير مدعومة حالياً.');
  if(registration.length<3 || registration.split('').some(ch => !/[A-Za-z0-9 _.-]/.test(ch))) throw E.validation('رقم التسجيل القانوني غير صالح.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw E.validation('البريد الرسمي غير صالح.');
  if(contactPhone.replace(/\D/g,'').length<7) throw E.validation('رقم الهاتف الرسمي غير صالح.');
  const key=identity(country,registration);
  if(key.length<5) throw E.validation('رقم التسجيل القانوني قصير جداً.');
  if(db.prepare('SELECT id FROM consulting_firms WHERE identity_key=?').get(key)) throw E.conflict('يوجد ملف مكتب مسجل بنفس الدولة ورقم التسجيل القانوني.');
  const specs=Array.isArray(req.body?.specializations)?req.body.specializations.map(x=>clip(x,80)).filter(Boolean).slice(0,20):[];
  const id=uid('cf_');
  db.transaction(()=>{
    db.prepare(`INSERT INTO consulting_firms (id,legal_name,country,registration_number,identity_key,contact_email,contact_phone,specializations_json,experience_summary,website,verification_status) VALUES (?,?,?,?,?,?,?,?,?,?,'pending')`).run(id,legalName,country,registration,key,contactEmail,contactPhone,JSON.stringify(specs),clip(req.body?.experienceSummary,3000)||null,clip(req.body?.website,240)||null);
    db.prepare(`INSERT INTO consulting_firm_members (id,firm_id,user_id,member_role,status) VALUES (?,?,?,'owner','active')`).run(uid('cfm_'),id,req.user.id);
    db.prepare(`INSERT INTO consulting_firm_verification_events (id,firm_id,actor_user_id,action,note) VALUES (?,?,?,'submitted','تم تقديم بيانات المكتب للمراجعة')`).run(uid('cfe_'),id,req.user.id);
  })();
  audit({action:'consulting_firm_submitted',entity:'consulting_firm',entityId:id,userId:req.user.id,ip:req.ip,detail:{country,identityKey:key}});
  res.status(201).json({firm:{id,legalName,country,registrationNumber:registration,verificationStatus:'pending'},message:'تم استلام ملف المكتب. لن تتاح خدمات السوق قبل اكتمال التحقق القانوني.'});
}));

router.patch('/firms/me', wrap(async (req,res)=>{
  requireConsultant(req); const db=getDB(), firm=firmFor(req.user.id); requireOwner(req,firm);
  const specs=Array.isArray(req.body?.specializations)?req.body.specializations.map(x=>clip(x,80)).filter(Boolean).slice(0,20):JSON.parse(firm.specializations_json||'[]');
  const email=req.body?.contactEmail===undefined?firm.contact_email:clip(req.body.contactEmail,254).toLowerCase();
  const phone=req.body?.contactPhone===undefined?firm.contact_phone:clip(req.body.contactPhone,40);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||phone.replace(/\D/g,'').length<7) throw E.validation('بيانات التواصل غير صالحة.');
  db.prepare(`UPDATE consulting_firms SET contact_email=?,contact_phone=?,specializations_json=?,experience_summary=?,website=?,updated_at=unixepoch() WHERE id=?`).run(email,phone,JSON.stringify(specs),req.body?.experienceSummary===undefined?firm.experience_summary:clip(req.body.experienceSummary,3000),req.body?.website===undefined?firm.website:clip(req.body.website,240),firm.id);
  res.json({ok:true,message:'تم تحديث الملف التعريفي.'});
}));

router.get('/admin/pending', A.requireRole('admin'), wrap(async(req,res)=>{
  const rows=getDB().prepare(`SELECT id,legal_name,country,registration_number,contact_email,contact_phone,specializations_json,experience_summary,website,verification_status,verification_note,created_at FROM consulting_firms WHERE verification_status='pending' ORDER BY created_at`).all();
  res.json({firms:rows.map(f=>({...f,specializations:JSON.parse(f.specializations_json||'[]'),specializations_json:undefined,documents:getDB().prepare('SELECT id,document_kind,original_name,mime,size,uploaded_at FROM consulting_firm_documents WHERE firm_id=? ORDER BY uploaded_at DESC').all(f.id),events:getDB().prepare('SELECT action,note,created_at FROM consulting_firm_verification_events WHERE firm_id=? ORDER BY created_at DESC LIMIT 20').all(f.id)}))});
}));
router.get('/admin/firms', A.requireRole('admin'), wrap(async(req,res)=>{
  const status=clip(req.query?.status,20);
  if(status&&!['pending','verified','rejected','suspended'].includes(status)) throw E.validation('مرشح الحالة غير صالح.');
  const rows=getDB().prepare(`SELECT id,legal_name,country,registration_number,contact_email,contact_phone,specializations_json,experience_summary,website,verification_status,verification_note,created_at,verified_at,(SELECT u.name FROM consulting_firm_members m JOIN users u ON u.id=m.user_id WHERE m.firm_id=consulting_firms.id AND m.member_role='owner' LIMIT 1) owner_name,(SELECT u.email FROM consulting_firm_members m JOIN users u ON u.id=m.user_id WHERE m.firm_id=consulting_firms.id AND m.member_role='owner' LIMIT 1) owner_email FROM consulting_firms ${status?'WHERE verification_status=?':''} ORDER BY created_at DESC LIMIT 300`).all(...(status?[status]:[]));
  res.json({firms:rows.map(f=>({...f,specializations:JSON.parse(f.specializations_json||'[]'),specializations_json:undefined,documents:getDB().prepare('SELECT id,document_kind,original_name,mime,size,uploaded_at FROM consulting_firm_documents WHERE firm_id=? ORDER BY uploaded_at DESC').all(f.id),events:getDB().prepare('SELECT action,note,created_at FROM consulting_firm_verification_events WHERE firm_id=? ORDER BY created_at DESC LIMIT 20').all(f.id)}))});
}));
router.get('/admin/firms/:id/documents/:docId', A.requireRole('admin'), wrap(async(req,res)=>{
  const d=getDB().prepare('SELECT * FROM consulting_firm_documents WHERE id=? AND firm_id=?').get(req.params.docId,req.params.id);
  if(!d) throw E.notFound('وثيقة المكتب غير موجودة.');
  const store=d.storage_driver==='s3'?require('../lib/storage/s3'):require('../lib/storage/local');
  if(!(await store.exists(d.storage_key))) throw E.notFound('ملف الوثيقة غير موجود في التخزين.');
  res.setHeader('Content-Type',d.mime||'application/octet-stream');
  res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(d.original_name));
  res.setHeader('Cache-Control','private, no-store');
  const stream=store.stream(d.storage_key);
  if(d.storage_driver==='s3'){const obj=await stream;obj.body.pipe(res);}else stream.pipe(res);
}));

router.patch('/admin/firms/:id/verification', A.requireRole('admin'), wrap(async(req,res)=>{
  const status=clip(req.body?.status,20), note=clip(req.body?.note,1000);
  if(!['verified','rejected','suspended','pending'].includes(status)) throw E.validation('حالة التحقق غير صالحة.');
  if(['verified','rejected'].includes(status)&&!note) throw E.validation('اذكر مرجع التحقق القانوني أو سبب الرفض في سجل المراجعة.');
  const db=getDB(), firm=db.prepare('SELECT id,verification_status FROM consulting_firms WHERE id=?').get(req.params.id);
  if(!firm) throw E.notFound('المكتب غير موجود.');
  const now=Math.floor(Date.now()/1000);
  db.transaction(()=>{
    db.prepare(`UPDATE consulting_firms SET verification_status=?,verification_note=?,verified_by=?,verified_at=?,updated_at=unixepoch() WHERE id=?`).run(status,note||null,status==='verified'?req.user.id:null,status==='verified'?now:null,firm.id);
    db.prepare(`INSERT INTO consulting_firm_verification_events (id,firm_id,actor_user_id,action,note) VALUES (?,?,?,?,?)`).run(uid('cfe_'),firm.id,req.user.id,status,note||null);
  })();
  audit({action:'consulting_firm_verification',entity:'consulting_firm',entityId:firm.id,userId:req.user.id,ip:req.ip,detail:{from:firm.verification_status,to:status}});
  res.json({ok:true,status,message:'تم تحديث حالة التحقق.'});
}));

// Independent requester identity: deliberately separate from procurement organizations.
function requesterFor(userId){return getDB().prepare(`SELECT e.*,m.member_role FROM consulting_requester_members m JOIN consulting_requester_entities e ON e.id=m.entity_id WHERE m.user_id=? AND m.status='active'`).get(userId)||null;}
function requireRequester(req){if(req.user.role!=='buyer')throw E.forbidden('هذه الوظيفة مخصصة للجهات الطالبة للخدمات الاستشارية.');const entity=requesterFor(req.user.id);if(!entity)throw E.forbidden('أنشئ ملف الجهة الطالبة أولاً.');return entity;}
function requireVerifiedRequester(req){const e=requireRequester(req);if(e.verification_status!=='verified')throw E.forbidden('يجب توثيق ملف الجهة الطالبة قبل نشر طلبات الخدمات.');return e;}
function requireFirmMember(req){requireConsultant(req);const f=firmFor(req.user.id);if(!f||f.member_status!=='active')throw E.forbidden('لا توجد عضوية مكتب استشاري فعالة لهذا الحساب.');return f;}
function requireVerifiedFirm(req){const f=requireFirmMember(req);if(f.verification_status!=='verified')throw E.forbidden('يجب تسجيل المكتب واستكمال التحقق القانوني قبل دخول سوق الخدمات.');return f;}
function marketEvent(userId,type,id,action,detail){getDB().prepare(`INSERT INTO consulting_market_events (id,actor_user_id,entity_type,entity_id,action,detail_json) VALUES (?,?,?,?,?,?)`).run(uid('cme_'),userId,type,id,action,detail?JSON.stringify(detail):null);}
const marketCurrency=['USD','JOD','SAR','AED'];
const requesterConsultingDisciplines=['هندسة مدنية','هندسة إنشائية','تصميم معماري','هندسة ميكانيكية','هندسة كهربائية','الإشراف الهندسي','إدارة المشاريع','حصر الكميات','الجيوتقنية','الدراسات البيئية','الطرق والنقل','المياه والصرف الصحي','التخطيط الحضري','مسح الأراضي','خدمات استشارية أخرى','Civil Engineering'];

router.get('/requester/me',wrap(async(req,res)=>{if(req.user.role!=='buyer')throw E.forbidden('هذه الوظيفة مخصصة للجهات الطالبة.');const e=requesterFor(req.user.id);res.setHeader('Cache-Control','no-store');res.json({requester:e?{id:e.id,legalName:e.legal_name,country:e.country,registrationNumber:e.registration_number,contactEmail:e.contact_email,contactPhone:e.contact_phone,verificationStatus:e.verification_status,verificationNote:e.verification_note}:null});}));

router.post('/requester/entities',wrap(async(req,res)=>{
 if(req.user.role!=='buyer')throw E.forbidden('تسجيل الجهة الطالبة متاح لحسابات الجهات فقط.');const db=getDB();if(requesterFor(req.user.id))throw E.conflict('هذا الحساب مرتبط بملف جهة طالبة بالفعل.');
 const legalName=clip(req.body?.legalName,180),country=clip(req.body?.country,2).toUpperCase(),registration=clip(req.body?.registrationNumber,80),email=clip(req.body?.contactEmail,254).toLowerCase(),phone=clip(req.body?.contactPhone,40);
 if(legalName.length<3||!['JO','SA','AE'].includes(country)||registration.length<3||registration.split('').some(ch=>!/[A-Za-z0-9 _.-]/.test(ch))||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||phone.replace(/\D/g,'').length<7)throw E.validation('أكمل الاسم القانوني والدولة ورقم التسجيل وبيانات التواصل بصورة صحيحة.');
 const key=identity(country,registration);if(key.length<5)throw E.validation('رقم التسجيل القانوني قصير جداً.');if(db.prepare('SELECT id FROM consulting_requester_entities WHERE identity_key=?').get(key))throw E.conflict('يوجد ملف جهة مسجل بنفس الدولة ورقم التسجيل القانوني.');
 const id=uid('cre_');db.transaction(()=>{db.prepare(`INSERT INTO consulting_requester_entities (id,legal_name,country,registration_number,identity_key,contact_email,contact_phone) VALUES (?,?,?,?,?,?,?)`).run(id,legalName,country,registration,key,email,phone);db.prepare(`INSERT INTO consulting_requester_members (id,entity_id,user_id,member_role) VALUES (?,?,?,'owner')`).run(uid('crm_'),id,req.user.id);db.prepare(`INSERT INTO consulting_market_events (id,actor_user_id,entity_type,entity_id,action) VALUES (?,?,'requester',?,'submitted')`).run(uid('cme_'),req.user.id,id);})();
 res.status(201).json({requester:{id,legalName,country,registrationNumber:registration,verificationStatus:'pending'},message:'تم تسجيل الجهة الطالبة وهي قيد التحقق المستقل.'});
}));

router.get('/admin/requesters/pending',A.requireRole('admin'),wrap(async(req,res)=>{const rows=getDB().prepare(`SELECT id,legal_name,country,registration_number,contact_email,contact_phone,verification_status,created_at FROM consulting_requester_entities WHERE verification_status='pending' ORDER BY created_at`).all();res.json({requesters:rows});}));
router.patch('/admin/requesters/:id/verification',A.requireRole('admin'),wrap(async(req,res)=>{const status=clip(req.body?.status,20),note=clip(req.body?.note,1000);if(!['verified','rejected','suspended','pending'].includes(status))throw E.validation('حالة التحقق غير صالحة.');if(['verified','rejected'].includes(status)&&!note)throw E.validation('اذكر مرجع التحقق القانوني أو سبب الرفض.');const db=getDB(),e=db.prepare('SELECT id,verification_status FROM consulting_requester_entities WHERE id=?').get(req.params.id);if(!e)throw E.notFound('الجهة غير موجودة.');db.prepare(`UPDATE consulting_requester_entities SET verification_status=?,verification_note=?,verified_by=?,verified_at=?,updated_at=unixepoch() WHERE id=?`).run(status,note||null,status==='verified'?req.user.id:null,status==='verified'?Math.floor(Date.now()/1000):null,e.id);marketEvent(req.user.id,'requester',e.id,'verification',{from:e.verification_status,to:status,note});res.json({ok:true,status});}));

router.post('/requests',wrap(async(req,res)=>{const entity=requireVerifiedRequester(req);const title=clip(req.body?.title,180),discipline=clip(req.body?.discipline,100),country=clip(req.body?.country,2).toUpperCase(),location=clip(req.body?.location,180),description=clip(req.body?.description,5000),currency=clip(req.body?.currency,3).toUpperCase();if(title.length<4||!requesterConsultingDisciplines.includes(discipline)||!['JO','SA','AE'].includes(country)||description.length<20||!marketCurrency.includes(currency))throw E.validation('أكمل عنوان الطلب والتخصص والدولة والوصف والعملة بصورة صحيحة.');const min=req.body?.budgetMin==null||req.body.budgetMin===''?null:Number(req.body.budgetMin),max=req.body?.budgetMax==null||req.body.budgetMax===''?null:Number(req.body.budgetMax);if((min!==null&&(!Number.isFinite(min)||min<0))||(max!==null&&(!Number.isFinite(max)||max<0))||(min!==null&&max!==null&&min>max))throw E.validation('نطاق الميزانية غير صحيح.');let closing=null;if(req.body?.closingDate){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(req.body.closingDate)))throw E.validation('تاريخ الإغلاق يجب أن يكون YYYY-MM-DD.');closing=Math.floor(Date.parse(String(req.body.closingDate)+'T23:59:59Z')/1000);if(!Number.isFinite(closing)||closing<=Math.floor(Date.now()/1000))throw E.validation('تاريخ الإغلاق يجب أن يكون في المستقبل.');}const scope=Array.isArray(req.body?.scope)?req.body.scope.map(x=>clip(x,250)).filter(Boolean).slice(0,40):[];const id=uid('csr_'),reference='CS-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+id.slice(-6).toUpperCase();const db=getDB();db.prepare(`INSERT INTO consulting_service_requests (id,reference,requester_entity_id,created_by,title,discipline,country,location,description,scope_json,currency,budget_min,budget_max,closing_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open')`).run(id,reference,entity.id,req.user.id,title,discipline,country,location||null,description,JSON.stringify(scope),currency,min,max,closing);marketEvent(req.user.id,'request',id,'published',{reference,currency});res.status(201).json({request:{id,reference,title,status:'open'},message:'تم نشر طلب الخدمة في سوق الاستشارات.'});}));

router.get('/requests/mine',wrap(async(req,res)=>{const entity=requireRequester(req);const rows=getDB().prepare(`SELECT r.id,r.reference,r.title,r.discipline,r.country,r.location,r.currency,r.budget_min,r.budget_max,r.closing_at,r.status,r.created_at,(SELECT COUNT(*) FROM consulting_proposals p WHERE p.request_id=r.id) proposal_count FROM consulting_service_requests r WHERE r.requester_entity_id=? ORDER BY r.created_at DESC`).all(entity.id);res.json({requests:rows});}));

router.get('/requests/open',wrap(async(req,res)=>{requireVerifiedFirm(req);const now=Math.floor(Date.now()/1000);const rows=getDB().prepare(`SELECT r.id,r.reference,r.title,r.discipline,r.country,r.location,r.description,r.scope_json,r.currency,r.budget_min,r.budget_max,r.closing_at,r.created_at FROM consulting_service_requests r WHERE r.status='open' AND (r.closing_at IS NULL OR r.closing_at>?) ORDER BY r.created_at DESC LIMIT 200`).all(now);res.json({requests:rows.map(r=>({...r,scope:JSON.parse(r.scope_json||'[]'),scope_json:undefined}))});}));

router.post('/requests/:id/proposals',wrap(async(req,res)=>{const firm=requireVerifiedFirm(req),db=getDB();const r=db.prepare(`SELECT id,currency,status,closing_at FROM consulting_service_requests WHERE id=?`).get(req.params.id);if(!r||r.status!=='open'||(r.closing_at&&r.closing_at<=Math.floor(Date.now()/1000)))throw E.notFound('طلب الخدمة غير متاح للتقديم.');if(db.prepare('SELECT id FROM consulting_proposals WHERE request_id=? AND firm_id=?').get(r.id,firm.id))throw E.conflict('سبق لهذا المكتب تقديم عرض على طلب الخدمة.');const summary=clip(req.body?.technicalSummary,5000),method=clip(req.body?.methodology,5000),team=clip(req.body?.teamSummary,3000),amount=Number(req.body?.financialAmount),currency=clip(req.body?.currency,3).toUpperCase(),days=Number(req.body?.durationDays);if(summary.length<20||!Number.isFinite(amount)||amount<=0||currency!==r.currency||!Number.isInteger(days)||days<1||days>3650)throw E.validation('بيانات العرض الفني والمالي والعملة والمدة غير مكتملة أو غير مطابقة لعملة الطلب.');const id=uid('cprop_');db.prepare(`INSERT INTO consulting_proposals (id,request_id,firm_id,submitted_by,technical_summary,methodology,team_summary,financial_amount,currency,duration_days,validity_until) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,r.id,firm.id,req.user.id,summary,method||null,team||null,amount,currency,days,clip(req.body?.validityUntil,10)||null);marketEvent(req.user.id,'proposal',id,'submitted',{requestId:r.id,firmId:firm.id});res.status(201).json({proposal:{id,requestId:r.id,status:'submitted'},message:'تم تقديم العرض. لا يمكن للمكاتب الأخرى الاطلاع عليه.'});}));

router.get('/proposals/mine',wrap(async(req,res)=>{const firm=requireVerifiedFirm(req);const rows=getDB().prepare(`SELECT p.id,p.request_id,p.technical_summary,p.financial_amount,p.currency,p.duration_days,p.status,p.created_at,r.reference,r.title request_title,r.status request_status FROM consulting_proposals p JOIN consulting_service_requests r ON r.id=p.request_id WHERE p.firm_id=? ORDER BY p.created_at DESC`).all(firm.id);res.json({proposals:rows});}));

router.get('/requests/:id/proposals',wrap(async(req,res)=>{const entity=requireRequester(req),db=getDB();const own=db.prepare('SELECT id FROM consulting_service_requests WHERE id=? AND requester_entity_id=?').get(req.params.id,entity.id);if(!own)throw E.notFound('طلب الخدمة غير موجود.');const rows=db.prepare(`SELECT p.id,p.firm_id,f.legal_name firm_name,f.country firm_country,f.specializations_json,p.technical_summary,p.methodology,p.team_summary,p.financial_amount,p.currency,p.duration_days,p.validity_until,p.status,p.created_at FROM consulting_proposals p JOIN consulting_firms f ON f.id=p.firm_id WHERE p.request_id=? ORDER BY p.created_at`).all(own.id);res.json({proposals:rows.map(p=>({...p,specializations:JSON.parse(p.specializations_json||'[]'),specializations_json:undefined}))});}));

router.post('/requests/:id/award',wrap(async(req,res)=>{const entity=requireVerifiedRequester(req),db=getDB();const request=db.prepare(`SELECT * FROM consulting_service_requests WHERE id=? AND requester_entity_id=?`).get(req.params.id,entity.id);if(!request||request.status!=='open')throw E.notFound('طلب الخدمة غير متاح للترسية.');const proposal=db.prepare(`SELECT * FROM consulting_proposals WHERE id=? AND request_id=? AND status='submitted'`).get(clip(req.body?.proposalId,100),request.id);if(!proposal)throw E.notFound('العرض المحدد غير موجود أو لم يعد متاحاً.');const contractId=uid('ccon_'),contractRef=clip(req.body?.contractReference,80)||('CONS-'+contractId.slice(-10).toUpperCase());db.transaction(()=>{db.prepare(`UPDATE consulting_proposals SET status=CASE WHEN id=? THEN 'selected' ELSE 'rejected' END,updated_at=unixepoch() WHERE request_id=? AND status='submitted'`).run(proposal.id,request.id);db.prepare(`UPDATE consulting_service_requests SET status='awarded',updated_at=unixepoch() WHERE id=?`).run(request.id);db.prepare(`INSERT INTO consulting_contracts (id,request_id,proposal_id,requester_entity_id,firm_id,contract_reference,agreed_amount,currency,created_by) VALUES (?,?,?,?,?,?,?,?,?)`).run(contractId,request.id,proposal.id,entity.id,proposal.firm_id,contractRef,proposal.financial_amount,proposal.currency,req.user.id);})();marketEvent(req.user.id,'contract',contractId,'awarded',{requestId:request.id,proposalId:proposal.id});res.status(201).json({contract:{id:contractId,reference:contractRef,requestId:request.id,firmId:proposal.firm_id,amount:proposal.financial_amount,currency:proposal.currency,status:'awarded'},message:'تم اختيار المكتب وإنشاء سجل التعاقد.'});}));

router.get('/contracts',wrap(async(req,res)=>{let rows;if(req.user.role==='consultant'){const firm=requireFirmMember(req);rows=getDB().prepare(`SELECT c.id,c.contract_reference,c.agreed_amount,c.currency,c.start_date,c.end_date,c.status,c.created_at,r.reference,r.title request_title,e.legal_name requester_name FROM consulting_contracts c JOIN consulting_service_requests r ON r.id=c.request_id JOIN consulting_requester_entities e ON e.id=c.requester_entity_id WHERE c.firm_id=? ORDER BY c.created_at DESC`).all(firm.id);}else if(req.user.role==='buyer'){const entity=requireRequester(req);rows=getDB().prepare(`SELECT c.id,c.contract_reference,c.agreed_amount,c.currency,c.start_date,c.end_date,c.status,c.created_at,r.reference,r.title request_title,f.legal_name firm_name FROM consulting_contracts c JOIN consulting_service_requests r ON r.id=c.request_id JOIN consulting_firms f ON f.id=c.firm_id WHERE c.requester_entity_id=? ORDER BY c.created_at DESC`).all(entity.id);}else throw E.forbidden('لا تملك صلاحية عرض عقود الاستشارات.');res.json({contracts:rows});}));

function contractForUser(req,id){
 let row;
 if(req.user.role==='consultant'){const firm=requireFirmMember(req);row=getDB().prepare('SELECT * FROM consulting_contracts WHERE id=? AND firm_id=?').get(id,firm.id);}
 else if(req.user.role==='buyer'){const entity=requireRequester(req);row=getDB().prepare('SELECT * FROM consulting_contracts WHERE id=? AND requester_entity_id=?').get(id,entity.id);}
 else throw E.forbidden('لا تملك صلاحية الوصول إلى عقود الاستشارات.');
 if(!row)throw E.notFound('العقد غير موجود.');return row;
}

router.get('/contracts/:id/updates',wrap(async(req,res)=>{const contract=contractForUser(req,req.params.id);const rows=getDB().prepare(`SELECT u.id,u.update_type,u.progress_percent,u.note,u.created_at,a.name actor_name FROM consulting_contract_updates u JOIN users a ON a.id=u.actor_user_id WHERE u.contract_id=? ORDER BY u.created_at,u.id`).all(contract.id);res.json({updates:rows});}));

router.post('/contracts/:id/updates',wrap(async(req,res)=>{const contract=contractForUser(req,req.params.id);if(!['awarded','active'].includes(contract.status))throw E.conflict('لا يمكن إضافة تحديث بعد إغلاق العقد.');const type=clip(req.body?.type,20)||'progress',note=clip(req.body?.note,3000),pct=req.body?.progressPercent==null||req.body?.progressPercent===''?null:Number(req.body.progressPercent);if(!['progress','milestone','issue'].includes(type)||note.length<5||(pct!==null&&(!Number.isInteger(pct)||pct<0||pct>100)))throw E.validation('نوع التحديث أو نصه أو نسبة الإنجاز غير صحيحة.');const id=uid('ccu_');getDB().prepare(`INSERT INTO consulting_contract_updates (id,contract_id,actor_user_id,update_type,progress_percent,note) VALUES (?,?,?,?,?,?)`).run(id,contract.id,req.user.id,type,pct,note);marketEvent(req.user.id,'contract',contract.id,'update',{updateId:id,type,progressPercent:pct});res.status(201).json({update:{id,type,progressPercent:pct,note},message:'تم تسجيل تحديث تنفيذ الخدمة.'});}));

router.patch('/contracts/:id/status',wrap(async(req,res)=>{const contract=contractForUser(req,req.params.id),next=clip(req.body?.status,20),note=clip(req.body?.note,1000);if(note.length<5)throw E.validation('اكتب ملاحظة توضح تغيير حالة العقد.');let allowed=false;if(req.user.role==='consultant')allowed=contract.status==='awarded'&&next==='active';else if(req.user.role==='buyer')allowed=(contract.status==='awarded'&&next==='active')||(contract.status==='active'&&['completed','terminated'].includes(next));if(!allowed)throw E.conflict('انتقال حالة العقد غير مسموح من الحالة الحالية.');getDB().prepare('UPDATE consulting_contracts SET status=?,updated_at=unixepoch() WHERE id=?').run(next,contract.id);getDB().prepare(`INSERT INTO consulting_contract_updates (id,contract_id,actor_user_id,update_type,note) VALUES (?,?,?,'status',?)`).run(uid('ccu_'),contract.id,req.user.id,note+' ['+next+']');marketEvent(req.user.id,'contract',contract.id,'status',{from:contract.status,to:next,note});res.json({ok:true,status:next,message:'تم تحديث حالة العقد.'});}));

const multer = require('multer');
const config = require('../config');
const S = require('../lib/storage');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_BYTES, files: 5 },
  fileFilter: (req,file,cb) => { try { S.assertAllowed(file.originalname,0); cb(null,true); } catch(err) { cb(err); } }
});
const firmDocKinds=['registration','professional_license','tax_certificate','insurance','portfolio','authorization','other'];
router.post('/firms/me/documents', upload.array('files',5), wrap(async(req,res)=>{
  requireConsultant(req);
  const firm=firmFor(req.user.id); requireOwner(req,firm);
  const kind=clip(req.body?.kind,30);
  if(!firmDocKinds.includes(kind)) throw E.validation('نوع وثيقة المكتب غير صحيح.');
  const files=req.files||[];
  if(!files.length) throw E.validation('أرفق ملفاً واحداً على الأقل.');
  const store=S.getStorage(),db=getDB(),created=[];
  for(const f of files){
    S.assertAllowed(f.originalname,f.size);
    const id=uid('cfdoc_'),key=['consulting-firms',firm.id,kind,S.makeStoredName(f.originalname)].join('/');
    const put=await store.put(key,f.buffer,{mime:f.mimetype||'application/octet-stream',originalName:S.displayName(f.originalname)});
    db.prepare(`INSERT INTO consulting_firm_documents (id,firm_id,document_kind,storage_key,storage_driver,original_name,mime,size,checksum,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,firm.id,kind,key,store.DRIVER,S.displayName(f.originalname),f.mimetype||'application/octet-stream',f.size,put.checksum,req.user.id);
    created.push({id,name:S.displayName(f.originalname),kind,size:f.size});
  }
  marketEvent(req.user.id,'firm',firm.id,'documents_uploaded',{count:created.length});
  res.status(201).json({documents:created,message:'تم رفع وثائق المكتب وإضافتها إلى ملف المراجعة.'});
}));
router.get('/firms/me/documents',wrap(async(req,res)=>{
  const firm=requireFirmMember(req);
  const rows=getDB().prepare('SELECT id,document_kind,original_name,mime,size,uploaded_at FROM consulting_firm_documents WHERE firm_id=? ORDER BY uploaded_at DESC').all(firm.id);
  res.json({documents:rows});
}));
const docKinds = ['brief','scope','reference','technical','financial','contract','deliverable','report'];
function canReadDoc(user,doc) {
  if (user.role==='admin') return false;
  if (user.role==='buyer') {
    const e=requesterFor(user.id);
    if(!e||e.id!==doc.requester_entity_id)return false;
    if(doc.visibility==='selected_only' && doc.owner_type==='proposal') {
      const own=getDB().prepare("SELECT 1 FROM consulting_proposals p JOIN consulting_service_requests r ON r.id=p.request_id WHERE p.id=? AND r.requester_entity_id=?").get(doc.owner_id,e.id);
      return !!own;
    }
    return true;
  }
  if(user.role==='consultant') {
    const f=firmFor(user.id);
    if(!f||f.verification_status!=='verified'||f.member_status!=='active')return false;
    if(doc.visibility==='market' && doc.owner_type==='request'){const request=getDB().prepare('SELECT status FROM consulting_service_requests WHERE id=?').get(doc.request_id);if(request?.status==='open')return true;if(request?.status==='awarded')return !!getDB().prepare('SELECT 1 FROM consulting_contracts WHERE request_id=? AND firm_id=?').get(doc.request_id,f.id);return false;}
    if(doc.firm_id===f.id)return true;
    if(doc.owner_type==='proposal' && doc.visibility==='selected_only') {
      const award=getDB().prepare("SELECT 1 FROM consulting_contracts WHERE proposal_id=? AND firm_id=?").get(doc.owner_id,f.id);
      return !!award;
    }
  }
  return false;
}
function docOwner(req,ownerType,ownerId) {
  const db=getDB();
  if(ownerType==='request') {
    const row=db.prepare('SELECT id,requester_entity_id FROM consulting_service_requests WHERE id=?').get(ownerId);
    if(!row)throw E.notFound('طلب الخدمة غير موجود.');
    if(req.user.role==='buyer'){const e=requireRequester(req);if(e.id!==row.requester_entity_id)throw E.notFound('طلب الخدمة غير موجود.');return {requestId:row.id,firmId:null,requesterId:e.id,visibility:'market'};}
    if(req.user.role==='consultant'){const f=requireVerifiedFirm(req);const open=db.prepare("SELECT id FROM consulting_service_requests WHERE id=? AND status='open'").get(row.id);const awarded=db.prepare("SELECT 1 FROM consulting_contracts WHERE request_id=? AND firm_id=?").get(row.id,f.id);if(!open&&!awarded)throw E.notFound('طلب الخدمة غير متاح.');return {requestId:row.id,firmId:f.id,requesterId:row.requester_entity_id,visibility:'market',uploadAllowed:false};}
  }
  if(ownerType==='proposal') {
    const p=db.prepare('SELECT p.id,p.request_id,p.firm_id,p.status,r.requester_entity_id FROM consulting_proposals p JOIN consulting_service_requests r ON r.id=p.request_id WHERE p.id=?').get(ownerId);
    if(!p)throw E.notFound('العرض غير موجود.');
    if(req.user.role==='consultant'){const f=requireVerifiedFirm(req);if(f.id!==p.firm_id)throw E.notFound('العرض غير موجود.');return {requestId:p.request_id,firmId:f.id,requesterId:p.requester_entity_id,visibility:'selected_only'};}
    if(req.user.role==='buyer'){const e=requireRequester(req);if(e.id!==p.requester_entity_id)throw E.notFound('العرض غير موجود.');return {requestId:p.request_id,firmId:p.firm_id,requesterId:e.id,visibility:'selected_only',uploadAllowed:p.status==='selected'};}
  }
  if(ownerType==='contract') {
    const k=db.prepare('SELECT id,request_id,firm_id,requester_entity_id FROM consulting_contracts WHERE id=?').get(ownerId);
    if(!k)throw E.notFound('العقد غير موجود.');
    if(req.user.role==='consultant'){const f=requireVerifiedFirm(req);if(f.id!==k.firm_id)throw E.notFound('العقد غير موجود.');return {requestId:k.request_id,firmId:f.id,requesterId:k.requester_entity_id,visibility:'selected_only'};}
    if(req.user.role==='buyer'){const e=requireRequester(req);if(e.id!==k.requester_entity_id)throw E.notFound('العقد غير موجود.');return {requestId:k.request_id,firmId:k.firm_id,requesterId:e.id,visibility:'selected_only'};}
  }
  throw E.forbidden('لا تملك صلاحية إدارة وثائق هذا السجل.');
}
function shapeDoc(d){return {id:d.id,ownerType:d.owner_type,ownerId:d.owner_id,kind:d.document_kind,name:d.original_name,mime:d.mime,size:d.size,visibility:d.visibility,uploadedAt:d.uploaded_at};}
router.post('/documents/:ownerType/:ownerId',upload.array('files',5),wrap(async(req,res)=>{
 const ownerType=clip(req.params.ownerType,20);if(!['request','proposal','contract'].includes(ownerType))throw E.validation('نوع السجل غير مدعوم.');
 const owner=docOwner(req,ownerType,req.params.ownerId);if(ownerType==='proposal'&&req.user.role==='buyer'&&owner.uploadAllowed===false)throw E.forbidden('لا يمكن للجهة إضافة وثائق إلى العرض قبل الترسية.');if(ownerType==='request'){if(req.user.role!=='buyer')throw E.forbidden('وثائق طلب الخدمة يرفعها صاحب الطلب فقط.');const requestState=getDB().prepare('SELECT status FROM consulting_service_requests WHERE id=?').get(owner.requestId);if(!requestState||requestState.status!=='open')throw E.forbidden('لا يمكن إضافة وثائق جديدة بعد إغلاق طلب الخدمة.');}const files=req.files||[];if(!files.length)throw E.validation('أرفق ملفاً واحداً على الأقل.');
 const kind=clip(req.body?.kind,20);if(!docKinds.includes(kind))throw E.validation('تصنيف الوثيقة غير صحيح.');
 const visibility=ownerType==='request'?'market':'selected_only';const store=S.getStorage(),db=getDB(),created=[];
 for(const f of files){S.assertAllowed(f.originalname,f.size);const id=uid('cdoc_');const key=['consulting',owner.requestId,ownerType,(owner.firmId||owner.requesterId||'shared'),S.makeStoredName(f.originalname)].join('/');const put=await store.put(key,f.buffer,{mime:f.mimetype||'application/octet-stream',originalName:S.displayName(f.originalname)});db.prepare(`INSERT INTO consulting_documents (id,owner_type,owner_id,request_id,firm_id,requester_entity_id,visibility,document_kind,storage_key,storage_driver,original_name,mime,size,checksum,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,ownerType,req.params.ownerId,owner.requestId,owner.firmId,owner.requesterId,visibility,kind,key,store.DRIVER,S.displayName(f.originalname),f.mimetype||'application/octet-stream',f.size,put.checksum,req.user.id);marketEvent(req.user.id,'document',id,'uploaded',{ownerType,kind,size:f.size});created.push({id,name:S.displayName(f.originalname),size:f.size});}
 res.status(201).json({documents:created});
}));

router.delete('/documents/:id',wrap(async(req,res)=>{
 const d=getDB().prepare('SELECT * FROM consulting_documents WHERE id=?').get(req.params.id);if(!d||!canReadDoc(req.user,d))throw E.notFound('الوثيقة غير موجودة.');if(d.uploaded_by!==req.user.id&&req.user.role!=='admin')throw E.forbidden('حذف الوثيقة متاح لمن رفعها فقط.');getDB().prepare('DELETE FROM consulting_documents WHERE id=?').run(d.id);try{await S.getStorage().delete(d.storage_key);}catch(_){}marketEvent(req.user.id,'document',d.id,'deleted');res.json({ok:true});
}));

router.get('/documents/:id/download',wrap(async(req,res)=>{
 const d=getDB().prepare('SELECT * FROM consulting_documents WHERE id=?').get(req.params.id);
 if(!d||!canReadDoc(req.user,d))throw E.notFound('الوثيقة غير موجودة.');
 const store=d.storage_driver==='s3'?require('../lib/storage/s3'):require('../lib/storage/local');
 if(!(await store.exists(d.storage_key)))throw E.notFound('ملف الوثيقة غير موجود في التخزين.');
 res.setHeader('Content-Type',d.mime||'application/octet-stream');
 res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(d.original_name));
 res.setHeader('Cache-Control','private, no-store');
 const stream=store.stream(d.storage_key);
 if(d.storage_driver==='s3'){const obj=await stream;obj.body.pipe(res);}else stream.pipe(res);
}));

router.get('/documents/:ownerType/:ownerId',wrap(async(req,res)=>{
 const ownerType=clip(req.params.ownerType,20);
 const owner=docOwner(req,ownerType,req.params.ownerId);
 const rows=getDB().prepare('SELECT * FROM consulting_documents WHERE owner_type=? AND owner_id=? ORDER BY uploaded_at').all(ownerType,req.params.ownerId);
 res.setHeader('Cache-Control','private, no-store');
 res.json({documents:rows.filter(d=>canReadDoc(req.user,d)).map(shapeDoc)});
}));


// Independent tender desk for consulting offices: subcontracted consulting disciplines only.
const consultingDisciplines=['engineering_design','site_supervision','project_management','quantity_surveying','geotechnical','environmental','transportation','water_wastewater','architecture','other'];
function firmTenderOwner(req,id){
 const firm=requireFirmManager(req);
 const tender=getDB().prepare('SELECT * FROM consulting_firm_tenders WHERE id=? AND firm_id=?').get(id,firm.id);
 if(!tender)throw E.notFound('العطاء الاستشاري غير موجود.');
 return {firm,tender};
}
router.get('/firm-tenders/market',wrap(async(req,res)=>{
 const firm=requireVerifiedFirm(req),now=Math.floor(Date.now()/1000);
 const rows=getDB().prepare(`SELECT t.id,t.reference,t.title,t.discipline,t.country,t.location,t.description,t.scope_json,t.currency,t.budget_min,t.budget_max,t.closing_at,t.technical_threshold,t.created_at,f.legal_name publisher_name FROM consulting_firm_tenders t JOIN consulting_firms f ON f.id=t.firm_id WHERE t.status='open' AND t.firm_id<>? AND (t.closing_at IS NULL OR t.closing_at>?) ORDER BY t.created_at DESC LIMIT 200`).all(firm.id,now);
 res.json({tenders:rows.map(x=>({...x,scope:JSON.parse(x.scope_json||'[]'),scope_json:undefined}))});
}));
router.get('/firm-tenders/mine',wrap(async(req,res)=>{
 const firm=requireVerifiedFirm(req);
 const rows=getDB().prepare(`SELECT t.id,t.reference,t.title,t.discipline,t.country,t.location,t.description,t.currency,t.budget_min,t.budget_max,t.closing_at,t.technical_threshold,t.status,t.created_at,(SELECT COUNT(*) FROM consulting_firm_tender_proposals p WHERE p.tender_id=t.id) proposal_count FROM consulting_firm_tenders t WHERE t.firm_id=? ORDER BY t.created_at DESC`).all(firm.id);
 res.json({tenders:rows});
}));
router.post('/firm-tenders',wrap(async(req,res)=>{
 const firm=requireFirmManager(req),db=getDB();
 const title=clip(req.body?.title,180),discipline=clip(req.body?.discipline,40),country=clip(req.body?.country,2).toUpperCase(),location=clip(req.body?.location,160),description=clip(req.body?.description,5000),currency=clip(req.body?.currency,3).toUpperCase();
 const min=req.body?.budgetMin==null||req.body?.budgetMin===''?null:Number(req.body.budgetMin),max=req.body?.budgetMax==null||req.body?.budgetMax===''?null:Number(req.body.budgetMax);
 const closing=clip(req.body?.closingDate,10),threshold=Number(req.body?.technicalThreshold??50);
 const scope=Array.isArray(req.body?.scope)?req.body.scope.map(x=>clip(x,300)).filter(Boolean).slice(0,40):[];
 if(title.length<5||!consultingDisciplines.includes(discipline)||!['JO','SA','AE'].includes(country)||description.length<30||!marketCurrency.includes(currency)||(min!==null&&(!Number.isFinite(min)||min<0))||(max!==null&&(!Number.isFinite(max)||max<0))||(min!==null&&max!==null&&max<min)||!Number.isInteger(threshold)||threshold<1||threshold>100)throw E.validation('أكمل عنوان العطاء والتخصص الاستشاري والدولة والوصف والميزانية والحد الفني بصورة صحيحة.');
 let closingAt=null;if(closing){if(!/^\d{4}-\d{2}-\d{2}$/.test(closing))throw E.validation('تاريخ الإغلاق غير صحيح.');closingAt=Math.floor(new Date(closing+'T23:59:59Z').getTime()/1000);if(closingAt<=Math.floor(Date.now()/1000))throw E.validation('يجب أن يكون موعد الإغلاق في المستقبل.');}
 const id=uid('cft_'),reference='CFT-'+id.slice(-10).toUpperCase();
 db.prepare(`INSERT INTO consulting_firm_tenders (id,reference,firm_id,created_by,title,discipline,country,location,description,scope_json,currency,budget_min,budget_max,closing_at,technical_threshold) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,reference,firm.id,req.user.id,title,discipline,country,location||null,description,JSON.stringify(scope),currency,min,max,closingAt,threshold);
 marketEvent(req.user.id,'firm_tender',id,'published',{firmId:firm.id,discipline,country});
 res.status(201).json({tender:{id,reference,title,status:'open'},message:'تم نشر العطاء الاستشاري الفرعي في سوق المكاتب الاستشارية فقط.'});
}));
router.post('/firm-tenders/:id/proposals',wrap(async(req,res)=>{
 const firm=requireVerifiedFirm(req),db=getDB(),t=db.prepare('SELECT * FROM consulting_firm_tenders WHERE id=? AND status=\'open\'').get(req.params.id);
 if(!t||t.firm_id===firm.id||(t.closing_at&&t.closing_at<=Math.floor(Date.now()/1000)))throw E.notFound('العطاء غير متاح للتقديم.');
 if(db.prepare('SELECT 1 FROM consulting_firm_tender_proposals WHERE tender_id=? AND firm_id=?').get(t.id,firm.id))throw E.conflict('سبق لهذا المكتب تقديم عرض على هذا العطاء.');
 const summary=clip(req.body?.technicalSummary,5000),method=clip(req.body?.methodology,5000),team=clip(req.body?.teamSummary,3000),amount=Number(req.body?.financialAmount),currency=clip(req.body?.currency,3).toUpperCase(),days=Number(req.body?.durationDays);
 if(summary.length<20||!Number.isFinite(amount)||amount<=0||currency!==t.currency||!Number.isInteger(days)||days<1||days>3650)throw E.validation('بيانات العرض الفني والمالي أو العملة أو المدة غير مكتملة.');
 const id=uid('cftp_');
 db.prepare(`INSERT INTO consulting_firm_tender_proposals (id,tender_id,firm_id,submitted_by,technical_summary,methodology,team_summary,financial_amount,currency,duration_days) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,t.id,firm.id,req.user.id,summary,method||null,team||null,amount,currency,days);
 marketEvent(req.user.id,'firm_tender_proposal',id,'submitted',{tenderId:t.id,firmId:firm.id});
 res.status(201).json({proposal:{id,tenderId:t.id,status:'submitted'},message:'تم إرسال العرض الفني والمالي. يبقى العرض المالي محجوباً عن المكتب الطارح حتى اجتياز التقييم الفني.'});
}));
router.get('/firm-tenders/:id/proposals',wrap(async(req,res)=>{
 const {tender}=firmTenderOwner(req,req.params.id);
 const rows=getDB().prepare(`SELECT p.id,p.firm_id,f.legal_name firm_name,f.country firm_country,p.technical_summary,p.methodology,p.team_summary,p.technical_score,p.status,p.created_at,p.financial_amount,p.currency,p.duration_days FROM consulting_firm_tender_proposals p JOIN consulting_firms f ON f.id=p.firm_id WHERE p.tender_id=? ORDER BY p.created_at`).all(tender.id);
 res.json({tender:{id:tender.id,reference:tender.reference,technicalThreshold:tender.technical_threshold},proposals:rows.map(p=>{const qualified=p.technical_score!==null&&p.technical_score>=tender.technical_threshold;return {...p,financial_amount:qualified?p.financial_amount:undefined,currency:qualified?p.currency:undefined,duration_days:qualified?p.duration_days:undefined,financialOpened:qualified};})});
}));
router.patch('/firm-tender-proposals/:id/evaluation',wrap(async(req,res)=>{
 const db=getDB(),p=db.prepare(`SELECT p.*,t.firm_id owner_firm_id,t.technical_threshold,t.status tender_status FROM consulting_firm_tender_proposals p JOIN consulting_firm_tenders t ON t.id=p.tender_id WHERE p.id=?`).get(req.params.id);
 if(!p)throw E.notFound('العرض غير موجود.');
 const firm=requireFirmManager(req);if(firm.id!==p.owner_firm_id)throw E.notFound('العرض غير موجود.');
 if(p.tender_status!=='open')throw E.conflict('التقييم متاح للعطاء المفتوح فقط.');
 const score=Number(req.body?.technicalScore);
 if(!Number.isFinite(score)||score<0||score>100)throw E.validation('الدرجة الفنية يجب أن تكون من صفر إلى 100.');
 const status=score>=p.technical_threshold?'qualified':'rejected';
 db.prepare('UPDATE consulting_firm_tender_proposals SET technical_score=?,status=?,updated_at=unixepoch() WHERE id=?').run(score,status,p.id);
 marketEvent(req.user.id,'firm_tender_proposal',p.id,'technical_evaluated',{score,status});
 res.json({ok:true,status,financialOpened:status==='qualified',message:status==='qualified'?'اجتاز العرض الفني، وتم فتح بياناته المالية للمكتب الطارح.':'لم يجتز العرض الحد الفني، وبقي العرض المالي محجوباً.'});
}));
router.post('/firm-tenders/:id/award',wrap(async(req,res)=>{
 const {firm,tender}=firmTenderOwner(req,req.params.id),db=getDB();
 if(tender.status!=='open')throw E.conflict('العطاء مغلق أو تمت ترسيته مسبقاً.');
 const p=db.prepare(`SELECT * FROM consulting_firm_tender_proposals WHERE id=? AND tender_id=? AND status='qualified' AND technical_score>=?`).get(clip(req.body?.proposalId,100),tender.id,tender.technical_threshold);
 if(!p)throw E.notFound('يجب اختيار عرض اجتاز التقييم الفني أولاً.');
 const id=uid('csub_'),ref=clip(req.body?.contractReference,80)||('SUB-'+id.slice(-10).toUpperCase());
 db.transaction(()=>{
  db.prepare(`UPDATE consulting_firm_tender_proposals SET status=CASE WHEN id=? THEN 'selected' ELSE CASE WHEN status='qualified' THEN 'rejected' ELSE status END END,updated_at=unixepoch() WHERE tender_id=?`).run(p.id,tender.id);
  db.prepare(`UPDATE consulting_firm_tenders SET status='awarded',updated_at=unixepoch() WHERE id=?`).run(tender.id);
  db.prepare(`INSERT INTO consulting_firm_subcontracts (id,tender_id,proposal_id,owner_firm_id,selected_firm_id,contract_reference,agreed_amount,currency,created_by) VALUES (?,?,?,?,?,?,?,?,?)`).run(id,tender.id,p.id,firm.id,p.firm_id,ref,p.financial_amount,p.currency,req.user.id);
  })();
 marketEvent(req.user.id,'firm_subcontract',id,'awarded',{tenderId:tender.id,selectedFirmId:p.firm_id});
 res.status(201).json({contract:{id,reference:ref,amount:p.financial_amount,currency:p.currency,status:'awarded'},message:'تمت ترسية الخدمة الاستشارية الفرعية وإنشاء سجل التعاقد.'});
}));
router.get('/firm-subcontracts',wrap(async(req,res)=>{
 const firm=requireVerifiedFirm(req);
 const rows=getDB().prepare(`SELECT c.id,c.owner_firm_id,c.selected_firm_id,c.contract_reference,c.agreed_amount,c.currency,c.status,c.created_at,t.reference,t.title tender_title,owner.legal_name owner_firm_name,selected.legal_name selected_firm_name FROM consulting_firm_subcontracts c JOIN consulting_firm_tenders t ON t.id=c.tender_id JOIN consulting_firms owner ON owner.id=c.owner_firm_id JOIN consulting_firms selected ON selected.id=c.selected_firm_id WHERE c.owner_firm_id=? OR c.selected_firm_id=? ORDER BY c.created_at DESC`).all(firm.id,firm.id);
 res.json({contracts:rows});
}));


// Firm team, reporting and subcontract lifecycle. All records are scoped to the authenticated legal firm.
router.get('/firms/me/members',wrap(async(req,res)=>{
 const firm=requireFirmManager(req);
 const rows=getDB().prepare(`SELECT m.id,m.user_id,m.member_role,m.status,m.created_at,u.name,u.email FROM consulting_firm_members m JOIN users u ON u.id=m.user_id WHERE m.firm_id=? ORDER BY CASE m.member_role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,m.created_at`).all(firm.id);
 res.json({members:rows});
}));
router.post('/firms/me/members',wrap(async(req,res)=>{
 const firm=firmFor(req.user.id);requireOwner(req,firm);
 const email=clip(req.body?.email,254).toLowerCase(),role=clip(req.body?.role,20);
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!['manager','staff'].includes(role))throw E.validation('أدخل بريداً صحيحاً واختر مديراً أو موظفاً.');
 const user=getDB().prepare("SELECT id,name,email,role FROM users WHERE email=?").get(email);
 if(!user||user.role!=='consultant')throw E.notFound('يجب أن يكون للمستخدم حساب استشاري مسجل قبل إضافته إلى المكتب.');
 if(user.id===req.user.id)throw E.conflict('أنت مالك المكتب بالفعل.');
 if(getDB().prepare('SELECT id FROM consulting_firm_members WHERE user_id=?').get(user.id))throw E.conflict('هذا المستخدم مرتبط بعضوية مكتب أخرى بالفعل.');
 const id=uid('cfm_');
 getDB().prepare("INSERT INTO consulting_firm_members (id,firm_id,user_id,member_role,status) VALUES (?,?,?,?,'active')").run(id,firm.id,user.id,role);
 marketEvent(req.user.id,'firm_member',id,'added',{firmId:firm.id,role,email:user.email});
 res.status(201).json({member:{id,userId:user.id,email:user.email,name:user.name,role,status:'active'},message:'تمت إضافة العضو إلى المكتب.'});
}));
router.patch('/firms/me/members/:id',wrap(async(req,res)=>{
 const firm=firmFor(req.user.id);requireOwner(req,firm);
 const member=getDB().prepare('SELECT id,user_id,member_role,status FROM consulting_firm_members WHERE id=? AND firm_id=?').get(req.params.id,firm.id);
 if(!member||member.member_role==='owner')throw E.notFound('عضو المكتب غير موجود أو لا يمكن تعديل مالكه.');
 const role=req.body?.role===undefined?member.member_role:clip(req.body.role,20),status=req.body?.status===undefined?member.status:clip(req.body.status,20);
 if(!['manager','staff'].includes(role)||!['active','suspended'].includes(status))throw E.validation('الدور أو الحالة غير صحيحة.');
 getDB().prepare('UPDATE consulting_firm_members SET member_role=?,status=? WHERE id=? AND firm_id=?').run(role,status,member.id,firm.id);
 marketEvent(req.user.id,'firm_member',member.id,'updated',{role,status});
 res.json({ok:true,role,status,message:'تم تحديث صلاحيات العضو.'});
}));
router.get('/reports/summary',wrap(async(req,res)=>{
 const firm=requireFirmManager(req),db=getDB();
 const count=(sql,...args)=>db.prepare(sql).get(...args).n;
 res.json({summary:{
  openMarketRequests:count("SELECT COUNT(*) n FROM consulting_service_requests WHERE status='open' AND (closing_at IS NULL OR closing_at>?)",Math.floor(Date.now()/1000)),
  proposalsSubmitted:count('SELECT COUNT(*) n FROM consulting_proposals WHERE firm_id=?',firm.id),
  awardedClientContracts:count('SELECT COUNT(*) n FROM consulting_contracts WHERE firm_id=?',firm.id),
  ownSubconsultantTenders:count('SELECT COUNT(*) n FROM consulting_firm_tenders WHERE firm_id=?',firm.id),
  receivedSubconsultantProposals:count('SELECT COUNT(*) n FROM consulting_firm_tender_proposals p JOIN consulting_firm_tenders t ON t.id=p.tender_id WHERE t.firm_id=?',firm.id),
  subcontractAwardsMade:count('SELECT COUNT(*) n FROM consulting_firm_subcontracts WHERE owner_firm_id=?',firm.id),
  subcontractAwardsReceived:count('SELECT COUNT(*) n FROM consulting_firm_subcontracts WHERE selected_firm_id=?',firm.id)
 }});
}));
function subcontractForFirmUser(req,id){
 const firm=requireVerifiedFirm(req);
 const row=getDB().prepare('SELECT * FROM consulting_firm_subcontracts WHERE id=? AND (owner_firm_id=? OR selected_firm_id=?)').get(id,firm.id,firm.id);
 if(!row)throw E.notFound('التعاقد الفرعي غير موجود.');
 return {firm,contract:row};
}
router.get('/firm-subcontracts/:id/updates',wrap(async(req,res)=>{
 const {contract}=subcontractForFirmUser(req,req.params.id);
 const rows=getDB().prepare(`SELECT u.id,u.update_type,u.progress_percent,u.note,u.created_at,a.name actor_name FROM consulting_firm_subcontract_updates u JOIN users a ON a.id=u.actor_user_id WHERE u.subcontract_id=? ORDER BY u.created_at,u.id`).all(contract.id);
 res.json({updates:rows});
}));
router.post('/firm-subcontracts/:id/updates',wrap(async(req,res)=>{
 const {contract}=subcontractForFirmUser(req,req.params.id);
 if(!['awarded','active'].includes(contract.status))throw E.conflict('لا يمكن تحديث تعاقد مغلق.');
 const type=clip(req.body?.type,20)||'progress',note=clip(req.body?.note,3000),pct=req.body?.progressPercent==null||req.body?.progressPercent===''?null:Number(req.body.progressPercent);
 if(!['progress','milestone','issue'].includes(type)||note.length<5||(pct!==null&&(!Number.isInteger(pct)||pct<0||pct>100)))throw E.validation('نوع التحديث أو نصه أو نسبة الإنجاز غير صحيحة.');
 const id=uid('csu_');
 getDB().prepare('INSERT INTO consulting_firm_subcontract_updates (id,subcontract_id,actor_user_id,update_type,progress_percent,note) VALUES (?,?,?,?,?,?)').run(id,contract.id,req.user.id,type,pct,note);
 marketEvent(req.user.id,'firm_subcontract',contract.id,'update',{updateId:id,type,progressPercent:pct});
 res.status(201).json({update:{id,type,progressPercent:pct,note},message:'تم تسجيل تحديث التعاقد الفرعي.'});
}));
router.patch('/firm-subcontracts/:id/status',wrap(async(req,res)=>{
 const {firm,contract}=subcontractForFirmUser(req,req.params.id),next=clip(req.body?.status,20),note=clip(req.body?.note,1000);
 if(!['owner','manager'].includes(firm.member_role))throw E.forbidden('تغيير حالة التعاقد متاح لمالك المكتب أو مديره فقط.');
 if(note.length<5)throw E.validation('اكتب ملاحظة توضح تغيير حالة التعاقد.');
 const allowed=(firm.id===contract.selected_firm_id&&contract.status==='awarded'&&next==='active')||(firm.id===contract.owner_firm_id&&contract.status==='active'&&['completed','terminated'].includes(next));
 if(!allowed)throw E.conflict('انتقال الحالة غير مسموح لهذا الطرف أو من الحالة الحالية.');
 getDB().prepare('UPDATE consulting_firm_subcontracts SET status=?,updated_at=unixepoch() WHERE id=?').run(next,contract.id);
 getDB().prepare("INSERT INTO consulting_firm_subcontract_updates (id,subcontract_id,actor_user_id,update_type,note) VALUES (?,?,?,'status',?)").run(uid('csu_'),contract.id,req.user.id,note+' ['+next+']');
 marketEvent(req.user.id,'firm_subcontract',contract.id,'status',{from:contract.status,to:next,note});
 res.json({ok:true,status:next,message:'تم تحديث حالة التعاقد الفرعي.'});
}));
const subcontractDocKinds=['contract','technical','financial','deliverable','report','other'];
router.post('/firm-subcontracts/:id/documents',upload.array('files',5),wrap(async(req,res)=>{
 const {firm,contract}=subcontractForFirmUser(req,req.params.id),kind=clip(req.body?.kind,20);
 if(!subcontractDocKinds.includes(kind))throw E.validation('نوع الوثيقة غير صحيح.');
 const files=req.files||[];if(!files.length)throw E.validation('أرفق ملفاً واحداً على الأقل.');
 const store=S.getStorage(),db=getDB(),created=[];
 for(const file of files){S.assertAllowed(file.originalname,file.size);const id=uid('csdoc_'),key=['consulting-subcontracts',contract.id,firm.id,S.makeStoredName(file.originalname)].join('/');const put=await store.put(key,file.buffer,{mime:file.mimetype||'application/octet-stream',originalName:S.displayName(file.originalname)});db.prepare('INSERT INTO consulting_firm_subcontract_documents (id,subcontract_id,uploaded_by,document_kind,storage_key,storage_driver,original_name,mime,size,checksum) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,contract.id,req.user.id,kind,key,store.DRIVER,S.displayName(file.originalname),file.mimetype||'application/octet-stream',file.size,put.checksum);created.push({id,name:S.displayName(file.originalname),kind,size:file.size});}
 marketEvent(req.user.id,'firm_subcontract',contract.id,'documents_uploaded',{count:created.length});
 res.status(201).json({documents:created,message:'تم رفع وثائق التعاقد الفرعي.'});
}));
router.get('/firm-subcontracts/:id/documents',wrap(async(req,res)=>{
 const {contract}=subcontractForFirmUser(req,req.params.id);
 const rows=getDB().prepare('SELECT id,document_kind,original_name,mime,size,uploaded_at FROM consulting_firm_subcontract_documents WHERE subcontract_id=? ORDER BY uploaded_at DESC').all(contract.id);
 res.json({documents:rows});
}));
router.get('/firm-subcontracts/:id/documents/:docId/download',wrap(async(req,res)=>{
 const {contract}=subcontractForFirmUser(req,req.params.id);
 const d=getDB().prepare('SELECT * FROM consulting_firm_subcontract_documents WHERE id=? AND subcontract_id=?').get(req.params.docId,contract.id);
 if(!d)throw E.notFound('وثيقة التعاقد غير موجودة.');
 const store=d.storage_driver==='s3'?require('../lib/storage/s3'):require('../lib/storage/local');
 if(!(await store.exists(d.storage_key)))throw E.notFound('ملف الوثيقة غير موجود في التخزين.');
 res.setHeader('Content-Type',d.mime||'application/octet-stream');
 res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(d.original_name));
 res.setHeader('Cache-Control','private, no-store');
 const stream=store.stream(d.storage_key);if(d.storage_driver==='s3'){const obj=await stream;obj.body.pipe(res);}else stream.pipe(res);
}));


// Tender and bid attachments for the consultant-to-consultant subcontract market.
const officeTenderDocKinds=['brief','scope','reference','other'];
const officeBidDocKinds=['technical','financial','reference','other'];
router.post('/firm-tenders/:id/documents',upload.array('files',5),wrap(async(req,res)=>{
 const {firm,tender}=firmTenderOwner(req,req.params.id);
 if(tender.status!=='open')throw E.conflict('لا يمكن إضافة وثائق بعد إغلاق العطاء.');
 const kind=clip(req.body?.kind,20);if(!officeTenderDocKinds.includes(kind))throw E.validation('تصنيف وثيقة العطاء غير صحيح.');
 const files=req.files||[];if(!files.length)throw E.validation('أرفق ملفاً واحداً على الأقل.');
 const store=S.getStorage(),db=getDB(),created=[];
 for(const file of files){S.assertAllowed(file.originalname,file.size);const id=uid('cftdoc_'),key=['consulting-firm-tenders',tender.id,'owner',S.makeStoredName(file.originalname)].join('/');const put=await store.put(key,file.buffer,{mime:file.mimetype||'application/octet-stream',originalName:S.displayName(file.originalname)});db.prepare('INSERT INTO consulting_firm_tender_documents (id,tender_id,firm_id,uploaded_by,document_kind,storage_key,storage_driver,original_name,mime,size,checksum) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,tender.id,firm.id,req.user.id,kind,key,store.DRIVER,S.displayName(file.originalname),file.mimetype||'application/octet-stream',file.size,put.checksum);created.push({id,name:S.displayName(file.originalname),kind,size:file.size});}
 marketEvent(req.user.id,'firm_tender',tender.id,'documents_uploaded',{count:created.length});
 res.status(201).json({documents:created,message:'تم إرفاق وثائق العطاء.'});
}));
router.get('/firm-tenders/:id/documents',wrap(async(req,res)=>{
 const firm=requireVerifiedFirm(req),t=getDB().prepare('SELECT * FROM consulting_firm_tenders WHERE id=?').get(req.params.id);
 if(!t)throw E.notFound('العطاء غير موجود.');
 if(t.status!=='open'&&t.firm_id!==firm.id&&!getDB().prepare('SELECT 1 FROM consulting_firm_tender_proposals WHERE tender_id=? AND firm_id=?').get(t.id,firm.id))throw E.notFound('العطاء غير موجود.');
 const rows=getDB().prepare('SELECT id,document_kind,original_name,mime,size,uploaded_at FROM consulting_firm_tender_documents WHERE tender_id=? ORDER BY uploaded_at DESC').all(t.id);
 res.json({documents:rows});
}));
router.get('/firm-tenders/:id/documents/:docId/download',wrap(async(req,res)=>{
 const firm=requireVerifiedFirm(req),t=getDB().prepare('SELECT * FROM consulting_firm_tenders WHERE id=?').get(req.params.id);
 if(!t)throw E.notFound('العطاء غير موجود.');
 if(t.status!=='open'&&t.firm_id!==firm.id&&!getDB().prepare('SELECT 1 FROM consulting_firm_tender_proposals WHERE tender_id=? AND firm_id=?').get(t.id,firm.id))throw E.notFound('العطاء غير موجود.');
 const d=getDB().prepare('SELECT * FROM consulting_firm_tender_documents WHERE id=? AND tender_id=?').get(req.params.docId,t.id);
 if(!d)throw E.notFound('وثيقة العطاء غير موجودة.');
 const store=d.storage_driver==='s3'?require('../lib/storage/s3'):require('../lib/storage/local');
 if(!(await store.exists(d.storage_key)))throw E.notFound('ملف الوثيقة غير موجود في التخزين.');
 res.setHeader('Content-Type',d.mime||'application/octet-stream');res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(d.original_name));res.setHeader('Cache-Control','private, no-store');
 const stream=store.stream(d.storage_key);if(d.storage_driver==='s3'){const obj=await stream;obj.body.pipe(res);}else stream.pipe(res);
}));
function officeBidDocAccess(req,proposalId){
 const firm=requireVerifiedFirm(req),p=getDB().prepare(`SELECT p.*,t.firm_id owner_firm_id,t.status tender_status FROM consulting_firm_tender_proposals p JOIN consulting_firm_tenders t ON t.id=p.tender_id WHERE p.id=?`).get(proposalId);
 if(!p)throw E.notFound('العرض غير موجود.');
 const isBidder=firm.id===p.firm_id,isOwner=firm.id===p.owner_firm_id;
 if(!isBidder&&!isOwner)throw E.notFound('العرض غير موجود.');
 return {firm,proposal:p,isBidder,isOwner,financialOpened:['qualified','selected'].includes(p.status)};
}
router.post('/firm-tender-proposals/:id/documents',upload.array('files',5),wrap(async(req,res)=>{
 const access=officeBidDocAccess(req,req.params.id),{firm,proposal}=access;
 if(!access.isBidder)throw E.forbidden('يرفع المكتب مقدم العرض وثائقه فقط.');
 if(proposal.tender_status!=='open')throw E.conflict('لا يمكن تعديل وثائق العرض بعد إغلاق العطاء.');
 const kind=clip(req.body?.kind,20);if(!officeBidDocKinds.includes(kind))throw E.validation('تصنيف وثيقة العرض غير صحيح.');
 const files=req.files||[];if(!files.length)throw E.validation('أرفق ملفاً واحداً على الأقل.');
 const store=S.getStorage(),db=getDB(),created=[];
 for(const file of files){S.assertAllowed(file.originalname,file.size);const id=uid('cftpdoc_'),key=['consulting-firm-bids',proposal.id,firm.id,kind,S.makeStoredName(file.originalname)].join('/');const put=await store.put(key,file.buffer,{mime:file.mimetype||'application/octet-stream',originalName:S.displayName(file.originalname)});db.prepare('INSERT INTO consulting_firm_tender_proposal_documents (id,tender_id,proposal_id,firm_id,uploaded_by,document_kind,storage_key,storage_driver,original_name,mime,size,checksum) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,proposal.tender_id,proposal.id,firm.id,req.user.id,kind,key,store.DRIVER,S.displayName(file.originalname),file.mimetype||'application/octet-stream',file.size,put.checksum);created.push({id,name:S.displayName(file.originalname),kind,size:file.size});}
 marketEvent(req.user.id,'firm_tender_proposal',proposal.id,'documents_uploaded',{count:created.length});
 res.status(201).json({documents:created,message:'تم رفع وثائق العرض.'});
}));
router.get('/firm-tender-proposals/:id/documents',wrap(async(req,res)=>{
 const access=officeBidDocAccess(req,req.params.id);
 const rows=getDB().prepare('SELECT id,document_kind,original_name,mime,size,uploaded_at FROM consulting_firm_tender_proposal_documents WHERE proposal_id=? ORDER BY uploaded_at DESC').all(access.proposal.id);
 const visible=rows.filter(d=>access.isBidder||d.document_kind!=='financial'||access.financialOpened);
 res.json({documents:visible,financialOpened:access.financialOpened});
}));
router.get('/firm-tender-proposals/:id/documents/:docId/download',wrap(async(req,res)=>{
 const access=officeBidDocAccess(req,req.params.id);
 const d=getDB().prepare('SELECT * FROM consulting_firm_tender_proposal_documents WHERE id=? AND proposal_id=?').get(req.params.docId,access.proposal.id);
 if(!d||(!access.isBidder&&d.document_kind==='financial'&&!access.financialOpened))throw E.notFound('وثيقة العرض غير موجودة.');
 const store=d.storage_driver==='s3'?require('../lib/storage/s3'):require('../lib/storage/local');
 if(!(await store.exists(d.storage_key)))throw E.notFound('ملف الوثيقة غير موجود في التخزين.');
 res.setHeader('Content-Type',d.mime||'application/octet-stream');res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(d.original_name));res.setHeader('Cache-Control','private, no-store');
 const stream=store.stream(d.storage_key);if(d.storage_driver==='s3'){const obj=await stream;obj.body.pipe(res);}else stream.pipe(res);
}));
router.get('/firm-tender-proposals/mine',wrap(async(req,res)=>{
 const firm=requireVerifiedFirm(req);
 const rows=getDB().prepare(`SELECT p.id,p.tender_id,p.technical_summary,p.technical_score,p.status,p.created_at,t.reference,t.title tender_title,t.status tender_status,t.technical_threshold,owner.legal_name owner_firm_name FROM consulting_firm_tender_proposals p JOIN consulting_firm_tenders t ON t.id=p.tender_id JOIN consulting_firms owner ON owner.id=t.firm_id WHERE p.firm_id=? ORDER BY p.created_at DESC`).all(firm.id);
 res.json({proposals:rows});
}));

module.exports=router;
