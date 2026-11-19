'use strict';
/** Project BOQ and estimate workspace. No tender/procurement tables are modified. */
const express=require('express');
const multer=require('multer');
const path=require('node:path');
const {parseBoqFile}=require('../lib/mmc-ai/boq-import');
const {getDB,uid}=require('../db');
const {E,wrap}=require('../lib/errors');
const A=require('../lib/auth');
const router=express.Router();
const importUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1,fields:0},fileFilter(req,file,cb){
 const ext=path.extname(file.originalname||'').toLowerCase();
 if(!['.xlsx','.csv'].includes(ext)) return cb(E.validation('يدعم استيراد BOQ ملفات XLSX وCSV فقط.'));
 cb(null,true);
}});
router.use(A.requireAuth);
const EDIT=new Set(['owner','project_manager','engineer','quantity_surveyor']);
function member(projectId,userId){return getDB().prepare(`SELECT m.role,p.status FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=?`).get(projectId,userId)||null;}
function access(req,edit=false){const m=member(req.params.projectId,req.user.id);if(!m||m.status!=='active')throw E.notFound('المشروع غير موجود.');if(edit&&!EDIT.has(m.role))throw E.forbidden('لا تملك صلاحية تعديل جدول الكميات.');return m;}
function audit(db,req,action,itemId,detail){db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)`).run(uid('aial_'),req.params.projectId,req.user.id,action,'boq_item',itemId,JSON.stringify(detail||{}));}
function clean(v,max){return String(v==null?'':v).trim().slice(0,max);}
function number(v,label){const n=Number(v);if(!Number.isFinite(n)||n<0||n>1e12)throw E.validation(label+' يجب أن يكون رقماً موجباً صالحاً.');return n;}
function itemView(x){const rateMissing=Boolean(x.rate_missing)||x.rate===null||x.rate===undefined;return {...x,rate:rateMissing?null:Number(x.rate),rateMissing,line_total:rateMissing?null:Number((x.quantity*x.rate).toFixed(3)),validationIssues:JSON.parse(x.validation_json||'[]')};}
function nullableRate(value,label='سعر الوحدة'){if(value===null||value===undefined||String(value).trim()==='')return null;return number(value,label);}
router.post('/projects/:projectId/boq/import',importUpload.single('file'),wrap(async(req,res)=>{
 access(req,true);
 if(!req.file) throw E.validation('اختر ملف Excel أو CSV أولاً.');
 let parsed;
 try{parsed=parseBoqFile({buffer:req.file.buffer,filename:req.file.originalname});}
 catch(err){throw E.validation(err.message||'تعذر قراءة ملف BOQ.');}
 if(!parsed.items.length) return res.status(422).json({error:'لا توجد بنود صالحة للاستيراد.',summary:parsed.summary,errors:parsed.errors});
 const db=getDB(),created=[];
 const insert=db.prepare(`INSERT INTO ai_boq_items(id,project_id,item_code,description,unit,quantity,rate,created_by,source_sheet,source_row,source_amount,rate_missing,validation_json,section_label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
 const tx=db.transaction(()=>{
  for(const item of parsed.items){
   const id=uid('aiboq_');
   // Preserve a missing source rate as SQL NULL; an explicitly quoted zero remains 0.
   insert.run(id,req.params.projectId,item.itemCode,item.description,item.unit,item.quantity,item.rate,req.user.id,item.sourceSheet||null,item.rowNumber||null,item.sourceAmount??null,item.rate===null?1:0,JSON.stringify(item.validationIssues||[]),item.sectionLabel||null);
   created.push({id,...item,rate:item.rate,rateMissing:item.rate===null});
  }
  db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)`)
   .run(uid('aial_'),req.params.projectId,req.user.id,'boq_items_imported','boq_import',null,JSON.stringify({filename:req.file.originalname,format:parsed.sourceFormat,imported:created.length,errorRows:parsed.errors.length,duplicateRows:parsed.duplicates.length,missingRates:created.filter(x=>x.rateMissing).length,sourceSheets:parsed.sourceSheets,warningRows:parsed.warnings?.length||0}));
 });
 tx();
 res.status(201).json({items:created,summary:{...parsed.summary,imported:created.length,missingRates:created.filter(x=>x.rateMissing).length},errors:parsed.errors,duplicates:parsed.duplicates,warnings:parsed.warnings||[],sourceSheets:parsed.sourceSheets||[],notice:'تم استيراد البنود الصالحة فقط. الصفوف غير الصالحة معروضة في الأخطاء ولم تُسقط بصمت. الأسعار غير الموجودة محفوظة كقيم NULL، والأسعار الصفرية الصريحة محفوظة كصفر.'});
}));
router.get('/projects/:projectId/boq',wrap(async(req,res)=>{
 access(req);
 const rows=getDB().prepare(`SELECT * FROM ai_boq_items WHERE project_id=? ORDER BY created_at,CASE WHEN source_row IS NULL THEN 1 ELSE 0 END,source_sheet,source_row,id`).all(req.params.projectId).map(itemView);
 const total=Number(rows.reduce((s,x)=>s+x.line_total,0).toFixed(3));
 res.setHeader('Cache-Control','no-store');
 res.json({items:rows,summary:{itemCount:rows.length,total,missingRates:rows.filter(x=>x.rate_missing).length}});
}));
router.post('/projects/:projectId/boq/from-takeoff',wrap(async(req,res)=>{
 access(req,true);
 const runId=clean(req.body?.runId,100),category=clean(req.body?.category,80),proposalKey=clean(req.body?.proposalKey,100);
 if(!runId||!category||!proposalKey)throw E.validation('معرّف الحصر والتخصص ومفتاح الكمية المقترحة مطلوبة.');
 const db=getDB();
 const run=db.prepare('SELECT id,status,summary_json FROM ai_takeoff_runs WHERE id=? AND project_id=?').get(runId,req.params.projectId);
 if(!run)throw E.notFound('نتيجة الحصر غير موجودة في هذا المشروع.');
 if(run.status!=='approved')throw E.conflict('يجب اعتماد نتيجة الحصر من المراجع قبل ترحيل أي كمية إلى BOQ.');
 let summary;
 try{summary=JSON.parse(run.summary_json||'{}');}catch{throw E.validation('ملخص الحصر غير صالح.');}
 const categoryResult=(summary.quantityProposals?.results||[]).find(x=>x.category===category);
 if(!categoryResult||categoryResult.status!=='proposed')throw E.conflict('هذه الفئة غير مكتملة ولا تحتوي على كمية قابلة للترحيل.');
 const proposal=(categoryResult.proposed||[]).find(x=>x.key===proposalKey);
 if(!proposal||!Number.isFinite(Number(proposal.value))||Number(proposal.value)<0||!proposal.unit)throw E.validation('مفتاح الكمية غير موجود أو لا يحتوي على كمية ووحدة صالحتين.');
 const duplicate=db.prepare('SELECT * FROM ai_boq_items WHERE project_id=? AND source_takeoff_run_id=? AND source_proposal_key=?').get(req.params.projectId,runId,category+':'+proposalKey);
 if(duplicate)throw E.conflict('تم ترحيل هذه الكمية إلى BOQ مسبقاً.');
 const disciplineName=categoryResult.name?.en||categoryResult.discipline||category;
 const label=proposal.label?.en||proposal.label?.ar||proposalKey;
 const description=clean(disciplineName+' - '+label,1000);
 const sourceDetail={category,discipline:categoryResult.discipline,proposal,ruleId:categoryResult.ruleId,formula:categoryResult.formula,method:categoryResult.method,sourceLayers:categoryResult.sourceLayers||[],sourceEntityCount:categoryResult.sourceEntityCount,assumptions:categoryResult.assumptions||[],limitations:categoryResult.limitations||[],reviewState:'approved_run_proposal'};
 const id=uid('aiboq_');
 db.prepare(`INSERT INTO ai_boq_items(id,project_id,item_code,description,unit,quantity,rate,rate_missing,source_takeoff_run_id,source_proposal_key,source_detail_json,created_by)
 VALUES(?,?,?,?,?,?,NULL,1,?,?,?,?)`).run(id,req.params.projectId,null,description,proposal.unit,Number(proposal.value),runId,category+':'+proposalKey,JSON.stringify(sourceDetail),req.user.id);
 audit(db,req,'boq_item_created_from_takeoff',id,{runId,category,proposalKey,quantity:Number(proposal.value),unit:proposal.unit});
 const row=db.prepare('SELECT * FROM ai_boq_items WHERE id=?').get(id);
 res.status(201).json({item:itemView(row),source:{runId,category,proposalKey,detail:sourceDetail},notice:'تم إنشاء بند BOQ بسعر وحدة غير محدد. راجع الوصف والكمية وأدخل السعر بعد مراجعة المهندس.'});
}));
router.post('/projects/:projectId/boq',wrap(async(req,res)=>{
 access(req,true);
 const description=clean(req.body?.description,1000),unit=clean(req.body?.unit,24);
 if(description.length<3||!unit)throw E.validation('وصف البند ووحدته مطلوبان.');
 const quantity=number(req.body?.quantity,'الكمية'),rate=nullableRate(req.body?.rate);
 const code=clean(req.body?.itemCode,80)||null,sourceId=clean(req.body?.sourceTakeoffItemId,100)||null;
 const db=getDB(),id=uid('aiboq_');
 if(sourceId){
  const src=db.prepare(`SELECT i.id,i.quantity,i.unit,i.entity_type,i.layer_name,r.project_id,r.status FROM ai_takeoff_items i JOIN ai_takeoff_runs r ON r.id=i.run_id WHERE i.id=? AND r.project_id=?`).get(sourceId,req.params.projectId);
  if(!src)throw E.notFound('عنصر الحصر المصدر غير موجود في هذا المشروع.');
  if(src.status!=='approved')throw E.conflict('لا يمكن ربط بند BOQ بنتيجة حصر قبل اعتمادها من المراجع.');
  if(Math.abs(Number(src.quantity)-quantity)>Math.max(1e-9,Math.abs(Number(src.quantity))*1e-9)||src.unit!==unit)throw E.validation('كمية ووحدة بند BOQ المرتبط يجب أن تطابقا نتيجة الحصر المعتمدة.');
 }
 db.prepare(`INSERT INTO ai_boq_items(id,project_id,item_code,description,unit,quantity,rate,source_takeoff_item_id,created_by) VALUES(?,?,?,?,?,?,?,?,?)`).run(id,req.params.projectId,code,description,unit,quantity,rate,sourceId,req.user.id);
 audit(db,req,'boq_item_created',id,{quantity,rate,sourceId});
 const row=db.prepare('SELECT * FROM ai_boq_items WHERE id=?').get(id);
 res.status(201).json({item:itemView(row)});
}));
router.patch('/projects/:projectId/boq/:itemId',wrap(async(req,res)=>{
 access(req,true);
 const db=getDB(),old=db.prepare('SELECT * FROM ai_boq_items WHERE id=? AND project_id=?').get(req.params.itemId,req.params.projectId);
 if(!old)throw E.notFound('بند BOQ غير موجود.');
 const description=req.body?.description===undefined?old.description:clean(req.body.description,1000);
 const unit=req.body?.unit===undefined?old.unit:clean(req.body.unit,24);
 if(description.length<3||!unit)throw E.validation('وصف البند ووحدته مطلوبان.');
 const quantity=req.body?.quantity===undefined?old.quantity:number(req.body.quantity,'الكمية');
 const rate=req.body?.rate===undefined?old.rate:nullableRate(req.body.rate);
 if(old.source_takeoff_item_id){
  const src=db.prepare(`SELECT i.quantity,i.unit,r.status FROM ai_takeoff_items i JOIN ai_takeoff_runs r ON r.id=i.run_id WHERE i.id=? AND r.project_id=?`).get(old.source_takeoff_item_id,req.params.projectId);
  if(!src||src.status!=='approved')throw E.conflict('مصدر الحصر المرتبط غير متاح أو لم يعد معتمداً.');
  if(Math.abs(quantity-Number(src.quantity))>Math.max(1e-9,Math.abs(Number(src.quantity))*1e-9)||unit!==src.unit)throw E.validation('لا يمكن تغيير كمية أو وحدة بند مرتبط بحصر معتمد؛ أنشئ بنداً مستقلاً للتعديل.');
 }
 const code=req.body?.itemCode===undefined?old.item_code:(clean(req.body.itemCode,80)||null);
 db.prepare('UPDATE ai_boq_items SET item_code=?,description=?,unit=?,quantity=?,rate=?,rate_missing=?,updated_at=unixepoch() WHERE id=? AND project_id=?').run(code,description,unit,quantity,rate,(rate===null?1:0),old.id,req.params.projectId);
 audit(db,req,'boq_item_updated',old.id,{quantity,rate});
 res.json({item:itemView(db.prepare('SELECT * FROM ai_boq_items WHERE id=?').get(old.id))});
}));
router.delete('/projects/:projectId/boq/:itemId',wrap(async(req,res)=>{
 access(req,true);
 const db=getDB(),old=db.prepare('SELECT id FROM ai_boq_items WHERE id=? AND project_id=?').get(req.params.itemId,req.params.projectId);
 if(!old)throw E.notFound('بند BOQ غير موجود.');
 db.prepare('DELETE FROM ai_boq_items WHERE id=? AND project_id=?').run(old.id,req.params.projectId);
 audit(db,req,'boq_item_deleted',old.id,{});
 res.json({ok:true,id:old.id});
}));
module.exports=router;
