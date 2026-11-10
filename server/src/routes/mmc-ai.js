'use strict';
/**
 * MMC AI project workspace. Authorization is based exclusively on explicit
 * ai_project_members rows; a client-supplied project ID never grants access.
 */
const express = require('express');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const router = express.Router();
router.use(A.requireAuth);

const ROLES = new Set(['owner','project_manager','engineer','quantity_surveyor','reviewer','viewer']);
const EDIT_ROLES = new Set(['owner','project_manager','engineer','quantity_surveyor']);
const clip = (v,n) => String(v == null ? '' : v).trim().slice(0,n);

function membership(projectId,userId) {
  return getDB().prepare(`SELECT m.project_id,m.user_id,m.role,p.name,p.description,p.country,p.currency,p.status,p.created_by,p.created_at,p.updated_at
    FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id
    WHERE m.project_id=? AND m.user_id=?`).get(projectId,userId) || null;
}
function requireMember(req) {
  const m=membership(req.params.projectId,req.user.id);
  if(!m) throw E.notFound('المشروع غير موجود.');
  if(m.status!=='active') throw E.notFound('المشروع غير موجود.');
  return m;
}
function requireEditor(req) {
  const m=requireMember(req);
  if(!EDIT_ROLES.has(m.role)) throw E.forbidden('صلاحية العرض فقط؛ لا يمكنك تعديل هذا المشروع.');
  return m;
}
function audit(db,projectId,userId,action,entityType,entityId,detail) {
  db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json)
    VALUES(?,?,?,?,?,?,?)`).run(uid('aial_'),projectId,userId,action,entityType||null,entityId||null,detail?JSON.stringify(detail):null);
}

router.get('/projects',wrap(async(req,res)=>{
  const rows=getDB().prepare(`SELECT p.id,p.name,p.description,p.country,p.currency,p.status,p.created_by,p.created_at,p.updated_at,m.role
    FROM ai_projects p JOIN ai_project_members m ON m.project_id=p.id
    WHERE m.user_id=? ORDER BY p.updated_at DESC`).all(req.user.id);
  res.setHeader('Cache-Control','no-store');
  res.json({projects:rows});
}));

router.post('/projects',wrap(async(req,res)=>{
  const name=clip(req.body?.name,160);
  if(name.length<3) throw E.validation('اسم المشروع مطلوب (3 أحرف على الأقل).');
  const country=clip(req.body?.country,2).toUpperCase()||null;
  if(country&&!['JO','SA','AE'].includes(country)) throw E.validation('الدولة المدعومة: JO أو SA أو AE.');
  const currency=clip(req.body?.currency,3).toUpperCase()||null;
  if(currency&&!['JOD','SAR','AED','USD'].includes(currency)) throw E.validation('العملة غير مدعومة.');
  const db=getDB(),id=uid('aip_');
  db.transaction(()=>{
    db.prepare(`INSERT INTO ai_projects(id,name,description,country,currency,created_by)
      VALUES(?,?,?,?,?,?)`).run(id,name,clip(req.body?.description,3000)||null,country,currency,req.user.id);
    db.prepare(`INSERT INTO ai_project_members(project_id,user_id,role,invited_by) VALUES(?,?,'owner',?)`).run(id,req.user.id,req.user.id);
    audit(db,id,req.user.id,'project_created','project',id,{name});
  })();
  res.status(201).json({project:membership(id,req.user.id)});
}));

router.get('/projects/:projectId/dashboard',wrap(async(req,res)=>{
 const m=requireMember(req),db=getDB(),pid=m.project_id;
 const boq=db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(quantity*rate),0) AS total FROM ai_boq_items WHERE project_id=?').get(pid);
 const risks=db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN probability*impact>=15 THEN 1 ELSE 0 END) AS critical,SUM(CASE WHEN status IN ('open','mitigating') THEN 1 ELSE 0 END) AS active FROM ai_project_risks WHERE project_id=?").get(pid);
 const events=db.prepare("SELECT COUNT(*) AS total,SUM(time_impact_days) AS time_days,SUM(cost_impact) AS cost_total FROM ai_contract_events WHERE project_id=?").get(pid);
 const docs=db.prepare('SELECT COUNT(*) AS total FROM ai_documents WHERE project_id=?').get(pid);
 const bim=db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) AS critical,SUM(CASE WHEN status IN ('open','assigned','in_review') THEN 1 ELSE 0 END) AS open FROM ai_bim_issues WHERE project_id=?").get(pid);
 const photos=db.prepare('SELECT COUNT(*) AS total FROM ai_project_images WHERE project_id=?').get(pid);
 const takeoff=db.prepare("SELECT COUNT(*) AS runs,MAX(created_at) AS last_run FROM ai_takeoff_runs WHERE project_id=?").get(pid);
 const tasks=db.prepare('SELECT * FROM ai_schedule_tasks WHERE project_id=?').all(pid);
 let cpm={projectDuration:0,criticalTaskCount:0};
 if(tasks.length){const {calculateCriticalPath}=require('../lib/mmc-ai/schedule-engine');cpm=calculateCriticalPath(tasks.map(t=>({...t,predecessors:JSON.parse(t.predecessors_json||'[]')})));}
 const totalDuration=tasks.reduce((s,t)=>s+Number(t.duration_days||0),0);
 const progress=totalDuration?Number((tasks.reduce((s,t)=>s+Number(t.duration_days||0)*Number(t.percent_complete||0),0)/totalDuration).toFixed(1)):0;
 const completedTasks=tasks.filter(t=>t.status==='completed').length,blockedTasks=tasks.filter(t=>t.status==='blocked').length,inProgressTasks=tasks.filter(t=>t.status==='in_progress').length;
 res.setHeader('Cache-Control','no-store');
 res.json({project:{id:pid,name:m.name,country:m.country,currency:m.currency,status:m.status},summary:{boqItems:boq.count,estimatedCost:Number(boq.total||0),scheduleTasks:tasks.length,completedTasks,blockedTasks,inProgressTasks,projectDurationWorkingDays:cpm.projectDuration,criticalTasks:cpm.criticalTaskCount,averageTaskProgress:progress,risks:risks.total||0,criticalRisks:risks.critical||0,activeRisks:risks.active||0,contractEvents:events.total||0,recordedTimeImpactDays:events.time_days||0,recordedCostImpact:Number(events.cost_total||0),documents:docs.total||0,bimIssues:bim.total||0,openBimIssues:bim.open||0,criticalBimIssues:bim.critical||0,sitePhotos:photos.total||0,takeoffRuns:takeoff.runs||0,lastTakeoffAt:takeoff.last_run||null}});
}));
router.get('/projects/:projectId',wrap(async(req,res)=>{
  const m=requireMember(req);
  res.setHeader('Cache-Control','no-store');
  const members=getDB().prepare(`SELECT m.user_id,m.role,m.joined_at,u.name
    FROM ai_project_members m JOIN users u ON u.id=m.user_id
    WHERE m.project_id=? ORDER BY m.joined_at`).all(m.project_id);
  res.json({project:m,members});
}));

router.patch('/projects/:projectId',wrap(async(req,res)=>{
  const m=requireEditor(req),db=getDB();
  const name=req.body?.name===undefined?m.name:clip(req.body.name,160);
  if(name.length<3) throw E.validation('اسم المشروع قصير جداً.');
  const description=req.body?.description===undefined?m.description:(clip(req.body.description,3000)||null);
  const status=req.body?.status===undefined?m.status:clip(req.body.status,20);
  if(!['active','archived'].includes(status)) throw E.validation('حالة المشروع غير صحيحة.');
  db.prepare('UPDATE ai_projects SET name=?,description=?,status=?,updated_at=unixepoch() WHERE id=?').run(name,description,status,m.project_id);
  audit(db,m.project_id,req.user.id,'project_updated','project',m.project_id,{name,status});
  res.json({ok:true,project:membership(m.project_id,req.user.id)});
}));

router.post('/projects/:projectId/members',wrap(async(req,res)=>{
  const m=requireMember(req);
  if(!['owner','project_manager'].includes(m.role)) throw E.forbidden('إضافة الأعضاء لمالك المشروع أو مدير المشروع فقط.');
  const userId=clip(req.body?.userId,100),role=clip(req.body?.role,32);
  if(!userId||!ROLES.has(role)||role==='owner') throw E.validation('حدد مستخدماً ودوراً صالحاً؛ لا يمكن إنشاء مالك ثانٍ.');
  const db=getDB();
  if(!db.prepare('SELECT id FROM users WHERE id=?').get(userId)) throw E.notFound('المستخدم غير موجود.');
  try {
    db.prepare('INSERT INTO ai_project_members(project_id,user_id,role,invited_by) VALUES(?,?,?,?)').run(m.project_id,userId,role,req.user.id);
  } catch(err) {
    if(String(err.code||'').startsWith('SQLITE_CONSTRAINT')) throw E.conflict('المستخدم عضو بالفعل أو بيانات العضوية غير صالحة.');
    throw err;
  }
  audit(db,m.project_id,req.user.id,'member_added','project_member',userId,{role});
  res.status(201).json({ok:true,userId,role});
}));

module.exports=router;
