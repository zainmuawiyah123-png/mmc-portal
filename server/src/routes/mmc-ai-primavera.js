'use strict';
/**
 * Primavera P6 Professional desktop bridge.
 * This phase provides project configuration, validation and idempotent mapping metadata.
 * It does NOT claim a live desktop connection or emit Oracle-certified XML/XER yet.
 */
const express=require('express');
const crypto=require('crypto');
const {getDB,uid}=require('../db');
const {E,wrap}=require('../lib/errors');
const A=require('../lib/auth');
const router=express.Router();
router.use(A.requireAuth);
const EDIT=new Set(['owner','project_manager','engineer']);
function member(pid,userId){
 return getDB().prepare(`SELECT m.role,p.status FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=?`).get(pid,userId)||null;
}
function access(req,edit=false){
 const m=member(req.params.projectId,req.user.id);
 if(!m||m.status!=='active')throw E.notFound('المشروع غير موجود.');
 if(edit&&!EDIT.has(m.role))throw E.forbidden('لا تملك صلاحية إعداد تكامل Primavera.');
 return m;
}
function audit(db,req,action,entityId,detail){
 db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)')
  .run(uid('aial_'),req.params.projectId,req.user.id,action,'primavera_integration',entityId,JSON.stringify(detail||{}));
}
function ensure(db,pid,userId){
 db.prepare(`INSERT INTO ai_primavera_projects(project_id,created_by) VALUES(?,?) ON CONFLICT(project_id) DO NOTHING`).run(pid,userId);
 return db.prepare('SELECT * FROM ai_primavera_projects WHERE project_id=?').get(pid);
}
router.get('/projects/:projectId/primavera',wrap(async(req,res)=>{
 access(req);const db=getDB(),cfg=ensure(db,req.params.projectId,req.user.id);
 const links=db.prepare('SELECT COUNT(*) AS linked FROM ai_primavera_activity_links WHERE project_id=? AND external_activity_id IS NOT NULL').get(req.params.projectId);
 const runs=db.prepare('SELECT id,direction,status,format,summary_json,error_text,created_at,finished_at FROM ai_primavera_sync_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 20').all(req.params.projectId).map(x=>({...x,summary:JSON.parse(x.summary_json||'{}')}));
 res.setHeader('Cache-Control','no-store');
 res.json({integration:{product:'Primavera P6 Professional',version:'unknown',connectionType:'desktop_file_bridge',enabled:!!cfg.enabled,projectId:cfg.p6_project_id,projectName:cfg.p6_project_name,format:cfg.transfer_format,syncMode:cfg.sync_mode,bridge:{id:cfg.bridge_id,version:cfg.bridge_version,lastSeenAt:cfg.bridge_last_seen_at},linkedActivities:links.linked,connectionStatus:cfg.bridge_last_seen_at?'bridge_seen':'not_connected',capabilities:{projectConfiguration:true,activityMapping:true,boqMapping:true,validationPreview:true,liveDesktopConnection:false,certifiedXmlExport:false,xerExport:false}} ,runs});
}));
router.patch('/projects/:projectId/primavera',wrap(async(req,res)=>{
 access(req,true);const db=getDB(),pid=req.params.projectId,old=ensure(db,pid,req.user.id);
 const enabled=req.body?.enabled===undefined?old.enabled:(req.body.enabled===true?1:req.body.enabled===false?0:null);
 const format=req.body?.format===undefined?old.transfer_format:String(req.body.format).toUpperCase();
 const mode=req.body?.syncMode===undefined?old.sync_mode:String(req.body.syncMode);
 const p6id=req.body?.p6ProjectId===undefined?old.p6_project_id:String(req.body.p6ProjectId||'').trim().slice(0,120)||null;
 const p6name=req.body?.p6ProjectName===undefined?old.p6_project_name:String(req.body.p6ProjectName||'').trim().slice(0,240)||null;
 if(enabled===null||!['XML','XER'].includes(format)||!['manual','approved_only'].includes(mode))throw E.validation('إعدادات Primavera غير صالحة.');
 db.prepare(`UPDATE ai_primavera_projects SET enabled=?,p6_project_id=?,p6_project_name=?,transfer_format=?,sync_mode=?,updated_at=unixepoch() WHERE project_id=?`).run(enabled,p6id,p6name,format,mode,pid);
 audit(db,req,'primavera_settings_updated',pid,{enabled,format,mode,p6ProjectId:p6id,p6ProjectName:p6name});
 res.json({ok:true,integration:{enabled:!!enabled,format,syncMode:mode,p6ProjectId:p6id,p6ProjectName:p6name}});
}));
router.post('/projects/:projectId/primavera/preview',wrap(async(req,res)=>{
 access(req,true);const db=getDB(),pid=req.params.projectId,cfg=ensure(db,pid,req.user.id);
 const allTasks=db.prepare(`SELECT t.*,l.external_activity_id,l.sync_status AS link_status
 FROM ai_schedule_tasks t LEFT JOIN ai_primavera_activity_links l ON l.project_id=t.project_id AND l.schedule_task_id=t.id
 WHERE t.project_id=? ORDER BY t.created_at,t.id`).all(pid);
 // Stable MMC Activity IDs are derived deterministically from the immutable schedule-task ID,
 // then persisted once. This avoids asking planners to type integration identifiers manually.
 const generatedCodes=[];
 const saveCodes=db.transaction(()=>{
  for(const task of allTasks){
   if(String(task.task_code||'').trim())continue;
   const code='MMC'+crypto.createHash('sha256').update(String(task.id)).digest('hex').slice(0,17).toUpperCase();
   const collision=db.prepare('SELECT id FROM ai_schedule_tasks WHERE project_id=? AND task_code=? AND id<>?').get(pid,code,task.id);
   if(collision)throw E.conflict('تعذر إنشاء رمز نشاط فريد تلقائياً؛ راجع رموز الأنشطة المتكررة.');
   db.prepare("UPDATE ai_schedule_tasks SET task_code=?,updated_at=unixepoch() WHERE project_id=? AND id=? AND (task_code IS NULL OR TRIM(task_code)='')").run(code,pid,task.id);
   task.task_code=code;
   generatedCodes.push({taskId:task.id,activityId:code});
  }
 });
 saveCodes();
 if(generatedCodes.length)audit(db,req,'primavera_activity_codes_generated',pid,{generated:generatedCodes});
 const tasks=cfg.sync_mode==='approved_only'?allTasks.filter(t=>!!t.duration_approved_at):allTasks;
 const excludedUnapproved=allTasks.length-tasks.length;
 const includedIds=new Set(tasks.map(t=>t.id));
 const boqLinks=db.prepare(`SELECT x.boq_item_id,x.schedule_task_id,b.item_code,b.description,b.unit,b.quantity
 FROM ai_primavera_boq_links x JOIN ai_boq_items b ON b.id=x.boq_item_id
 WHERE x.project_id=? ORDER BY x.boq_item_id,x.schedule_task_id`).all(pid);
 const boqByTask=new Map();
 for(const x of boqLinks){if(!boqByTask.has(x.schedule_task_id))boqByTask.set(x.schedule_task_id,[]);boqByTask.get(x.schedule_task_id).push(x);}
 const blockers=[],warnings=[],codes=new Set();
 const activities=tasks.map((t,i)=>{
  const code=String(t.task_code||'').trim();
  if(!code)blockers.push({taskId:t.id,issue:'missing_activity_code',message:'أدخل Activity ID/Code ثابتاً قبل التصدير إلى P6.'});
  else if(codes.has(code))blockers.push({taskId:t.id,issue:'duplicate_activity_code',message:'يوجد Activity ID/Code مكرر؛ يجب أن يكون فريداً في المشروع.'});
  if(code)codes.add(code);
  if(!Number.isInteger(Number(t.duration_days))||Number(t.duration_days)<0)blockers.push({taskId:t.id,issue:'invalid_duration',message:'مدة النشاط غير صالحة.'});
  if(!t.duration_approved_at)blockers.push({taskId:t.id,issue:'duration_not_approved',message:'المدة غير معتمدة صراحةً.'});
  const predecessors=JSON.parse(t.predecessors_json||'[]');
  for(const predecessorId of predecessors){
   if(!allTasks.some(x=>x.id===predecessorId))blockers.push({taskId:t.id,issue:'missing_predecessor',message:'علاقة سابقة تشير إلى نشاط غير موجود.'});
   else if(!includedIds.has(predecessorId))blockers.push({taskId:t.id,issue:'excluded_predecessor',message:'النشاط السابق غير معتمد ومستبعد من وضع Approved activities only.'});
  }
  return {mmcTaskId:t.id,activityId:code||null,name:t.name,durationDays:t.duration_days,durationBasis:'approved_working_days',plannedStart:t.planned_start||null,predecessorMmcTaskIds:predecessors,existingP6ActivityId:t.external_activity_id||null,linkStatus:t.link_status||'not_synced',boqItems:boqByTask.get(t.id)||[]};
 });
 const information=[];
 if(!cfg.p6_project_id)information.push({issue:'p6_project_not_mapped',message:'لم يتم ربط Project ID خارجي بعد. هذا ليس مانعاً للمعاينة؛ يُحدد عند إنشاء/اختيار المشروع داخل Primavera قبل التصدير الفعلي.'});
 if(!cfg.enabled)warnings.push({issue:'integration_disabled',message:'التكامل غير مفعّل.'});
 const summary={activities:activities.length,excludedUnapproved,ready:Math.max(0,activities.length-new Set(blockers.map(x=>x.taskId)).size),blockers:blockers.length,warnings:warnings.length,boqMappings:boqLinks.length,alreadyLinked:activities.filter(x=>x.existingP6ActivityId).length};
 const runId=uid('p6run_');
 db.prepare(`INSERT INTO ai_primavera_sync_runs(id,project_id,actor_user_id,direction,status,format,summary_json,finished_at) VALUES(?,?,?,'mmc_to_p6','preview',?,?,unixepoch())`).run(runId,pid,req.user.id,cfg.transfer_format,JSON.stringify(summary));
 audit(db,req,'primavera_export_preview',runId,summary);
 res.setHeader('Cache-Control','no-store');res.json({runId,format:cfg.transfer_format,project:{mmcProjectId:pid,p6ProjectId:cfg.p6_project_id,p6ProjectName:cfg.p6_project_name},summary,blockers,warnings,information,generatedActivityCodes:generatedCodes,activities,exportAvailable:false,message:'هذه معاينة تحقق وربط فقط؛ لا يتم إرسال بيانات إلى برنامج Primavera المكتبي في هذه المرحلة.'});
}));
module.exports=router;
