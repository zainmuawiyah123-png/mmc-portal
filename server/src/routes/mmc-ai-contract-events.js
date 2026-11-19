'use strict';
/** Contract/claims event register; entries are evidence records, not automated legal opinions. */
const express=require('express');const {getDB,uid}=require('../db');const {E,wrap}=require('../lib/errors');const A=require('../lib/auth');
const router=express.Router();router.use(A.requireAuth);const EDIT=new Set(['owner','project_manager','engineer']);
function member(pid,user){return getDB().prepare('SELECT m.role,p.status FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=?').get(pid,user)||null;}
function access(req,edit=false){const m=member(req.params.projectId,req.user.id);if(!m||m.status!=='active')throw E.notFound('المشروع غير موجود.');if(edit&&!EDIT.has(m.role))throw E.forbidden('لا تملك صلاحية تعديل سجل المطالبات.');return m;}
function clean(v,n){return String(v??'').trim().slice(0,n);}
function date(v,label){if(v==null||v==='')return null;const s=String(v);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw E.validation(label+' يجب أن يكون بصيغة YYYY-MM-DD.');return s;}
function audit(db,req,action,id,detail){db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)').run(uid('aial_'),req.params.projectId,req.user.id,action,'contract_event',id,JSON.stringify(detail||{}));}
function view(x){return {...x,time_impact_days:Number(x.time_impact_days),cost_impact:Number(x.cost_impact)};}
router.get('/projects/:projectId/contract-events',wrap(async(req,res)=>{access(req);const rows=getDB().prepare('SELECT * FROM ai_contract_events WHERE project_id=? ORDER BY COALESCE(event_date,notice_date) DESC,created_at DESC').all(req.params.projectId);res.setHeader('Cache-Control','no-store');res.json({events:rows.map(view),summary:{total:rows.length,notices:rows.filter(x=>x.status==='notice_sent').length,underReview:rows.filter(x=>x.status==='under_review').length,timeImpactDays:rows.reduce((s,x)=>s+Number(x.time_impact_days),0),costImpact:rows.reduce((s,x)=>s+Number(x.cost_impact),0)}});}));
router.post('/projects/:projectId/contract-events',wrap(async(req,res)=>{access(req,true);const title=clean(req.body?.title,240),particulars=clean(req.body?.particulars,6000),days=Number(req.body?.timeImpactDays??0),cost=Number(req.body?.costImpact??0);if(title.length<3||particulars.length<5)throw E.validation('عنوان الحدث وتفاصيله مطلوبان.');if(!Number.isInteger(days)||days<0||days>36500||!Number.isFinite(cost)||cost<0||cost>1e12)throw E.validation('أثر الوقت أو التكلفة غير صالح.');const notice=date(req.body?.noticeDate,'تاريخ الإشعار'),event=date(req.body?.eventDate,'تاريخ الحدث'),id=uid('aice_'),db=getDB();db.prepare('INSERT INTO ai_contract_events(id,project_id,event_code,title,event_type,fidic_clause,notice_date,event_date,particulars,time_impact_days,cost_impact,currency,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,req.params.projectId,clean(req.body?.eventCode,60)||null,title,clean(req.body?.eventType,80)||'general',clean(req.body?.fidicClause,80)||null,notice,event,particulars,days,cost,clean(req.body?.currency,8)||'JOD',req.user.id);audit(db,req,'contract_event_created',id,{days,cost});res.status(201).json({event:view(db.prepare('SELECT * FROM ai_contract_events WHERE id=?').get(id))});}));
router.patch('/projects/:projectId/contract-events/:eventId',wrap(async(req,res)=>{access(req,true);const db=getDB(),old=db.prepare('SELECT * FROM ai_contract_events WHERE id=? AND project_id=?').get(req.params.eventId,req.params.projectId);if(!old)throw E.notFound('سجل الحدث غير موجود.');const title=req.body?.title===undefined?old.title:clean(req.body.title,240),part=req.body?.particulars===undefined?old.particulars:clean(req.body.particulars,6000),days=req.body?.timeImpactDays===undefined?old.time_impact_days:Number(req.body.timeImpactDays),cost=req.body?.costImpact===undefined?old.cost_impact:Number(req.body.costImpact),status=req.body?.status===undefined?old.status:String(req.body.status);const notice=req.body?.noticeDate===undefined?old.notice_date:date(req.body.noticeDate,'تاريخ الإشعار'),event=req.body?.eventDate===undefined?old.event_date:date(req.body.eventDate,'تاريخ الحدث');if(title.length<3||part.length<5||!Number.isInteger(days)||days<0||!Number.isFinite(cost)||cost<0||!['draft','notice_sent','submitted','under_review','agreed','rejected','closed'].includes(status))throw E.validation('بيانات الحدث أو حالته غير صالحة.');db.prepare('UPDATE ai_contract_events SET title=?,particulars=?,time_impact_days=?,cost_impact=?,notice_date=?,event_date=?,status=?,updated_at=unixepoch() WHERE id=? AND project_id=?').run(title,part,days,cost,notice,event,status,old.id,req.params.projectId);audit(db,req,'contract_event_updated',old.id,{days,cost,status});res.json({event:view(db.prepare('SELECT * FROM ai_contract_events WHERE id=?').get(old.id))});}));

router.get('/projects/:projectId/contract',wrap(async(req,res)=>{
  access(req);
  const contract=getDB().prepare('SELECT * FROM ai_project_contracts WHERE project_id=?').get(req.params.projectId)||null;
  res.setHeader('Cache-Control','no-store');
  res.json({contract});
}));
router.put('/projects/:projectId/contract',wrap(async(req,res)=>{
  access(req,true);
  const b=req.body||{},db=getDB();
  const text=(v,n)=>clean(v,n)||null;
  const number=(v,label,max=1e12)=>{
    if(v===undefined||v===null||v==='')return null;
    const n=Number(v);if(!Number.isFinite(n)||n<0||n>max)throw E.validation(label+' غير صالح.');
    return n;
  };
  const dateValue=(v,label)=>date(v,label);
  const contractNumber=text(b.contractNumber,100),title=clean(b.title,240);
  if(title.length<3)throw E.validation('اسم العقد مطلوب (3 أحرف على الأقل).');
  const value=number(b.contractValue,'قيمة العقد');
  const defects=number(b.defectsPeriodMonths,'مدة فترة العيوب',600);
  const status=clean(b.status,30)||'active';
  if(!['draft','active','suspended','completed','terminated'].includes(status))throw E.validation('حالة العقد غير صالحة.');
  const payload={
    contract_number:contractNumber,title,
    employer:text(b.employer,200),contractor:text(b.contractor,200),engineer:text(b.engineer,200),
    contract_form:text(b.contractForm,80),fidic_edition:text(b.fidicEdition,80),
    contract_value:value,currency:text(b.currency,8)||'JOD',
    commencement_date:dateValue(b.commencementDate,'تاريخ المباشرة'),
    completion_date:dateValue(b.completionDate,'تاريخ الإنجاز'),
    defects_period_months:defects,status,created_by:req.user.id
  };
  if(payload.commencement_date&&payload.completion_date&&payload.completion_date<payload.commencement_date)throw E.validation('تاريخ الإنجاز لا يجوز أن يسبق تاريخ المباشرة.');
  const id=uid('aictr_');
  db.prepare(`INSERT INTO ai_project_contracts(id,project_id,contract_number,title,employer,contractor,engineer,contract_form,fidic_edition,contract_value,currency,commencement_date,completion_date,defects_period_months,status,created_by)
    VALUES(@id,@projectId,@contract_number,@title,@employer,@contractor,@engineer,@contract_form,@fidic_edition,@contract_value,@currency,@commencement_date,@completion_date,@defects_period_months,@status,@created_by)
    ON CONFLICT(project_id) DO UPDATE SET contract_number=excluded.contract_number,title=excluded.title,employer=excluded.employer,contractor=excluded.contractor,engineer=excluded.engineer,contract_form=excluded.contract_form,fidic_edition=excluded.fidic_edition,contract_value=excluded.contract_value,currency=excluded.currency,commencement_date=excluded.commencement_date,completion_date=excluded.completion_date,defects_period_months=excluded.defects_period_months,status=excluded.status,updated_at=unixepoch()`).run({id,projectId:req.params.projectId,...payload});
  const saved=db.prepare('SELECT * FROM ai_project_contracts WHERE project_id=?').get(req.params.projectId);
  db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)').run(uid('aial_'),req.params.projectId,req.user.id,'project_contract_saved','contract',saved.id,JSON.stringify({contractNumber:saved.contract_number,status:saved.status}));
  res.json({contract:saved});
}));

module.exports={router};
