'use strict';
/** Project correspondence register. Records incoming/outgoing communications and links to project records. */
const express=require('express');
const {getDB,uid}=require('../db');
const {E,wrap}=require('../lib/errors');
const A=require('../lib/auth');
const router=express.Router();router.use(A.requireAuth);
const EDIT=new Set(['owner','project_manager','engineer','consultant']);
function access(req,edit=false){
 const db=getDB(),m=db.prepare('SELECT m.role,p.status FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=?').get(req.params.projectId,req.user.id);
 if(!m||m.status!=='active')throw E.notFound('المشروع غير موجود.');
 if(edit&&!EDIT.has(m.role))throw E.forbidden('لا تملك صلاحية تعديل مراسلات المشروع.');
 return m;
}
function ensure(){getDB().exec(`
 CREATE TABLE IF NOT EXISTS ai_project_correspondence(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, correspondence_no TEXT, direction TEXT NOT NULL,
  communication_date TEXT, sender TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL,
  reference_type TEXT, reference_id TEXT, reference_text TEXT, body TEXT, response_due_date TEXT,
  response_status TEXT NOT NULL DEFAULT 'not_required', response_reference TEXT, response_date TEXT,
  attachment_reference TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT(unixepoch())
 );
 CREATE INDEX IF NOT EXISTS idx_ai_correspondence_project_date ON ai_project_correspondence(project_id,communication_date DESC);
 `);}
function clean(v,n){return String(v??'').trim().slice(0,n);}
function date(v){if(v===undefined||v===null||v==='')return null;const s=String(v);if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(s)||Number.isNaN(Date.parse(s)))throw E.validation('صيغة التاريخ يجب أن تكون YYYY-MM-DD.');return s;}
function audit(db,req,action,id,detail){db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)').run(uid('aial_'),req.params.projectId,req.user.id,action,'project_correspondence',id,JSON.stringify(detail||{}));}
router.get('/projects/:projectId/correspondence',wrap(async(req,res)=>{ensure();access(req);const rows=getDB().prepare('SELECT * FROM ai_project_correspondence WHERE project_id=? ORDER BY COALESCE(communication_date,"") DESC,created_at DESC').all(req.params.projectId);res.setHeader('Cache-Control','no-store');res.json({correspondence:rows});}));
router.post('/projects/:projectId/correspondence',wrap(async(req,res)=>{ensure();access(req,true);const b=req.body||{},direction=clean(b.direction,20),sender=clean(b.sender,180),recipient=clean(b.recipient,180),subject=clean(b.subject,300);if(!['incoming','outgoing'].includes(direction)||sender.length<2||recipient.length<2||subject.length<3)throw E.validation('الاتجاه والمرسل والمستلم والموضوع حقول مطلوبة.');const status=clean(b.responseStatus,30)||'not_required';if(!['not_required','awaiting','responded','overdue','closed'].includes(status))throw E.validation('حالة الرد غير صالحة.');const id=uid('aicorr_'),db=getDB();db.prepare('INSERT INTO ai_project_correspondence(id,project_id,correspondence_no,direction,communication_date,sender,recipient,subject,reference_type,reference_id,reference_text,body,response_due_date,response_status,response_reference,response_date,attachment_reference,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,req.params.projectId,clean(b.correspondenceNo,80)||null,direction,date(b.communicationDate),sender,recipient,subject,clean(b.referenceType,40)||null,clean(b.referenceId,100)||null,clean(b.referenceText,200)||null,clean(b.body,12000)||null,date(b.responseDueDate),status,clean(b.responseReference,100)||null,date(b.responseDate),clean(b.attachmentReference,500)||null,req.user.id);audit(db,req,'project_correspondence_created',id,{direction,subject,status});res.status(201).json({item:db.prepare('SELECT * FROM ai_project_correspondence WHERE id=?').get(id)});}));
router.patch('/projects/:projectId/correspondence/:itemId',wrap(async(req,res)=>{ensure();access(req,true);const db=getDB(),old=db.prepare('SELECT * FROM ai_project_correspondence WHERE id=? AND project_id=?').get(req.params.itemId,req.params.projectId);if(!old)throw E.notFound('المراسلة غير موجودة.');const b=req.body||{},status=b.responseStatus===undefined?old.response_status:clean(b.responseStatus,30);if(!['not_required','awaiting','responded','overdue','closed'].includes(status))throw E.validation('حالة الرد غير صالحة.');const responseDate=b.responseDate===undefined?old.response_date:date(b.responseDate),due=b.responseDueDate===undefined?old.response_due_date:date(b.responseDueDate);db.prepare('UPDATE ai_project_correspondence SET response_status=?,response_reference=?,response_date=?,response_due_date=?,updated_at=unixepoch() WHERE id=?').run(status,b.responseReference===undefined?old.response_reference:clean(b.responseReference,100),responseDate,due,old.id);audit(db,req,'project_correspondence_updated',old.id,{status});res.json({item:db.prepare('SELECT * FROM ai_project_correspondence WHERE id=?').get(old.id)});}));
module.exports=router;
