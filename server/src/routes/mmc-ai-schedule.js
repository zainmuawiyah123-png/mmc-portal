'use strict';
/** Project schedule with dependency validation and deterministic CPM analysis. */
const express=require('express');
const {getDB,uid}=require('../db');
const {E,wrap}=require('../lib/errors');
const A=require('../lib/auth');
const {calculateCriticalPath}=require('../lib/mmc-ai/schedule-engine');
const router=express.Router();router.use(A.requireAuth);
const EDIT=new Set(['owner','project_manager','engineer']);
function member(pid,uid){return getDB().prepare(`SELECT m.role,p.status FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=?`).get(pid,uid)||null;}
function access(req,edit=false){const m=member(req.params.projectId,req.user.id);if(!m||m.status!=='active')throw E.notFound('المشروع غير موجود.');if(edit&&!EDIT.has(m.role))throw E.forbidden('لا تملك صلاحية تعديل البرنامج الزمني.');return m;}
function date(v,label){if(v==null||v==='')return null;const s=String(v);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw E.validation(label+' يجب أن يكون تاريخاً بصيغة YYYY-MM-DD.');return s;}
function getTasks(db,pid){return db.prepare('SELECT * FROM ai_schedule_tasks WHERE project_id=? ORDER BY created_at,id').all(pid).map(t=>({...t,predecessors:JSON.parse(t.predecessors_json)}));}
function audit(db,req,action,id,detail){db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)').run(uid('aial_'),req.params.projectId,req.user.id,action,'schedule_task',id,JSON.stringify(detail||{}));}
function validateGraph(tasks){try{return calculateCriticalPath(tasks);}catch(e){throw E.validation(e.message);}}
function view(task,cpm){return {...task,predecessors:JSON.parse(task.predecessors_json),cpm:cpm.tasks.find(x=>x.id===task.id)||null};}
router.get('/projects/:projectId/schedule',wrap(async(req,res)=>{access(req);const db=getDB(),tasks=getTasks(db,req.params.projectId),cpm=calculateCriticalPath(tasks);res.setHeader('Cache-Control','no-store');res.json({tasks:tasks.map(t=>({...t,cpm:cpm.tasks.find(x=>x.id===t.id)||null})),analysis:{projectDurationWorkingDays:cpm.projectDuration,criticalTaskCount:cpm.criticalTaskCount,method:'CPM · working days · no calendar/holiday adjustment'}});}));
router.post('/projects/:projectId/schedule/tasks',wrap(async(req,res)=>{
 access(req,true);const db=getDB(),name=String(req.body?.name||'').trim().slice(0,240),duration=Number(req.body?.durationDays),pred=Array.isArray(req.body?.predecessors)?[...new Set(req.body.predecessors.map(String))]:[];
 if(name.length<3)throw E.validation('اسم النشاط مطلوب.');if(!Number.isInteger(duration)||duration<0||duration>36500)throw E.validation('مدة النشاط يجب أن تكون أيام عمل صحيحة.');
 const start=date(req.body?.plannedStart,'تاريخ البداية'),id=uid('aisch_'),tasks=getTasks(db,req.params.projectId);
 tasks.push({id,name,duration_days:duration,predecessors:pred});
 const cpm=validateGraph(tasks);
 db.prepare('INSERT INTO ai_schedule_tasks(id,project_id,task_code,name,duration_days,predecessors_json,planned_start,created_by) VALUES(?,?,?,?,?,?,?,?)').run(id,req.params.projectId,String(req.body?.taskCode||'').trim().slice(0,60)||null,name,duration,JSON.stringify(pred),start,req.user.id);
 audit(db,req,'schedule_task_created',id,{duration,pred});
 const row=db.prepare('SELECT * FROM ai_schedule_tasks WHERE id=?').get(id);res.status(201).json({task:view(row,cpm),analysis:{projectDurationWorkingDays:cpm.projectDuration,criticalTaskCount:cpm.criticalTaskCount}});
}));
router.patch('/projects/:projectId/schedule/tasks/:taskId',wrap(async(req,res)=>{
 access(req,true);const db=getDB(),old=db.prepare('SELECT * FROM ai_schedule_tasks WHERE id=? AND project_id=?').get(req.params.taskId,req.params.projectId);if(!old)throw E.notFound('النشاط غير موجود.');
 const name=req.body?.name===undefined?old.name:String(req.body.name).trim().slice(0,240),duration=req.body?.durationDays===undefined?old.duration_days:Number(req.body.durationDays),pred=req.body?.predecessors===undefined?JSON.parse(old.predecessors_json):Array.isArray(req.body.predecessors)?[...new Set(req.body.predecessors.map(String))]:null;
 const start=req.body?.plannedStart===undefined?old.planned_start:date(req.body.plannedStart,'تاريخ البداية'),actualStart=req.body?.actualStart===undefined?old.actual_start:date(req.body.actualStart,'تاريخ البدء الفعلي'),actualFinish=req.body?.actualFinish===undefined?old.actual_finish:date(req.body.actualFinish,'تاريخ الإنجاز الفعلي');
 const pct=req.body?.percentComplete===undefined?old.percent_complete:Number(req.body.percentComplete),status=req.body?.status===undefined?old.status:String(req.body.status);
 if(name.length<3||!Number.isInteger(duration)||duration<0||duration>36500||!pred||!Number.isInteger(pct)||pct<0||pct>100||!['planned','in_progress','completed','blocked'].includes(status))throw E.validation('بيانات النشاط أو الحالة أو نسبة الإنجاز غير صالحة.');
 const tasks=getTasks(db,req.params.projectId).map(t=>t.id===old.id?{...t,name,duration_days:duration,predecessors:pred}:t);const cpm=validateGraph(tasks);
 db.prepare('UPDATE ai_schedule_tasks SET name=?,duration_days=?,predecessors_json=?,planned_start=?,actual_start=?,actual_finish=?,percent_complete=?,status=?,updated_at=unixepoch() WHERE id=? AND project_id=?').run(name,duration,JSON.stringify(pred),start,actualStart,actualFinish,pct,status,old.id,req.params.projectId);
 audit(db,req,'schedule_task_updated',old.id,{duration,pred,pct,status});
 const row=db.prepare('SELECT * FROM ai_schedule_tasks WHERE id=?').get(old.id);res.json({task:view(row,cpm),analysis:{projectDurationWorkingDays:cpm.projectDuration,criticalTaskCount:cpm.criticalTaskCount}});
}));
router.delete('/projects/:projectId/schedule/tasks/:taskId',wrap(async(req,res)=>{
 access(req,true);const db=getDB(),old=db.prepare('SELECT id FROM ai_schedule_tasks WHERE id=? AND project_id=?').get(req.params.taskId,req.params.projectId);if(!old)throw E.notFound('النشاط غير موجود.');
 const tasks=getTasks(db,req.params.projectId);if(tasks.some(t=>t.predecessors.includes(old.id)))throw E.conflict('لا يمكن حذف النشاط لأنه مرتبط بأنشطة لاحقة. أزل علاقات الاعتماد أولاً.');
 db.prepare('DELETE FROM ai_schedule_tasks WHERE id=? AND project_id=?').run(old.id,req.params.projectId);audit(db,req,'schedule_task_deleted',old.id,{});res.json({ok:true,id:old.id});
}));
module.exports=router;
