'use strict';
/** Deterministic DXF takeoff API. Every output is stored as proposed and requires human review. */
const express=require('express');
const crypto=require('node:crypto');
const {getDB,uid}=require('../db');
const {E,wrap}=require('../lib/errors');
const A=require('../lib/auth');
const storage=require('../lib/storage');
const {takeoffDxf}=require('../lib/mmc-ai/dxf-takeoff');
const {summarizeTakeoffLayers}=require('../lib/mmc-ai/drawing-layer-summary');
const {createUserLayer,updateLayer,deleteUserLayer,assignEntityLayer}=require('../lib/mmc-ai/drawing-layer-manager');
const router=express.Router();
const activeTakeoffDocuments=new Set();
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
 const lockKey=req.params.projectId+':'+doc.id;
 if(activeTakeoffDocuments.has(lockKey))return res.status(409).json({error:{code:'TAKEOFF_ALREADY_RUNNING',message:'تحليل هذا المخطط قيد التنفيذ بالفعل. انتظر النتيجة الحالية بدلاً من تشغيل نسخة مكررة.'}});
 activeTakeoffDocuments.add(lockKey);
 try {
 const store=storage.getStorage();
 if(!(await store.exists(doc.storage_key)))throw E.notFound('ملف المخطط غير موجود في التخزين.');
 const raw=await store.get(doc.storage_key);
 if(!Buffer.isBuffer(raw))throw E.validation('تعذر قراءة ملف DXF من التخزين.');
 const sourceSha256=crypto.createHash('sha256').update(raw).digest('hex');
 if(req.query.force!=='1'){
  const previous=db.prepare('SELECT * FROM ai_takeoff_runs WHERE document_id=? ORDER BY created_at DESC LIMIT 1').get(doc.id);
  if(previous){
   const previousSummary=JSON.parse(previous.summary_json||'{}');
   if(previousSummary.sourceSha256===sourceSha256){
    const previousItems=db.prepare('SELECT id,entity_index,entity_type,layer_name,quantity,unit,detail_json,review_status FROM ai_takeoff_items WHERE run_id=? ORDER BY entity_index').all(previous.id);
    return res.status(200).json({run:{id:previous.id,project_id:previous.project_id,document_id:previous.document_id,engine:previous.engine,status:previous.status,units:JSON.parse(previous.units_json),summary:previousSummary,unsupported:JSON.parse(previous.unsupported_json),items:previousItems.map(x=>({...x,detail:JSON.parse(x.detail_json),detail_json:undefined}))},reused:true});
   }
  }
 }
 let result;
 try {
  result=takeoffDxf(raw.toString('utf8'));
 } catch(error) {
  console.error('[mmc-ai][dxf-takeoff][failed]',JSON.stringify({projectId:doc.project_id,documentId:doc.id,fileName:doc.original_name||doc.file_name||null,error:error.message}));
  throw error;
 }
 const runId=uid('aitake_'),savedRows=[];
 db.transaction(()=>{
  db.prepare(`INSERT INTO ai_takeoff_runs(id,project_id,document_id,created_by,engine,status,units_json,summary_json,unsupported_json)
   VALUES(?,?,?,?,?,'needs_review',?,?,?)`).run(runId,doc.project_id,doc.id,req.user.id,result.engine,JSON.stringify(result.units),JSON.stringify({...result.summary,sourceSha256}),JSON.stringify(result.unsupported));
  const add=db.prepare(`INSERT INTO ai_takeoff_items(id,run_id,entity_index,entity_type,layer_name,quantity,unit,detail_json)
   VALUES(?,?,?,?,?,?,?,?)`);
  for(const row of result.rows){const itemId=uid('aitem_');add.run(itemId,runId,row.entityIndex,row.entity,row.layer||'0',row.quantity,row.unit,JSON.stringify(row));savedRows.push({...row,id:itemId,review_status:'needs_review'});}
  db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json)
   VALUES(?,?,?,?,?,?,?)`).run(uid('aial_'),doc.project_id,req.user.id,'dxf_takeoff_created','takeoff_run',runId,JSON.stringify({documentId:doc.id,engine:result.engine,items:result.rows.length}));
 })();
 console.info('[mmc-ai][dxf-takeoff][completed]',JSON.stringify({projectId:doc.project_id,documentId:doc.id,runId,engine:result.engine,readableEntities:result.summary.supportedEntities,unsupportedEntities:result.summary.unsupportedEntities,unsupportedTypes:result.unsupported,runStatus:'needs_review',savedItems:savedRows.length}));
 res.status(201).json({run:{id:runId,project_id:doc.project_id,document_id:doc.id,engine:result.engine,status:'needs_review',units:result.units,summary:result.summary,unsupported:result.unsupported,limitations:result.limitations,items:savedRows}});
 } finally { activeTakeoffDocuments.delete(lockKey); }
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
router.get('/projects/:projectId/takeoff/runs/:runId/layers',wrap(async(req,res)=>{
 requireMember(req);
 const db=getDB(),run=db.prepare('SELECT id FROM ai_takeoff_runs WHERE id=? AND project_id=?').get(req.params.runId,req.params.projectId);
 if(!run)throw E.notFound('نتيجة الحصر غير موجودة.');
 const items=db.prepare('SELECT entity_type,layer_name,quantity,unit,detail_json FROM ai_takeoff_items WHERE run_id=? ORDER BY entity_index').all(run.id)
  .map(item=>({...item,detail:JSON.parse(item.detail_json)}));
 const nativeLayers=summarizeTakeoffLayers(items);
 const state=loadRunLayerState(db,run.id);
 const layers=[...nativeLayers,...state.layers];
 res.setHeader('Cache-Control','no-store');
 res.json({runId:run.id,layers,assignments:state.assignments,notice:'أسماء الطبقات الأصلية محفوظة كما وردت في DXF؛ الطبقات المنشأة والتصنيفات تنظيمية ولا تغير هندسة المصدر.'});
}));

function loadRunLayerState(db,runId){
 const run=db.prepare('SELECT summary_json FROM ai_takeoff_runs WHERE id=?').get(runId);
 const summary=JSON.parse(run.summary_json||'{}');
 return {summary,layers:Array.isArray(summary.mmcLayerOverlay)?summary.mmcLayerOverlay:[],assignments:Array.isArray(summary.mmcLayerAssignments)?summary.mmcLayerAssignments:[]};
}
function saveRunLayerState(db,projectId,runId,userId,state,action){
 db.prepare('UPDATE ai_takeoff_runs SET summary_json=? WHERE id=?').run(JSON.stringify({...state.summary,mmcLayerOverlay:state.layers,mmcLayerAssignments:state.assignments}),runId);
 db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)')
 .run(uid('aial_'),projectId,userId,action,'takeoff_run',runId,JSON.stringify({userLayers:state.layers.length,assignments:state.assignments.length}));
}
router.post('/projects/:projectId/takeoff/runs/:runId/layers',wrap(async(req,res)=>{
 const m=requireMember(req);if(!['owner','project_manager','engineer','quantity_surveyor'].includes(m.role))throw E.forbidden('لا تملك صلاحية إنشاء طبقات.');
 const db=getDB(),run=db.prepare('SELECT id FROM ai_takeoff_runs WHERE id=? AND project_id=?').get(req.params.runId,req.params.projectId);
 if(!run)throw E.notFound('نتيجة الحصر غير موجودة.');
 const state=loadRunLayerState(db,run.id);
 const nativeNames=db.prepare('SELECT DISTINCT layer_name FROM ai_takeoff_items WHERE run_id=?').all(run.id).map(x=>String(x.layer_name||'0').toLocaleLowerCase('en-US'));
 if(nativeNames.includes(String(req.body?.name||'').trim().toLocaleLowerCase('en-US')))throw E.validation('اسم الطبقة موجود ضمن طبقات CAD الأصلية.');
 try{state.layers=createUserLayer(state.layers,req.body||{});}catch(err){throw E.validation(err.message);}
 saveRunLayerState(db,req.params.projectId,run.id,req.user.id,state,'takeoff_layer_created');
 res.status(201).json({layers:state.layers});
}));
router.patch('/projects/:projectId/takeoff/runs/:runId/layers/:layerId',wrap(async(req,res)=>{
 const m=requireMember(req);if(!['owner','project_manager','engineer','quantity_surveyor'].includes(m.role))throw E.forbidden('لا تملك صلاحية تعديل الطبقات.');
 const db=getDB(),run=db.prepare('SELECT id FROM ai_takeoff_runs WHERE id=? AND project_id=?').get(req.params.runId,req.params.projectId);
 if(!run)throw E.notFound('نتيجة الحصر غير موجودة.');
 const state=loadRunLayerState(db,run.id);
 try{state.layers=updateLayer(state.layers,req.params.layerId,req.body||{});}catch(err){throw E.validation(err.message);}
 saveRunLayerState(db,req.params.projectId,run.id,req.user.id,state,'takeoff_layer_updated');
 res.json({layers:state.layers});
}));
router.delete('/projects/:projectId/takeoff/runs/:runId/layers/:layerId',wrap(async(req,res)=>{
 const m=requireMember(req);if(!['owner','project_manager','engineer','quantity_surveyor'].includes(m.role))throw E.forbidden('لا تملك صلاحية حذف الطبقات.');
 const db=getDB(),run=db.prepare('SELECT id FROM ai_takeoff_runs WHERE id=? AND project_id=?').get(req.params.runId,req.params.projectId);
 if(!run)throw E.notFound('نتيجة الحصر غير موجودة.');
 const state=loadRunLayerState(db,run.id);
 try{state.layers=deleteUserLayer(state.layers,req.params.layerId);}catch(err){throw E.validation(err.message);}
 if(state.assignments.some(x=>x.targetLayerId===req.params.layerId))throw E.validation('انقل العناصر المسندة إلى طبقة أخرى قبل حذف هذه الطبقة.');

 saveRunLayerState(db,req.params.projectId,run.id,req.user.id,state,'takeoff_layer_deleted');
 res.json({layers:state.layers});
}));
router.patch('/projects/:projectId/takeoff/runs/:runId/items/:itemId/layer',wrap(async(req,res)=>{
 const m=requireMember(req);if(!['owner','project_manager','engineer','quantity_surveyor'].includes(m.role))throw E.forbidden('لا تملك صلاحية تصنيف العناصر.');
 const db=getDB(),run=db.prepare('SELECT id FROM ai_takeoff_runs WHERE id=? AND project_id=?').get(req.params.runId,req.params.projectId);
 if(!run)throw E.notFound('نتيجة الحصر غير موجودة.');
 const item=db.prepare('SELECT id FROM ai_takeoff_items WHERE id=? AND run_id=?').get(req.params.itemId,run.id);
 if(!item)throw E.notFound('العنصر غير موجود.');
 const target=String(req.body?.targetLayerId||'');
 const state=loadRunLayerState(db,run.id);
 const validNative=db.prepare('SELECT 1 FROM ai_takeoff_items WHERE run_id=? AND lower(layer_name)=lower(?) LIMIT 1').get(run.id,target.replace(/^native:/,''));
 if(!state.layers.some(x=>x.id===target)&&!validNative)throw E.validation('الطبقة المستهدفة غير موجودة.');
 state.assignments=assignEntityLayer(state.assignments,item.id,target);
 saveRunLayerState(db,req.params.projectId,run.id,req.user.id,state,'takeoff_item_layer_assigned');
 res.json({assignments:state.assignments,notice:'التصنيف محفوظ كطبقة تنظيمية ولا يغير طبقة CAD الأصلية أو هندسة المصدر.'});
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
