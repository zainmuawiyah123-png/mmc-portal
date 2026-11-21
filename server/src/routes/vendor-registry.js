'use strict';
/** Central vendor registry; entity qualification and invitations are tenant-scoped. */
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const O = require('../lib/org');
const { audit } = require('../lib/audit');
const router = express.Router();
router.use(A.requireAuth);
const clip = (v,n) => String(v == null ? '' : v).trim().slice(0,n);
const jsonArray = (v,max=30) => Array.isArray(v) ? v.map(x=>clip(x,120)).filter(Boolean).slice(0,max) : [];
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const bankKey = () => crypto.createHash('sha256').update(String(config.JWT_SECRET)).digest();
function encryptBank(value) {
  if (!value) return null;
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',bankKey(),iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return [iv.toString('base64'),cipher.getAuthTag().toString('base64'),encrypted.toString('base64')].join('.');
}
function decryptBank(value) {
  if (!value) return null;
  const [iv,tag,data]=value.split('.');
  const decipher=crypto.createDecipheriv('aes-256-gcm',bankKey(),Buffer.from(iv,'base64'));
  decipher.setAuthTag(Buffer.from(tag,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]).toString('utf8'));
}
function profileShape(p, includeBank=false) {
  const result={id:p.id,legalName:p.legal_name,tradingName:p.trading_name,country:p.country,city:p.city,address:p.address,
    registrationNumber:p.registration_number,taxNumber:p.tax_number,website:p.website,contactName:p.contact_name,contactTitle:p.contact_title,
    contactEmail:p.contact_email,contactPhone:p.contact_phone,entityTypes:JSON.parse(p.entity_types_json||'[]'),
    specializations:JSON.parse(p.specializations_json||'[]'),productsServices:JSON.parse(p.products_services_json||'[]'),
    brands:JSON.parse(p.brands_json||'[]'),serviceRegions:JSON.parse(p.service_regions_json||'[]'),
    experienceSummary:p.experience_summary,profileStatus:p.profile_status,createdAt:p.created_at,updatedAt:p.updated_at};
  if(includeBank) result.bankDetails=decryptBank(p.bank_details_enc);
  return result;
}
function ownProfile(userId) { return getDB().prepare('SELECT * FROM vendor_profiles WHERE user_id=?').get(userId)||null; }
function resolveEntity(req) {
  if(req.user.role==='buyer') {
    const m=O.ensureOrg(req.user);
    if(!m||!['manager','procurement'].includes(m.role)) throw E.forbidden('هذه الصلاحية لمدير الجهة أو موظف المشتريات.');
    return {type:'procurement_org',id:m.org_id};
  }
  if(req.user.role==='consultant') {
    const f=getDB().prepare(`SELECT f.id,f.verification_status,m.member_role,m.status member_status FROM consulting_firm_members m JOIN consulting_firms f ON f.id=m.firm_id WHERE m.user_id=?`).get(req.user.id);
    if(!f||f.member_status!=='active'||!['owner','manager'].includes(f.member_role)) throw E.forbidden('يجب أن تكون مالك المكتب أو مديره لإدارة الموردين.');
    if(f.verification_status!=='verified') throw E.forbidden('يجب توثيق المكتب الاستشاري أولاً.');
    return {type:'consulting_firm',id:f.id};
  }
  throw E.forbidden('هذه الخدمة متاحة لجهات المشتريات والمكاتب الاستشارية.');
}
function entityOwns(req,entity) {
  const current=resolveEntity(req);
  if(current.type!==entity.entity_type||current.id!==entity.entity_id) throw E.notFound('السجل غير موجود.');
  return current;
}
function entitySearchSql(entity) {
  return entity.type==='procurement_org'
    ? `SELECT v.* FROM vendor_profiles v WHERE v.profile_status IN ('submitted','verified') ORDER BY v.legal_name LIMIT 200`
    : `SELECT v.* FROM vendor_profiles v WHERE v.profile_status IN ('submitted','verified') ORDER BY v.legal_name LIMIT 200`;
}

router.get('/me',wrap(async(req,res)=>{
  const p=ownProfile(req.user.id);
  res.setHeader('Cache-Control','no-store');
  res.json({profile:p?profileShape(p,true):null});
}));
router.post('/me',wrap(async(req,res)=>{
  if(!['contractor','consultant','supplier','service_provider','manufacturer'].includes(req.user.role)) throw E.forbidden('هذا التسجيل مخصص للشركات والمقاولين والموردين ومقدمي الخدمات.');
  const b=req.body||{},legal=clip(b.legalName,180),country=clip(b.country||req.user.country||'JO',2).toUpperCase();
  const email=clip(b.contactEmail||req.user.email,254).toLowerCase(),phone=clip(b.contactPhone,40);
  if(legal.length<3||!/^[A-Z]{2}$/.test(country)||!validEmail(email)||phone.replace(/\D/g,'').length<7) throw E.validation('أدخل الاسم القانوني والدولة والبريد الرسمي ورقم هاتف صحيحاً.');
  const db=getDB(),old=ownProfile(req.user.id),id=old?.id||uid('vnd_');
  const vals=[legal,clip(b.tradingName,180)||null,country,clip(b.city,100)||null,clip(b.address,500)||null,clip(b.registrationNumber,100)||null,clip(b.taxNumber,100)||null,clip(b.website,300)||null,clip(b.contactName,120)||req.user.name,clip(b.contactTitle,120)||null,email,phone,
    JSON.stringify(jsonArray(b.entityTypes,10)),JSON.stringify(jsonArray(b.specializations,40)),JSON.stringify(jsonArray(b.productsServices,80)),JSON.stringify(jsonArray(b.brands,40)),JSON.stringify(jsonArray(b.serviceRegions,40)),clip(b.experienceSummary,5000)||null,
    b.bankDetails!==undefined?encryptBank(b.bankDetails):old?.bank_details_enc||null];
  if(old) db.prepare(`UPDATE vendor_profiles SET legal_name=?,trading_name=?,country=?,city=?,address=?,registration_number=?,tax_number=?,website=?,contact_name=?,contact_title=?,contact_email=?,contact_phone=?,entity_types_json=?,specializations_json=?,products_services_json=?,brands_json=?,service_regions_json=?,experience_summary=?,bank_details_enc=?,profile_status='submitted',updated_at=unixepoch() WHERE id=?`).run(...vals,id);
  else db.prepare(`INSERT INTO vendor_profiles (id,user_id,legal_name,trading_name,country,city,address,registration_number,tax_number,website,contact_name,contact_title,contact_email,contact_phone,entity_types_json,specializations_json,products_services_json,brands_json,service_regions_json,experience_summary,bank_details_enc,profile_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'submitted')`).run(id,req.user.id,...vals);
  db.prepare("UPDATE vendor_invitation_leads SET vendor_id=?,status='registered' WHERE lower(contact_email)=lower(?) AND status='invited'").run(id,email);
  audit({action:old?'vendor_profile_updated':'vendor_profile_submitted',entity:'vendor_profile',entityId:id,userId:req.user.id,ip:req.ip});
  res.status(old?200:201).json({profile:profileShape(db.prepare('SELECT * FROM vendor_profiles WHERE id=?').get(id),true),message:'تم حفظ الملف المركزي. الاعتماد لدى كل جهة يتم بصورة مستقلة.'});
}));
router.get('/directory',wrap(async(req,res)=>{
  const q=clip(req.query.q,120),country=clip(req.query.country,2).toUpperCase(),kind=clip(req.query.type,40);
  let sql=`SELECT * FROM vendor_profiles WHERE profile_status IN ('submitted','verified')`,args=[];
  if(country){sql+=' AND country=?';args.push(country);}
  if(kind){sql+=' AND EXISTS (SELECT 1 FROM json_each(vendor_profiles.entity_types_json) WHERE value=?)';args.push(kind);}
  if(q){sql+=' AND (legal_name LIKE ? OR trading_name LIKE ? OR specializations_json LIKE ? OR products_services_json LIKE ?)';args.push('%'+q+'%','%'+q+'%','%'+q+'%','%'+q+'%');}
  sql+=' ORDER BY legal_name LIMIT 200';
  const rows=getDB().prepare(sql).all(...args);
  res.json({vendors:rows.map(p=>profileShape(p,false)),count:rows.length});
}));
/* Bank details are disclosed only to the owning procurement entity after its own approval, and only to finance/management roles. */
router.get('/payment-details/:vendorId',wrap(async(req,res)=>{
  if(req.user.role!=='buyer') throw E.forbidden('بيانات الدفع متاحة للجهة المشترية فقط.');
  const m=O.ensureOrg(req.user);
  if(!m||!['manager','finance'].includes(m.role)) throw E.forbidden('بيانات الدفع متاحة للمدير أو موظف المالية المخول فقط.');
  const q=getDB().prepare(`SELECT q.id,q.status,v.id vendor_id,v.legal_name,v.bank_details_enc
    FROM vendor_entity_qualifications q JOIN vendor_profiles v ON v.id=q.vendor_id
    WHERE q.vendor_id=? AND q.entity_type='procurement_org' AND q.entity_id=? AND q.status='approved'
    ORDER BY q.updated_at DESC LIMIT 1`).get(clip(req.params.vendorId,100),m.org_id);
  if(!q) throw E.notFound('لا توجد موافقة اعتماد سارية لهذا المورد لدى جهتكم.');
  res.setHeader('Cache-Control','no-store');
  audit({action:'vendor_bank_details_viewed',entity:'vendor_profile',entityId:q.vendor_id,userId:req.user.id,ip:req.ip});
  res.json({vendorId:q.vendor_id,legalName:q.legal_name,bankDetails:decryptBank(q.bank_details_enc)});
}));
router.get('/qualifications',wrap(async(req,res)=>{
  const entity=resolveEntity(req),rows=getDB().prepare(`SELECT q.*,v.legal_name,v.country,v.registration_number,v.contact_email,v.contact_phone FROM vendor_entity_qualifications q JOIN vendor_profiles v ON v.id=q.vendor_id WHERE q.entity_type=? AND q.entity_id=? ORDER BY q.updated_at DESC`).all(entity.type,entity.id);
  res.json({qualifications:rows});
}));
router.post('/qualifications',wrap(async(req,res)=>{
  const entity=resolveEntity(req),b=req.body||{},vendorId=clip(b.vendorId,100),kind=clip(b.qualificationType,40);
  if(!['contractor','supplier','service_provider','consultant','manufacturer','equipment_provider'].includes(kind)) throw E.validation('نوع التأهيل غير صحيح.');
  const vendor=getDB().prepare('SELECT id FROM vendor_profiles WHERE id=? AND profile_status IN (\'submitted\',\'verified\')').get(vendorId);
  if(!vendor) throw E.notFound('ملف المورد غير موجود أو لم يستكمل التسجيل.');
  const id=uid('vqual_');
  getDB().prepare(`INSERT INTO vendor_entity_qualifications (id,vendor_id,entity_type,entity_id,qualification_type,status,requested_documents_json,entity_data_json) VALUES (?,?,?,?,?,'pending',?,?) ON CONFLICT(vendor_id,entity_type,entity_id,qualification_type) DO UPDATE SET status='pending',requested_documents_json=excluded.requested_documents_json,entity_data_json=excluded.entity_data_json,updated_at=unixepoch()`).run(id,vendorId,entity.type,entity.id,kind,JSON.stringify(jsonArray(b.requestedDocuments,30)),JSON.stringify(b.entityData&&typeof b.entityData==='object'?b.entityData:{}));
  const q=getDB().prepare('SELECT id FROM vendor_entity_qualifications WHERE vendor_id=? AND entity_type=? AND entity_id=? AND qualification_type=?').get(vendorId,entity.type,entity.id,kind);
  getDB().prepare('INSERT INTO vendor_qualification_events (id,qualification_id,actor_user_id,action,note) VALUES (?,?,?,\'requested\',?)').run(uid('vqev_'),q.id,req.user.id,clip(b.notes,1000)||null);
  audit({action:'vendor_qualification_requested',entity:'vendor_qualification',entityId:q.id,userId:req.user.id,ip:req.ip});
  res.status(201).json({qualification:{id:q.id,status:'pending'},message:'تم إرسال طلب التأهيل إلى المورد.'});
}));
router.patch('/qualifications/:id',wrap(async(req,res)=>{
  const entity=resolveEntity(req),db=getDB(),q=db.prepare('SELECT * FROM vendor_entity_qualifications WHERE id=? AND entity_type=? AND entity_id=?').get(req.params.id,entity.type,entity.id);
  if(!q) throw E.notFound('طلب التأهيل غير موجود.');
  const status=clip(req.body?.status,30),allowed=['approved','conditionally_approved','rejected','suspended','expired','pending'];
  if(!allowed.includes(status)) throw E.validation('حالة الاعتماد غير صحيحة.');
  const note=clip(req.body?.notes,2000)||null;
  db.prepare('UPDATE vendor_entity_qualifications SET status=?,notes=?,reviewed_by=?,reviewed_at=unixepoch(),updated_at=unixepoch() WHERE id=?').run(status,note,req.user.id,q.id);
  db.prepare('INSERT INTO vendor_qualification_events (id,qualification_id,actor_user_id,action,note) VALUES (?,?,?,?,?)').run(uid('vqev_'),q.id,req.user.id,status,note);
  audit({action:'vendor_qualification_'+status,entity:'vendor_qualification',entityId:q.id,userId:req.user.id,ip:req.ip});
  res.json({ok:true,status,message:'تم تحديث حالة اعتماد المورد لدى جهتكم فقط.'});
}));
router.get('/invitations',wrap(async(req,res)=>{
  if(req.user.role==='buyer'||req.user.role==='consultant') {
    const entity=resolveEntity(req);
    const rows=getDB().prepare('SELECT i.*,v.legal_name,v.contact_email,v.country FROM vendor_invitations i JOIN vendor_profiles v ON v.id=i.vendor_id WHERE i.entity_type=? AND i.entity_id=? ORDER BY i.created_at DESC').all(entity.type,entity.id);
    const leads=getDB().prepare('SELECT * FROM vendor_invitation_leads WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC').all(entity.type,entity.id);
    return res.json({invitations:rows,unregisteredInvitations:leads});
  }
  const p=ownProfile(req.user.id),email=String(req.user.email||'').toLowerCase();
  const rows=p?getDB().prepare('SELECT i.*,v.legal_name FROM vendor_invitations i JOIN vendor_profiles v ON v.id=i.vendor_id WHERE i.vendor_id=? ORDER BY i.created_at DESC').all(p.id):[];
  const leads=getDB().prepare('SELECT * FROM vendor_invitation_leads WHERE lower(contact_email)=? ORDER BY created_at DESC').all(email);
  res.json({invitations:rows,registrationInvitations:leads});
}));
router.post('/invitations',wrap(async(req,res)=>{
  const entity=resolveEntity(req),b=req.body||{},vendorId=clip(b.vendorId,100),title=clip(b.tenderTitle,240),kind=clip(b.qualificationType,40);
  if(!title||!['contractor','supplier','service_provider','consultant','manufacturer','equipment_provider'].includes(kind)) throw E.validation('بيانات الدعوة غير مكتملة.');
  const db=getDB();
  if(vendorId) {
    const v=db.prepare("SELECT id FROM vendor_profiles WHERE id=? AND profile_status IN ('submitted','verified')").get(vendorId);
    if(!v) throw E.notFound('المورد غير موجود في الدليل المركزي.');
    const id=uid('vinv_');
    db.prepare('INSERT INTO vendor_invitations (id,vendor_id,entity_type,entity_id,created_by,tender_reference,tender_title,qualification_type,message) VALUES (?,?,?,?,?,?,?,?,?)').run(id,vendorId,entity.type,entity.id,req.user.id,clip(b.tenderReference,100)||null,title,kind,clip(b.message,2000)||null);
    audit({action:'vendor_invitation_sent',entity:'vendor_invitation',entityId:id,userId:req.user.id,ip:req.ip});
    return res.status(201).json({invitation:{id,status:'invited'},message:'تم إنشاء الدعوة من جهتكم.'});
  }
  const email=clip(b.vendorEmail,254).toLowerCase(),company=clip(b.companyName,180),country=clip(b.country||'JO',2).toUpperCase();
  if(!validEmail(email)||company.length<2||!/^[A-Z]{2}$/.test(country)) throw E.validation('للدعوة إلى شركة غير مسجلة أدخل اسم الشركة والبريد الإلكتروني والدولة.');
  const id=uid('vlead_');
  db.prepare('INSERT INTO vendor_invitation_leads (id,entity_type,entity_id,created_by,company_name,contact_email,country,tender_reference,tender_title,qualification_type,message) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,entity.type,entity.id,req.user.id,company,email,country,clip(b.tenderReference,100)||null,title,kind,clip(b.message,2000)||null);
  audit({action:'vendor_registration_invitation_created',entity:'vendor_invitation_lead',entityId:id,userId:req.user.id,ip:req.ip});
  res.status(201).json({invitation:{id,status:'invited'},message:'تم تسجيل دعوة الشركة غير المسجلة. ستظهر لها الدعوة عند إنشاء حساب MMC بنفس البريد وإكمال ملف الشركة.'});
}));
router.patch('/invitations/:id/respond',wrap(async(req,res)=>{
  const p=ownProfile(req.user.id),email=String(req.user.email||'').toLowerCase(),status=clip(req.body?.status,20);
  if(!['accepted','declined'].includes(status)) throw E.validation('الرد يجب أن يكون قبولاً أو اعتذاراً.');
  const db=getDB();
  if(p){const r=db.prepare("UPDATE vendor_invitations SET status=?,responded_at=unixepoch() WHERE id=? AND vendor_id=? AND status IN ('invited','profile_required')").run(status,req.params.id,p.id);if(r.changes)return res.json({ok:true,status});}
  const lead=db.prepare("UPDATE vendor_invitation_leads SET status=?,responded_at=unixepoch() WHERE id=? AND lower(contact_email)=? AND status IN ('invited','registered')").run(status,req.params.id,email);
  if(!lead.changes) throw E.notFound('الدعوة غير موجودة أو سبق الرد عليها.');
  res.json({ok:true,status});
}));
router.get('/sources/catalog',wrap(async(req,res)=>{
  const rows=getDB().prepare('SELECT id,country,source_type,source_name,source_url,access_mode,integration_status,fields_available_json,access_notes,last_checked_at FROM vendor_directory_sources ORDER BY country,source_type,source_name').all();
  res.json({sources:rows.map(x=>({...x,fieldsAvailable:JSON.parse(x.fields_available_json||'[]'),fields_available_json:undefined})),notice:'المصادر محددة، لكن الربط الآلي لا يُفعّل قبل موافقة الجهة المالكة أو توفير واجهة رسمية.'});
}));
router.get('/sources',wrap(async(req,res)=>{
  const rows=getDB().prepare('SELECT country,source_type,source_name,source_url,verification_status,verified_at FROM vendor_source_records ORDER BY country,source_type,source_name').all();
  res.json({sources:rows,notice:'تظهر المصادر الرسمية بعد تفعيل الربط المصرح به أو استيراد بيانات معتمد.'});
}));
router.post('/sources',A.requireRole('admin'),wrap(async(req,res)=>{
  const b=req.body||{},vendorId=clip(b.vendorId,100),country=clip(b.country,2).toUpperCase(),type=clip(b.sourceType,40),name=clip(b.sourceName,180);
  if(!vendorId||!/^[A-Z]{2}$/.test(country)||!name||!['contractors_association','engineers_syndicate','consultant_offices_committee','chamber_commerce','chamber_industry','company_registry','other_official'].includes(type)) throw E.validation('بيانات المصدر الرسمي غير مكتملة.');
  if(!getDB().prepare('SELECT id FROM vendor_profiles WHERE id=?').get(vendorId)) throw E.notFound('ملف المورد غير موجود.');
  const id=uid('vsrc_');
  getDB().prepare('INSERT INTO vendor_source_records (id,vendor_id,country,source_type,source_name,source_record_key,source_url,verification_status,verified_at,evidence_note) VALUES (?,?,?,?,?,?,?, ?,CASE WHEN ?=\'confirmed\' THEN unixepoch() ELSE NULL END,?)').run(id,vendorId,country,type,name,clip(b.sourceRecordKey,180)||null,clip(b.sourceUrl,500)||null,clip(b.verificationStatus,20)||'unverified',clip(b.verificationStatus,20)||'unverified',clip(b.evidenceNote,1000)||null);
  res.status(201).json({sourceId:id});
}));
module.exports=router;
