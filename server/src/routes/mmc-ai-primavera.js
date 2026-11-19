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
// Conservative Primavera P6 API Business Objects XML export.
// P6 stores activity durations in hours; MMC approved working days are converted at 8 hours/day.
function xmlEscape(value){
 return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
function p6Leaf(tag,value){
 return value===undefined||value===null||value===''?'':'<'+tag+'>'+xmlEscape(value)+'</'+tag+'>';
}
function p6Date(day){return day?String(day).slice(0,10)+'T08:00:00':'';}
function p6SafeId(value,fallback,max=40){
 const s=String(value||'').trim().replace(/[|<>]/g,'-').replace(/\s+/g,'-');
 return (s||fallback).slice(0,max);
}
router.post('/projects/:projectId/primavera/export',wrap(async(req,res)=>{
 access(req,true);
 const db=getDB(),pid=req.params.projectId,cfg=ensure(db,pid,req.user.id);
 if(!cfg.enabled)throw E.validation('فعّل إعدادات تكامل Primavera واحفظها قبل التصدير.');
 const all=db.prepare("SELECT t.*,b.item_code AS boq_item_code,b.description AS boq_description,b.unit AS boq_unit,b.quantity AS boq_quantity FROM ai_schedule_tasks t LEFT JOIN ai_boq_items b ON b.id=t.boq_item_id WHERE t.project_id=? ORDER BY t.created_at,t.id").all(pid);
 const tasks=cfg.sync_mode==='approved_only'?all.filter(t=>!!t.duration_approved_at):all;
 const excluded=all.length-tasks.length, included=new Set(tasks.map(t=>t.id));
 const blockers=[],used=new Set();
 for(const t of tasks){
  const code=String(t.task_code||'').trim();
  if(!code)blockers.push('يوجد نشاط بلا Activity ID.');
  else if(used.has(code))blockers.push('يوجد Activity ID مكرر: '+code);
  used.add(code);
  if(!t.duration_approved_at)blockers.push('المدة غير معتمدة للنشاط: '+t.name);
  if(!Number.isInteger(Number(t.duration_days))||Number(t.duration_days)<0)blockers.push('مدة غير صالحة للنشاط: '+t.name);
  for(const pred of JSON.parse(t.predecessors_json||'[]'))if(!included.has(pred))blockers.push('النشاط السابق غير موجود ضمن الأنشطة المصدّرة للنشاط: '+t.name);
 }
 if(blockers.length)throw E.validation('تعذر إنشاء ملف P6 بسبب موانع التحقق:\n'+[...new Set(blockers)].join('\n'));
 if(!tasks.length)throw E.validation('لا توجد أنشطة مؤهلة للتصدير.');
 const project=db.prepare('SELECT name FROM ai_projects WHERE id=?').get(pid);
 const p6ProjectId=p6SafeId(cfg.p6_project_id,'MMC-'+pid);
 const p6ProjectName=String(cfg.p6_project_name||project?.name||'MMC AI Project').replace(/[|<>]/g,' ').slice(0,100);
 const projectObjectId=1,wbsObjectId=2,activityObjectId=new Map(tasks.map((t,i)=>[t.id,100+i]));
 const activities=tasks.map(t=>{
  const id=String(t.task_code).slice(0,40),name=String(t.name||'Activity').slice(0,120),hours=Number(t.duration_days)*8;
  const start=p6Date(t.planned_start);
  const note=t.boq_item_id?'MMC BOQ '+(t.boq_item_code||'')+' | '+(t.boq_description||'')+' | Quantity: '+(t.boq_quantity??'')+' '+(t.boq_unit||''):'';
  return '<Activity>\n'+
   p6Leaf('Id',id)+'\n'+p6Leaf('Name',name)+'\n'+p6Leaf('ObjectId',activityObjectId.get(t.id))+'\n'+
   p6Leaf('PercentCompleteType','Duration')+'\n'+p6Leaf('PlannedDuration',hours)+'\n'+
   (start?p6Leaf('PlannedStartDate',start)+'\n':'')+
   p6Leaf('ProjectObjectId',projectObjectId)+'\n'+p6Leaf('RemainingDuration',hours)+'\n'+
   p6Leaf('Status','Not Started')+'\n'+p6Leaf('Type','Task Dependent')+'\n'+
   p6Leaf('WBSObjectId',wbsObjectId)+'\n</Activity>'+
   (note?'\n<ActivityNote>\n'+p6Leaf('ActivityObjectId',activityObjectId.get(t.id))+'\n'+p6Leaf('Note',note)+'\n'+
    p6Leaf('NotebookTopicObjectId',1)+'\n'+p6Leaf('ObjectId',1000+activityObjectId.get(t.id))+'\n'+
    p6Leaf('ProjectObjectId',projectObjectId)+'\n</ActivityNote>':'');
 }).join('\n');
 let relObjectId=2000;const relationships=[];
 for(const t of tasks)for(const pred of JSON.parse(t.predecessors_json||'[]')){
  relationships.push('<Relationship>\n'+p6Leaf('Lag',0)+'\n'+p6Leaf('ObjectId',relObjectId++)+'\n'+
   p6Leaf('PredecessorActivityObjectId',activityObjectId.get(pred))+'\n'+p6Leaf('PredecessorProjectObjectId',projectObjectId)+'\n'+
   p6Leaf('SuccessorActivityObjectId',activityObjectId.get(t.id))+'\n'+p6Leaf('SuccessorProjectObjectId',projectObjectId)+'\n'+
   p6Leaf('Type','Finish to Start')+'\n</Relationship>');
 }
 const xml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'+
 '<APIBusinessObjects xmlns="http://xmlns.oracle.com/Primavera/P6/V23.12/API/BusinessObjects" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'+
 '<NotebookTopic>\n'+p6Leaf('AvailableForActivity',1)+'\n'+p6Leaf('AvailableForEPS',0)+'\n'+
 p6Leaf('AvailableForProject',0)+'\n'+p6Leaf('AvailableForWBS',0)+'\n'+p6Leaf('Name','MMC BOQ Reference')+'\n'+
 p6Leaf('ObjectId',1)+'\n</NotebookTopic>\n<Project>\n'+p6Leaf('Id',p6ProjectId)+'\n'+p6Leaf('Name',p6ProjectName)+'\n'+
 p6Leaf('ObjectId',projectObjectId)+'\n<WBS>\n'+p6Leaf('Code','MMC-WBS')+'\n'+p6Leaf('Name','MMC AI Schedule')+'\n'+
 p6Leaf('ObjectId',wbsObjectId)+'\n'+p6Leaf('ProjectObjectId',projectObjectId)+'\n'+p6Leaf('SequenceNumber',1)+
 '\n</WBS>\n'+activities+'\n'+relationships.join('\n')+'\n</Project>\n</APIBusinessObjects>';
 const runId=uid('p6run_');
 const summary={activities:tasks.length,excludedUnapproved:excluded,relationships:relationships.length,format:'P6 XML',durationConversion:'8 hours per approved working day',p6ProjectId:p6ProjectId};
 db.prepare("INSERT INTO ai_primavera_sync_runs(id,project_id,actor_user_id,direction,status,format,summary_json,finished_at) VALUES(?,?,?,'mmc_to_p6','succeeded','XML',?,unixepoch())").run(runId,pid,req.user.id,JSON.stringify(summary));
 audit(db,req,'primavera_xml_export_created',runId,summary);
 res.setHeader('Content-Type','application/xml; charset=utf-8');
 res.setHeader('Content-Disposition','attachment; filename="'+p6ProjectId.replace(/[^A-Za-z0-9._-]/g,'_')+'.xml"');
 res.setHeader('Cache-Control','no-store');res.setHeader('X-MMC-P6-Activities',String(tasks.length));
 res.send(xml);
}));

module.exports=router;
