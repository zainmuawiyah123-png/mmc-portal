'use strict';
/** Secure, project-scoped document intake for MMC AI. No tender file routes are reused. */
const express=require('express');
const multer=require('multer');
const crypto=require('crypto');
const path=require('path');
const {getDB,uid}=require('../db');
const {E,wrap}=require('../lib/errors');
const A=require('../lib/auth');
const storage=require('../lib/storage');
const {preflightPdf}=require('../lib/mmc-ai/pdf-preflight');
const router=express.Router();
const MAX_BYTES=25*1024*1024;
const EXT_MIME={'.pdf':'application/pdf','.dxf':'application/dxf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.glb':'model/gltf-binary'};
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_BYTES,files:1,fields:0},fileFilter(req,file,cb){
 const ext=path.extname(file.originalname||'').toLowerCase();
 if(!EXT_MIME[ext]) return cb(E.validation('يدعم الرفع PDF وDXF وPNG وJPG وGLB ثلاثي الأبعاد.'));
 cb(null,true);
}});
function member(projectId,userId){
 return getDB().prepare(`SELECT m.role,p.status FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id
 WHERE m.project_id=? AND m.user_id=?`).get(projectId,userId)||null;
}
function canUpload(role){return ['owner','project_manager','engineer','quantity_surveyor'].includes(role);}
function validContent(file,ext){
 const b=file.buffer;
 if(ext==='.pdf') return b.length>=5&&b.subarray(0,5).toString('ascii')==='%PDF-';
 if(ext==='.png') return b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(ext==='.jpg'||ext==='.jpeg') return b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff;
 if(ext==='.dxf'){const head=b.subarray(0,Math.min(b.length,4096)).toString('utf8').replace(/^\uFEFF/,'');return /(?:^|\r?\n)\s*0\s*\r?\nSECTION\s*\r?\n2\s*\r?\n(?:HEADER|TABLES|BLOCKS|ENTITIES)/i.test(head);}
 if(ext==='.glb')return b.length>=20&&b.subarray(0,4).toString('ascii')==='glTF'&&b.readUInt32LE(4)===2&&b.readUInt32LE(8)===b.length;
 return false;
}
router.use(A.requireAuth);
router.get('/projects/:projectId/documents',wrap(async(req,res)=>{
 const m=member(req.params.projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 const rows=getDB().prepare(`SELECT id,project_id,uploaded_by,original_name,file_ext,mime_type,size_bytes,sha256,processing_status,created_at
 FROM ai_documents WHERE project_id=? ORDER BY created_at DESC`).all(req.params.projectId);
 res.setHeader('Cache-Control','no-store');res.json({documents:rows});
}));

router.get('/projects/:projectId/documents/:documentId/download',wrap(async(req,res)=>{
 const m=member(req.params.projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 const doc=getDB().prepare('SELECT * FROM ai_documents WHERE id=? AND project_id=?').get(req.params.documentId,req.params.projectId);
 if(!doc) throw E.notFound('المستند غير موجود.');
 const store=storage.getStorage();
 if(!(await store.exists(doc.storage_key))) throw E.notFound('الملف غير موجود في التخزين.');
 getDB().prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json)
 VALUES(?,?,?,?,?,?,?)`).run(uid('aial_'),doc.project_id,req.user.id,'document_downloaded','document',doc.id,JSON.stringify({sha256:doc.sha256}));
 const inline=req.query.inline==='1'&&doc.file_ext==='.glb';
 res.setHeader('Content-Type',inline?'model/gltf-binary':'application/octet-stream');
 res.setHeader('Content-Disposition',(inline?'inline':'attachment')+'; filename="'+encodeURIComponent(doc.original_name)+'"');
 res.setHeader('Content-Length',String(doc.size_bytes));
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Cache-Control','private, no-store');
 if(store.DRIVER==='s3'){const result=await store.stream(doc.storage_key);result.body.pipe(res);}
 else store.stream(doc.storage_key).pipe(res);
}));
router.post('/projects/:projectId/documents/:documentId/preflight/pdf',wrap(async(req,res)=>{
 const m=member(req.params.projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 const db=getDB(),doc=db.prepare('SELECT * FROM ai_documents WHERE id=? AND project_id=?').get(req.params.documentId,req.params.projectId);
 if(!doc) throw E.notFound('المستند غير موجود.');
 if(doc.file_ext!=='.pdf') throw E.validation('فحص PDF متاح لملفات PDF فقط.');
 const store=storage.getStorage();
 if(!(await store.exists(doc.storage_key))) throw E.notFound('الملف غير موجود في التخزين.');
 const bytes=await store.get(doc.storage_key);
 if(!Buffer.isBuffer(bytes)) throw E.validation('تعذر قراءة ملف PDF من التخزين.');
 if(bytes.length!==Number(doc.size_bytes)) throw E.validation('فشل التحقق من سلامة المستند: الحجم المخزن لا يطابق سجل الرفع.');
 const actualHash=crypto.createHash('sha256').update(bytes).digest();
 const expectedHash=Buffer.from(String(doc.sha256||''),'hex');
 if(expectedHash.length!==actualHash.length||!crypto.timingSafeEqual(expectedHash,actualHash)){
  throw E.validation('فشل التحقق من سلامة المستند: بصمة SHA-256 لا تطابق سجل الرفع.');
 }
 const report=preflightPdf(bytes);
 db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json)
 VALUES(?,?,?,?,?,?,?)`).run(uid('aial_'),doc.project_id,req.user.id,'pdf_preflight_completed','document',doc.id,JSON.stringify({version:report.version,bytes:report.bytes,pageCount:report.pageCount,status:report.status}));
 res.setHeader('Cache-Control','no-store');
 res.json({documentId:doc.id,report,notice:'هذا فحص بنية أولي فقط؛ لا يستخرج النصوص أو الأبعاد أو الكميات.'});
}));
router.post('/projects/:projectId/documents',upload.single('file'),wrap(async(req,res)=>{
 const projectId=req.params.projectId,db=getDB();
 const m=member(projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 if(!canUpload(m.role)) throw E.forbidden('لا تملك صلاحية رفع الملفات إلى هذا المشروع.');
 if(!req.file) throw E.validation('اختر ملفاً للرفع.');
 const file=req.file,ext=path.extname(file.originalname||'').toLowerCase();
 if(file.size<1||!validContent(file,ext)) throw E.validation('محتوى الملف لا يطابق نوعه المعلن؛ لم يتم حفظه.');
 const id=uid('aidoc_'),stored=crypto.randomBytes(18).toString('hex')+ext;
 const key=['mmc-ai','projects',projectId,'documents',stored].join('/');
 const checksum=crypto.createHash('sha256').update(file.buffer).digest('hex');
 await storage.getStorage().put(key,file.buffer,{mime:EXT_MIME[ext],originalName:path.basename(file.originalname).slice(0,180)});
 try{
  db.prepare(`INSERT INTO ai_documents(id,project_id,uploaded_by,original_name,file_ext,mime_type,size_bytes,sha256,storage_key)
   VALUES(?,?,?,?,?,?,?,?,?)`).run(id,projectId,req.user.id,path.basename(file.originalname).slice(0,180),ext,EXT_MIME[ext],file.size,checksum,key);
 }catch(err){await storage.getStorage().delete(key).catch(()=>{});throw err;}
 const doc=db.prepare(`SELECT id,project_id,uploaded_by,original_name,file_ext,mime_type,size_bytes,sha256,processing_status,created_at
 FROM ai_documents WHERE id=?`).get(id);
 res.status(201).json({document:doc});
}));
module.exports=router;
