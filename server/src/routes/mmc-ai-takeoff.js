'use strict';
/** Deterministic DXF takeoff API. Every output is stored as proposed and requires human review. */
const express=require('express');
const {getDB,uid}=require('../db');
const {E,wrap}=require('../lib/errors');
const A=require('../lib/auth');
const storage=require('../lib/storage');
const {takeoffDxf}=require('../lib/mmc-ai/dxf-takeoff');
const router=express.Router();
router.use(A.requireAuth);
function member(projectId,userId){
 return getDB().prepare(`SELECT m.role,p.status FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=?`).get(projectId,userId)||null;
}
function requireMember(req){const m=member(req.params.projectId,req.user.id);if(!m||m.status!=='active')throw E.notFound('المشروع غير موجود.');return m;}
router.post('/projects/:projectId/documents/:documentId/takeoff/dxf',wrap(async(req,res)=>{
 const m=requireMember(req);
 if(!['owner','project_manager','engineer','quantity_surveyor'].includes(m.role))throw E.forbidden('لا تملك صلاحية تشغيل الحصر.');
 const db=getDB(),doc=db.prepare('SELECT * FROM ai_documents WHERE id=? AND project_id=?').get(req.params.documentId,req.params.projectId);
 if(!doc)throw E.notFound('المستند غير موجود.');
 if(doc.file_ext!=='.dxf')throw E.validation('النواة الحالية تقرأ DXF النصي فقط. ملفات PDF وDWG والصور لم تدخل محرك الحصر بعد.');
 const store=storage.getStorage();
 if(!(await store.exists(doc.storage_key)))throw E.notFound('ملف المخطط غير موجود في التخزين.');
 const raw=await store.get(doc.storage_key);
 if(!Buffer.isBuffer(raw))throw E.validation('تعذر قراءة ملف DXF من التخزين.');
 const result=takeoffDxf(raw.toString('utf8'));
 const runId=uid('aitake_');
 db.transaction(()=>{
  db.prepare(`INSERT INTO ai_takeoff_runs(id,project_id,document_id,created_by,engine,status,units_json,summary_json,unsupported_json)
   VALUES(?,?,?,?,?,'needs_review',?,?,?)`).run(runId,doc.project_id,doc.id,req.user.id,result.engine,JSON.stringify(result.units),JSON.stringify(result.summary),JSON.stringify(result.unsupported));
  const add=db.prepare(`INSERT INTO ai_takeoff_items(id,run_id,entity_index,entity_type,layer_name,quantity,unit,detail_json)
   VALUES(?,?,?,?,?,?,?,?)`);
  for(const row of result.rows)add.run(uid('aitem_'),runId,row.entityIndex,row.entity,row.layer||'0',row.quantity,row.unit,JSON.stringify(row));
  db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json)
   VALUES(?,?,?,?,?,?,?)`).run(uid('aial_'),doc.project_id,req.user.id,'dxf_takeoff_created','takeoff_run',runId,JSON.stringify({documentId:doc.id,engine:result.engine,items:result.rows.length}));
 })();
 res.status(201).json({run:{id:runId,project_id:doc.project_id,document_id:doc.id,engine:result.engine,status:'needs_review',units:result.units,summary:result.summary,unsupported:result.unsupported,limitations:result.limitations,items:result.rows.map((row)=>({...row,review_status:'needs_review'}))}});
}));
router.get('/projects/:projectId/takeoff/runs',wrap(async(req,res)=>{
 requireMember(req);
 const db=getDB(),runs=db.prepare(`SELECT id,project_id,document_id,created_by,engine,status,units_json,summary_json,unsupported_json,created_at FROM ai_takeoff_runs WHERE project_id=? ORDER BY created_at DESC`).all(req.params.projectId);
 res.setHeader('Cache-Control','no-store');
 res.json({runs:runs.map(r=>({...r,units:JSON.parse(r.units_json),summary:JSON.parse(r.summary_json),unsupported:JSON.parse(r.unsupported_json),units_json:undefined,summary_json:undefined,unsupported_json:undefined}))});
}));
router.get('/projects/:projectId/takeoff/runs/:runId',wrap(async(req,res)=>{
 requireMember(req);
 const db=getDB(),run=db.prepare('SELECT * FROM ai_takeoff_runs WHERE id=? AND project_id=?').get(req.params.runId,req.params.projectId);
 if(!run)throw E.notFound('نتيجة الحصر غير موجودة.');
 const items=db.prepare('SELECT id,entity_index,entity_type,layer_name,quantity,unit,detail_json,review_status FROM ai_takeoff_items WHERE run_id=? ORDER BY entity_index').all(run.id);
 res.setHeader('Cache-Control','no-store');
 res.json({run:{id:run.id,status:run.status,engine:run.engine,units:JSON.parse(run.units_json),summary:JSON.parse(run.summary_json),unsupported:JSON.parse(run.unsupported_json),created_at:run.created_at},items:items.map(x=>({...x,detail:JSON.parse(x.detail_json),detail_json:undefined}))});
}));
router.patch('/projects/:projectId/takeoff/runs/:runId/review',wrap(async(req,res)=>{
 const m=requireMember(req);
 if(!['owner','project_manager','reviewer'].includes(m.role))throw E.forbidden('اعتماد نتائج الحصر متاح للمراجع أو مدير المشروع أو المالك.');
 const status=String(req.body?.status||'');
 if(!['approved','rejected'].includes(status))throw E.validation('حدد approved أو rejected.');
 const db=getDB(),run=db.prepare('SELECT id FROM ai_takeoff_runs WHERE id=? AND project_id=?').get(req.params.runId,req.params.projectId);
 if(!run)throw E.notFound('نتيجة الحصر غير موجودة.');
 db.transaction(()=>{
  db.prepare('UPDATE ai_takeoff_runs SET status=? WHERE id=?').run(status,run.id);
  db.prepare('UPDATE ai_takeoff_items SET review_status=? WHERE run_id=?').run(status,run.id);
  db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)`)
   .run(uid('aial_'),req.params.projectId,req.user.id,'takeoff_reviewed','takeoff_run',run.id,JSON.stringify({status}));
 })();
 res.json({ok:true,runId:run.id,status});
}));
module.exports=router;
