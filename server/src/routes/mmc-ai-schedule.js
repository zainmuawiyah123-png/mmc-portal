'use strict';
/** Project schedule with BOQ linkage, subscriber-controlled durations and deterministic CPM. */
const express=require('express');
const {getDB,uid}=require('../db');
const {E,wrap}=require('../lib/errors');
const A=require('../lib/auth');
const {calculateCriticalPath}=require('../lib/mmc-ai/schedule-engine');
const router=express.Router();router.use(A.requireAuth);
const EDIT=new Set(['owner','project_manager','engineer']);
function member(pid,uid){return getDB().prepare(`SELECT m.role,p.status FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=?`).get(pid,uid)||null;}
function access(req,edit=false){const m=member(req.params.projectId,req.user.id);if(!m||m.status!=='active')throw E.notFound('المشروع غير موجود.');if(edit&&!EDIT.has(m.role))throw E.forbidden('لا تملك صلاحية تعديل البرنامج الزمني.');return m;}
function date(v,label){if(v==null||v==='')return null;const s=String(v);if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw E.validation(label+' يجب أن يكون تاريخاً بصيغة YYYY-MM-DD.');return s;}
function getTasks(db,pid){return db.prepare('SELECT t.*,b.item_code AS boq_item_code,b.description AS boq_item_description,b.unit AS boq_unit,b.quantity AS boq_quantity FROM ai_schedule_tasks t LEFT JOIN ai_boq_items b ON b.id=t.boq_item_id WHERE t.project_id=? ORDER BY t.created_at,t.id').all(pid).map(t=>({...t,predecessors:JSON.parse(t.predecessors_json)}));}
function audit(db,req,action,id,detail){db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)').run(uid('aial_'),req.params.projectId,req.user.id,action,'schedule_task',id,JSON.stringify(detail||{}));}
function validateGraph(tasks){try{return calculateCriticalPath(tasks);}catch(e){throw E.validation(e.message);}}
function view(task,cpm){return {...task,predecessors:JSON.parse(task.predecessors_json),cpm:cpm.tasks.find(x=>x.id===task.id)||null};}
function durationInput(db,pid,body,old){
 const boqItemId=body.boqItemId===undefined?(old?.boq_item_id||null):(String(body.boqItemId||'').trim()||null);
 const source=boqItemId?'boq':'manual';
 let productivity=body.productivityPerDay===undefined?(old?.productivity_per_day??null):(body.productivityPerDay===''||body.productivityPerDay==null?null:Number(body.productivityPerDay));
 let proposed=null;
 if(boqItemId){
  const item=db.prepare('SELECT id,unit,quantity FROM ai_boq_items WHERE id=? AND project_id=?').get(boqItemId,pid);
  if(!item)throw E.validation('بند الكميات المختار غير موجود في هذا المشروع.');
  if(!(item.quantity>0))throw E.validation('كمية بند BOQ يجب أن تكون أكبر من صفر لحساب المدة.');
  if(productivity!==null){
   if(!Number.isFinite(productivity)||productivity<=0)throw E.validation('أدخل إنتاجية يومية صحيحة وبنفس وحدة بند الكميات ('+item.unit+').');
   proposed=Math.ceil(item.quantity/productivity);
  } else if(body.durationDays===undefined&&!old){
   throw E.validation('أدخل إنتاجية يومية لحساب المدة المقترحة، أو أدخل مدة معتمدة يدوياً.');
  }
  if(!Number.isSafeInteger(proposed)||proposed<1)throw E.validation('تعذر حساب المدة المقترحة من الكمية والإنتاجية.');
 } else productivity=null;
 const supplied=body.durationDays!==undefined;
 let duration=supplied?Number(body.durationDays):(old?.duration_days??null);
 if(!Number.isInteger(duration))throw E.validation('المدة المقترحة ليست مدة معتمدة. أدخل مدة أيام العمل التي اعتمدها المخطط صراحةً.');
 if(!Number.isInteger(duration)||duration<0||duration>36500)throw E.validation('مدة النشاط يجب أن تكون أيام عمل صحيحة.');
 const override=source==='boq'&&(proposed===null||duration!==proposed)?1:0;
 const reason=body.durationOverrideReason===undefined?(old?.duration_override_reason||null):String(body.durationOverrideReason||'').trim().slice(0,500)||null;
 return {boqItemId,source,productivity,proposed,duration,override,reason};
}

// Provisional planning productivity library for test use only. Values are editable by the planner
// and are never presented as measured site productivity or a guaranteed production rate.
const PRODUCTIVITY_RULES=[
 {key:'excavation',label:'Earth excavation',units:['m3','m³','cum','م3','م³'],terms:['excavat','حفريات','حفر','excavation'],rate:35,low:20,high:60},
 {key:'backfill',label:'Backfilling and compaction',units:['m3','m³','cum','م3','م³'],terms:['backfill','ردم','دفان'],rate:30,low:18,high:50},
 {key:'concrete',label:'Cast-in-place concrete',units:['m3','m³','cum','م3','م³'],terms:['concrete','خرسانة','صب'],rate:18,low:10,high:30},
 {key:'rebar',label:'Reinforcement steel',units:['ton','tonne','t','طن'],terms:['reinforc','rebar','حديد تسليح','حديد'],rate:2,low:1,high:3.5},
 {key:'formwork',label:'Formwork',units:['m2','m²','sqm','م2','م²'],terms:['formwork','shutter','قوالب','طوبار'],rate:25,low:15,high:40},
 {key:'masonry',label:'Blockwork / masonry',units:['m2','m²','sqm','م2','م²'],terms:['block','masonry','بلوك','طوب','بناء'],rate:18,low:10,high:28},
 {key:'plaster',label:'Plastering',units:['m2','m²','sqm','م2','م²'],terms:['plaster','لياسة','قصارة'],rate:35,low:20,high:50},
 {key:'tiling',label:'Floor or wall tiling',units:['m2','m²','sqm','م2','م²'],terms:['tile','tiling','بلاط','تبليط','سيراميك'],rate:25,low:15,high:35},
 {key:'painting',label:'Painting',units:['m2','m²','sqm','م2','م²'],terms:['paint','دهان','صبغ'],rate:60,low:35,high:90},
 {key:'waterproofing',label:'Waterproofing',units:['m2','m²','sqm','م2','م²'],terms:['waterproof','عزل مائي','عزل'],rate:40,low:25,high:60},
 {key:'pipes',label:'Pipe installation',units:['m','lm','lin.m','م','م.ط'],terms:['pipe','piping','أنابيب','مواسير','تمديدات صحية'],rate:30,low:15,high:45},
 {key:'cables',label:'Cable installation',units:['m','lm','lin.m','م','م.ط'],terms:['cable','كابل','كيبل','أسلاك'],rate:120,low:60,high:180}
];
function estimateProductivity(description,unit){
 const d=String(description||'').toLowerCase().normalize('NFKC');
 const u=String(unit||'').toLowerCase().replace(/\\s+/g,'').replace(/²/g,'2').replace(/³/g,'3');
 const rule=PRODUCTIVITY_RULES.find(x=>x.units.some(v=>v.toLowerCase().replace(/\\s+/g,'').replace(/²/g,'2').replace(/³/g,'3')===u)&&x.terms.some(term=>d.includes(term)));
 if(!rule)return {available:false,reason:'لم أجد تصنيفاً موثوقاً لهذا الوصف والوحدة ضمن مكتبة التقديرات التجريبية. لا توجد إنتاجية مفترضة.'};
 return {available:true,productivityPerDay:rule.rate,range:{low:rule.low,high:rule.high},unitPerDay:String(unit)+'/day',classification:rule.label,source:'MMC provisional test benchmark',confidence:'initial',notice:'قيمة تخطيطية أولية للاختبار وليست إنتاجية موقع مقاسة أو مضمونة. راجعها وعدّلها وفق ظروف المشروع قبل الاعتماد.'};
}
router.post('/projects/:projectId/schedule/productivity-estimate',wrap(async(req,res)=>{
 access(req);const db=getDB(),item=db.prepare('SELECT id,description,unit,quantity FROM ai_boq_items WHERE id=? AND project_id=?').get(String(req.body?.boqItemId||''),req.params.projectId);
 if(!item)throw E.validation('بند BOQ المختار غير موجود في هذا المشروع.');
 if(!(Number(item.quantity)>0))throw E.validation('كمية بند BOQ غير صالحة للتقدير.');
 const estimate=estimateProductivity(item.description,item.unit);
 res.setHeader('Cache-Control','no-store');res.json({item:{id:item.id,description:item.description,unit:item.unit,quantity:item.quantity},estimate:estimate.available?{...estimate,proposedDurationDays:Math.ceil(Number(item.quantity)/estimate.productivityPerDay)}:estimate});
}));

router.get('/projects/:projectId/schedule',wrap(async(req,res)=>{access(req);const db=getDB(),tasks=getTasks(db,req.params.projectId),cpm=calculateCriticalPath(tasks);res.setHeader('Cache-Control','no-store');res.json({tasks:tasks.map(t=>({...t,cpm:cpm.tasks.find(x=>x.id===t.id)||null})),analysis:{projectDurationWorkingDays:cpm.projectDuration,criticalTaskCount:cpm.criticalTaskCount,method:'CPM · working days · no calendar/holiday adjustment'}});}));
router.post('/projects/:projectId/schedule/tasks',wrap(async(req,res)=>{
 access(req,true);const db=getDB(),name=String(req.body?.name||'').trim().slice(0,240),pred=Array.isArray(req.body?.predecessors)?[...new Set(req.body.predecessors.map(String))]:[];
 if(name.length<3)throw E.validation('اسم النشاط مطلوب.');
 const d=durationInput(db,req.params.projectId,req.body||{},null),start=date(req.body?.plannedStart,'تاريخ البداية'),id=uid('aisch_'),tasks=getTasks(db,req.params.projectId);
 tasks.push({id,name,duration_days:d.duration,predecessors:pred});
 const cpm=validateGraph(tasks);
 db.prepare(`INSERT INTO ai_schedule_tasks(id,project_id,task_code,name,duration_days,predecessors_json,planned_start,created_by,boq_item_id,productivity_per_day,proposed_duration_days,duration_source,duration_override,duration_override_reason,duration_approved_by,duration_approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,req.params.projectId,String(req.body?.taskCode||'').trim().slice(0,60)||null,name,d.duration,JSON.stringify(pred),start,req.user.id,d.boqItemId,d.productivity,d.proposed,d.source,d.override,d.reason,req.user.id,Math.floor(Date.now()/1000));
 audit(db,req,'schedule_task_created',id,{duration:d.duration,proposedDuration:d.proposed,source:d.source,boqItemId:d.boqItemId,productivity:d.productivity,override:d.override,reason:d.reason,pred});
 const row=db.prepare('SELECT * FROM ai_schedule_tasks WHERE id=?').get(id);res.status(201).json({task:view(row,cpm),analysis:{projectDurationWorkingDays:cpm.projectDuration,criticalTaskCount:cpm.criticalTaskCount}});
}));
router.patch('/projects/:projectId/schedule/tasks/:taskId',wrap(async(req,res)=>{
 access(req,true);const db=getDB(),old=db.prepare('SELECT * FROM ai_schedule_tasks WHERE id=? AND project_id=?').get(req.params.taskId,req.params.projectId);if(!old)throw E.notFound('النشاط غير موجود.');
 const name=req.body?.name===undefined?old.name:String(req.body.name).trim().slice(0,240),pred=req.body?.predecessors===undefined?JSON.parse(old.predecessors_json):Array.isArray(req.body.predecessors)?[...new Set(req.body.predecessors.map(String))]:null;
 const durationChanged=req.body?.durationDays!==undefined||req.body?.boqItemId!==undefined||req.body?.productivityPerDay!==undefined;
 const d=durationChanged?durationInput(db,req.params.projectId,req.body||{},old):{boqItemId:old.boq_item_id,source:old.duration_source||'manual',productivity:old.productivity_per_day,proposed:old.proposed_duration_days,duration:old.duration_days,override:old.duration_override||0,reason:old.duration_override_reason||null};
 const start=req.body?.plannedStart===undefined?old.planned_start:date(req.body.plannedStart,'تاريخ البداية'),actualStart=req.body?.actualStart===undefined?old.actual_start:date(req.body.actualStart,'تاريخ البدء الفعلي'),actualFinish=req.body?.actualFinish===undefined?old.actual_finish:date(req.body.actualFinish,'تاريخ الإنجاز الفعلي');
 const pct=req.body?.percentComplete===undefined?old.percent_complete:Number(req.body.percentComplete),status=req.body?.status===undefined?old.status:String(req.body.status);
 if(name.length<3||!pred||!Number.isInteger(pct)||pct<0||pct>100||!['planned','in_progress','completed','blocked'].includes(status))throw E.validation('بيانات النشاط أو الحالة أو نسبة الإنجاز غير صالحة.');
 const tasks=getTasks(db,req.params.projectId).map(t=>t.id===old.id?{...t,name,duration_days:d.duration,predecessors:pred}:t);const cpm=validateGraph(tasks);
 db.prepare(`UPDATE ai_schedule_tasks SET name=?,duration_days=?,predecessors_json=?,planned_start=?,actual_start=?,actual_finish=?,percent_complete=?,status=?,boq_item_id=?,productivity_per_day=?,proposed_duration_days=?,duration_source=?,duration_override=?,duration_override_reason=?,duration_approved_by=?,duration_approved_at=?,updated_at=unixepoch() WHERE id=? AND project_id=?`).run(name,d.duration,JSON.stringify(pred),start,actualStart,actualFinish,pct,status,d.boqItemId,d.productivity,d.proposed,d.source,d.override,d.reason,durationChanged?req.user.id:old.duration_approved_by,durationChanged?Math.floor(Date.now()/1000):old.duration_approved_at,old.id,req.params.projectId);
 audit(db,req,'schedule_task_updated',old.id,{duration:d.duration,proposedDuration:d.proposed,source:d.source,boqItemId:d.boqItemId,productivity:d.productivity,override:d.override,reason:d.reason,pred,pct,status});
 const row=db.prepare('SELECT * FROM ai_schedule_tasks WHERE id=?').get(old.id);res.json({task:view(row,cpm),analysis:{projectDurationWorkingDays:cpm.projectDuration,criticalTaskCount:cpm.criticalTaskCount}});
}));
router.delete('/projects/:projectId/schedule/tasks/:taskId',wrap(async(req,res)=>{
 access(req,true);const db=getDB(),old=db.prepare('SELECT id FROM ai_schedule_tasks WHERE id=? AND project_id=?').get(req.params.taskId,req.params.projectId);if(!old)throw E.notFound('النشاط غير موجود.');
 const tasks=getTasks(db,req.params.projectId);if(tasks.some(t=>t.predecessors.includes(old.id)))throw E.conflict('لا يمكن حذف النشاط لأنه مرتبط بأنشطة لاحقة. أزل علاقات الاعتماد أولاً.');
 db.prepare('DELETE FROM ai_schedule_tasks WHERE id=? AND project_id=?').run(old.id,req.params.projectId);audit(db,req,'schedule_task_deleted',old.id,{});res.json({ok:true,id:old.id});
}));
module.exports=router;
