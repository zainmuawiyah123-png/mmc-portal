'use strict';
/**
 * Post-award construction forms: contractor drafting + employer/consultant review.
 * Records and immutable revisions are stored in SQLite; logos are small image data URLs.
 */
const express = require('express');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const O = require('../lib/org');

const router = express.Router();
router.use(A.requireAuth);
const db = () => getDB();
const clip = (v, n = 500) => String(v == null ? '' : v).trim().slice(0, n);
const TYPES = new Set([
  'material_submittal','shop_drawing','sample_approval','daily_report','weekly_report',
  'monthly_report','inspection_request','work_acceptance','rfi','site_meeting',
  'snag_list','delay_notice','handover'
]);
const TITLES = {
  material_submittal:'طلب اعتماد مواد', shop_drawing:'طلب اعتماد مخططات تنفيذية',
  sample_approval:'طلب اعتماد عينة', daily_report:'تقرير سير العمل اليومي',
  weekly_report:'تقرير التقدم الأسبوعي', monthly_report:'تقرير التقدم الشهري',
  inspection_request:'طلب فحص واستلام', work_acceptance:'طلب استلام أعمال منفذة',
  rfi:'طلب معلومات فنية (RFI)', site_meeting:'محضر اجتماع موقع',
  snag_list:'قائمة الملاحظات والأعمال المتبقية', delay_notice:'إشعار تأخير أو عائق',
  handover:'طلب استلام ابتدائي / نهائي'
};
function awardAccess(req, awardId) {
  const a = db().prepare(`SELECT a.*, t.name tender_name FROM project_awards a
    JOIN tenders t ON t.id=a.tender_id WHERE a.id=?`).get(awardId);
  if (!a) throw E.notFound('المشروع المحال غير موجود.');
  if (req.user.role === 'contractor' && a.contractor_user_id === req.user.id) return { award:a, side:'contractor' };
  if (req.user.role === 'buyer') {
    const m = O.membership(req.user.id);
    if (m && m.org_id === a.org_id && ['manager','projects','procurement','requester'].includes(m.role)) return { award:a, side:'reviewer', member:m };
  }
  throw E.notFound('المشروع غير موجود.');
}
function formAccess(req, id) {
  const f = db().prepare('SELECT * FROM post_award_forms WHERE id=?').get(id);
  if (!f) throw E.notFound('النموذج غير موجود.');
  const access = awardAccess(req, f.award_id);
  return { form:f, ...access };
}
function logo(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (s.length > 700000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) throw E.validation('الشعار يجب أن يكون PNG أو JPG أو WebP وبحجم مناسب.');
  return s;
}
function snapshot(formId, revision, content, status, userId, note) {
  db().prepare(`INSERT INTO post_award_form_revisions (id,form_id,revision,content_json,status,changed_by,note)
    VALUES (?,?,?,?,?,?,?)`).run(uid('pafr_'), formId, revision, JSON.stringify(content), status, userId, note || null);
}
function event(formId, userId, action, from, to, note) {
  db().prepare(`INSERT INTO post_award_form_events (id,form_id,actor_user_id,action,from_status,to_status,note)
    VALUES (?,?,?,?,?,?,?)`).run(uid('pafe_'), formId, userId, action, from || null, to || null, note || null);
}
function shape(f) {
  return { ...f, content:JSON.parse(f.content_json || '{}'), contractorLogo:f.contractor_logo_data || null,
    consultantLogo:f.consultant_logo_data || null };
}
router.get('/awards', wrap(async (req,res) => {
  if (req.user.role === 'contractor') {
    return res.json({ side:'contractor', awards:db().prepare(`SELECT a.id,a.award_reference,a.contract_reference,a.awarded_at,a.awarded_amount,a.currency,
      t.name tender_name,t.reference tender_reference,t.authority,t.closing,t.notes tender_scope,
      COALESCE((SELECT group_concat(r.title, ' · ') FROM tender_requirements r WHERE r.tender_id=t.id),'') requirements_summary,
      o.name employer_name,u.name contractor_contact,u.company contractor_company,
      po.po_number,po.delivery_start,po.delivery_end,po.payment_terms,po.total_amount po_amount,po.currency po_currency
      FROM project_awards a JOIN tenders t ON t.id=a.tender_id
      LEFT JOIN organizations o ON o.id=a.org_id
      LEFT JOIN users u ON u.id=a.contractor_user_id
      LEFT JOIN purchase_orders po ON po.id=(SELECT p.id FROM purchase_orders p WHERE p.award_id=a.id ORDER BY p.created_at DESC LIMIT 1)
      WHERE a.contractor_user_id=? AND a.status='approved' ORDER BY a.awarded_at DESC`).all(req.user.id) });
  }
  if (req.user.role === 'buyer') {
    const m=O.membership(req.user.id); if(!m) return res.json({awards:[]});
    return res.json({side:'reviewer',awards:db().prepare(`SELECT a.id,a.award_reference,a.contract_reference,a.awarded_at,a.awarded_amount,a.currency,
      t.name tender_name,t.reference tender_reference,t.authority,t.closing,t.notes tender_scope,
      o.name employer_name,u.name contractor_contact,u.company contractor_company,
      po.po_number,po.delivery_start,po.delivery_end,po.payment_terms,po.total_amount po_amount,po.currency po_currency
      FROM project_awards a JOIN tenders t ON t.id=a.tender_id
      LEFT JOIN organizations o ON o.id=a.org_id
      LEFT JOIN users u ON u.id=a.contractor_user_id
      LEFT JOIN purchase_orders po ON po.award_id=a.id
      WHERE a.org_id=? AND a.status='approved' ORDER BY a.awarded_at DESC`).all(m.org_id)});
  }
  throw E.forbidden('هذه المساحة مخصصة للمقاول والجهة المشرفة.');
}));
router.get('/awards/:awardId/forms', wrap(async (req,res) => {
  awardAccess(req, req.params.awardId);
  const rows=db().prepare('SELECT * FROM post_award_forms WHERE award_id=? ORDER BY updated_at DESC').all(req.params.awardId);
  res.json({forms:rows.map(shape)});
}));
router.post('/awards/:awardId/forms', wrap(async (req,res) => {
  const access=awardAccess(req,req.params.awardId);
  if(access.side!=='contractor') throw E.forbidden('إنشاء النماذج متاح للمقاول.');
  const b=req.body||{}, type=clip(b.formType,50);
  if(!TYPES.has(type)) throw E.validation('نوع النموذج غير معتمد.');
  const title=clip(b.title,180)||TITLES[type];
  const number=clip(b.formNumber,80)||('MMC-'+type.toUpperCase().slice(0,5)+'-'+Date.now().toString().slice(-8));
  const content= b.content && typeof b.content==='object' && !Array.isArray(b.content) ? b.content : {};
  if(JSON.stringify(content).length>180000) throw E.validation('محتوى النموذج أكبر من الحد المسموح.');
  const id=uid('paf_');
  db().transaction(()=>{
    db().prepare(`INSERT INTO post_award_forms
      (id,award_id,contractor_user_id,org_id,form_type,form_number,title,project_name,consultant_name,
       contractor_logo_data,consultant_logo_data,content_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,access.award.id,req.user.id,access.award.org_id,type,number,title,
        clip(b.projectName,200)||access.award.tender_name,clip(b.consultantName,200),logo(b.contractorLogo),logo(b.consultantLogo),JSON.stringify(content));
    snapshot(id,1,content,'draft',req.user.id,'إنشاء النموذج');
    event(id,req.user.id,'created',null,'draft','إنشاء النموذج');
  })();
  res.status(201).json({form:shape(db().prepare('SELECT * FROM post_award_forms WHERE id=?').get(id))});
}));
router.patch('/forms/:id', wrap(async (req,res)=>{
  const {form:f,side}=formAccess(req,req.params.id);
  if(side!=='contractor'||f.contractor_user_id!==req.user.id) throw E.forbidden('التعديل متاح للمقاول صاحب المشروع فقط.');
  if(!['draft','changes_requested'].includes(f.status)) throw E.conflict('لا يمكن تعديل النموذج بعد إرساله إلا إذا طلبت الجهة تعديله.');
  const b=req.body||{}, content=b.content&&typeof b.content==='object'&&!Array.isArray(b.content)?b.content:JSON.parse(f.content_json||'{}');
  if(JSON.stringify(content).length>180000) throw E.validation('محتوى النموذج أكبر من الحد المسموح.');
  const revision=f.revision+1;
  db().transaction(()=>{
    db().prepare(`UPDATE post_award_forms SET title=?,project_name=?,consultant_name=?,contractor_logo_data=?,consultant_logo_data=?,
      content_json=?,revision=?,updated_at=unixepoch() WHERE id=?`).run(clip(b.title,180)||f.title,
      clip(b.projectName,200)||f.project_name,clip(b.consultantName,200)||f.consultant_name,
      b.contractorLogo===undefined?f.contractor_logo_data:logo(b.contractorLogo),
      b.consultantLogo===undefined?f.consultant_logo_data:logo(b.consultantLogo),JSON.stringify(content),revision,f.id);
    snapshot(f.id,revision,content,f.status,req.user.id,'حفظ التعديلات');
    event(f.id,req.user.id,'updated',f.status,f.status,'حفظ التعديلات');
  })();
  res.json({form:shape(db().prepare('SELECT * FROM post_award_forms WHERE id=?').get(f.id))});
}));
router.post('/forms/:id/submit', wrap(async(req,res)=>{
  const {form:f,side}=formAccess(req,req.params.id);
  if(side!=='contractor'||f.contractor_user_id!==req.user.id) throw E.forbidden();
  if(!['draft','changes_requested'].includes(f.status)) throw E.conflict('النموذج ليس جاهزاً للإرسال.');
  db().transaction(()=>{
    db().prepare("UPDATE post_award_forms SET status='submitted',submitted_at=unixepoch(),updated_at=unixepoch() WHERE id=?").run(f.id);
    event(f.id,req.user.id,'submitted',f.status,'submitted','إرسال للاعتماد');
  })();
  res.json({form:shape(db().prepare('SELECT * FROM post_award_forms WHERE id=?').get(f.id))});
}));
router.post('/forms/:id/review', wrap(async(req,res)=>{
  const {form:f,side}=formAccess(req,req.params.id);
  if(side!=='reviewer') throw E.forbidden('المراجعة متاحة للجهة المشرفة فقط.');
  if(!['submitted','changes_requested'].includes(f.status)) throw E.conflict('النموذج ليس بانتظار المراجعة.');
  const status=clip(req.body&&req.body.status,40), note=clip(req.body&&req.body.note,2000);
  if(!['approved','rejected','changes_requested'].includes(status)) throw E.validation('قرار المراجعة غير صحيح.');
  if(status!=='approved'&&!note) throw E.validation('يرجى توضيح الملاحظات أو أسباب الرفض.');
  db().transaction(()=>{
    db().prepare('UPDATE post_award_forms SET status=?,reviewed_at=unixepoch(),reviewed_by=?,review_note=?,updated_at=unixepoch() WHERE id=?')
      .run(status,req.user.id,note,f.id);
    event(f.id,req.user.id,'reviewed',f.status,status,note);
  })();
  res.json({form:shape(db().prepare('SELECT * FROM post_award_forms WHERE id=?').get(f.id))});
}));
router.get('/forms/:id/history', wrap(async(req,res)=>{
  formAccess(req,req.params.id);
  const revisions=db().prepare('SELECT revision,status,changed_by,note,created_at FROM post_award_form_revisions WHERE form_id=? ORDER BY revision DESC,created_at DESC').all(req.params.id);
  const events=db().prepare('SELECT actor_user_id,action,from_status,to_status,note,created_at FROM post_award_form_events WHERE form_id=? ORDER BY created_at DESC').all(req.params.id);
  res.json({revisions,events});
}));
router.get('/forms/:id', wrap(async(req,res)=>{
  const {form}=formAccess(req,req.params.id);
  res.json({form:shape(form)});
}));
module.exports=router;
