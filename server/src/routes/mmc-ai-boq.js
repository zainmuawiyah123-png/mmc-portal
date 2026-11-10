'use strict';
/** Project BOQ and estimate workspace. No tender/procurement tables are modified. */
const express=require('express');
const {getDB,uid}=require('../db');
const {E,wrap}=require('../lib/errors');
const A=require('../lib/auth');
const router=express.Router();
router.use(A.requireAuth);
const EDIT=new Set(['owner','project_manager','engineer','quantity_surveyor']);
function member(projectId,userId){return getDB().prepare(`SELECT m.role,p.status FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=?`).get(projectId,userId)||null;}
function access(req,edit=false){const m=member(req.params.projectId,req.user.id);if(!m||m.status!=='active')throw E.notFound('المشروع غير موجود.');if(edit&&!EDIT.has(m.role))throw E.forbidden('لا تملك صلاحية تعديل جدول الكميات.');return m;}
function audit(db,req,action,itemId,detail){db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)`).run(uid('aial_'),req.params.projectId,req.user.id,action,'boq_item',itemId,JSON.stringify(detail||{}));}
function clean(v,max){return String(v==null?'':v).trim().slice(0,max);}
function number(v,label){const n=Number(v);if(!Number.isFinite(n)||n<0||n>1e12)throw E.validation(label+' يجب أن يكون رقماً موجباً صالحاً.');return n;}
function itemView(x){return {...x,line_total:Number((x.quantity*x.rate).toFixed(3))};}
router.get('/projects/:projectId/boq',wrap(async(req,res)=>{
 access(req);
 const rows=getDB().prepare(`SELECT id,project_id,item_code,description,unit,quantity,rate,source_takeoff_item_id,created_by,updated_at,created_at FROM ai_boq_items WHERE project_id=? ORDER BY created_at,id`).all(req.params.projectId).map(itemView);
 const total=Number(rows.reduce((s,x)=>s+x.line_total,0).toFixed(3));
 res.setHeader('Cache-Control','no-store');
 res.json({items:rows,summary:{itemCount:rows.length,total}});
}));
router.post('/projects/:projectId/boq',wrap(async(req,res)=>{
 access(req,true);
 const description=clean(req.body?.description,1000),unit=clean(req.body?.unit,24);
 if(description.length<3||!unit)throw E.validation('وصف البند ووحدته مطلوبان.');
 const quantity=number(req.body?.quantity,'الكمية'),rate=number(req.body?.rate,'سعر الوحدة');
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
 const rate=req.body?.rate===undefined?old.rate:number(req.body.rate,'سعر الوحدة');
 const code=req.body?.itemCode===undefined?old.item_code:(clean(req.body.itemCode,80)||null);
 db.prepare('UPDATE ai_boq_items SET item_code=?,description=?,unit=?,quantity=?,rate=?,updated_at=unixepoch() WHERE id=? AND project_id=?').run(code,description,unit,quantity,rate,old.id,req.params.projectId);
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
