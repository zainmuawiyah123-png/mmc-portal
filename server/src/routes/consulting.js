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
  return getDB().prepare(`SELECT f.*, m.member_role, m.status member_status FROM consulting_firm_members m JOIN consulting_firms f ON f.id=m.firm_id WHERE m.user_id=? AND m.status='active'`).get(userId) || null;
}
function requireConsultant(req) { if (req.user.role !== 'consultant') throw E.forbidden('هذه الخدمة مخصصة لحسابات المكاتب الاستشارية.'); }
function requireOwner(req, firm) { if (!firm || firm.member_role !== 'owner') throw E.notFound('ملف المكتب غير موجود.'); }

router.get('/me', wrap(async (req,res) => {
  requireConsultant(req);
  const firm=firmFor(req.user.id);
  res.setHeader('Cache-Control','no-store');
  res.json({ firm: firm ? { id:firm.id, legalName:firm.legal_name, country:firm.country, registrationNumber:firm.registration_number, contactEmail:firm.contact_email, contactPhone:firm.contact_phone, specializations:JSON.parse(firm.specializations_json||'[]'), experienceSummary:firm.experience_summary, website:firm.website, verificationStatus:firm.verification_status, verificationNote:firm.verification_note, memberRole:firm.member_role } : null, subscription: { plan:'free', professionalAvailable:false, professionalPrice:20, currency:'USD', billingCycle:'monthly' } });
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
  const rows=getDB().prepare(`SELECT id,legal_name,country,registration_number,contact_email,contact_phone,verification_status,created_at FROM consulting_firms WHERE verification_status='pending' ORDER BY created_at`).all();
  res.json({firms:rows});
}));

router.patch('/admin/firms/:id/verification', A.requireRole('admin'), wrap(async(req,res)=>{
  const status=clip(req.body?.status,20), note=clip(req.body?.note,1000);
  if(!['verified','rejected','suspended','pending'].includes(status)) throw E.validation('حالة التحقق غير صالحة.');
  if(status==='rejected'&&!note) throw E.validation('اذكر سبب رفض التوثيق.');
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

module.exports=router;