'use strict';
/** Private, project-scoped construction-site photo gallery for MMC AI. */
const express=require('express');
const multer=require('multer');
const crypto=require('crypto');
const path=require('path');
const {getDB,uid}=require('../db');
const {E,wrap}=require('../lib/errors');
const A=require('../lib/auth');
const storage=require('../lib/storage');
const router=express.Router();
const MAX_BYTES=12*1024*1024;
const TYPES={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png'};
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_BYTES,files:1,fields:3,fieldSize:200},fileFilter(req,file,cb){
 const ext=path.extname(file.originalname||'').toLowerCase();
 if(!TYPES[ext])return cb(E.validation('صور المشروع تقبل JPG وPNG فقط.'));
 cb(null,true);
}});
function membership(projectId,userId){
 return getDB().prepare(`SELECT m.role,p.status FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=?`).get(projectId,userId)||null;
}
function canUpload(role){return ['owner','project_manager','engineer'].includes(role);}
function validImage(file,ext){
 const b=file.buffer;
 if(ext==='.png')return b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 return b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff;
}
router.use(A.requireAuth);
router.get('/projects/:projectId/images',wrap(async(req,res)=>{
 const m=membership(req.params.projectId,req.user.id);
 if(!m||m.status!=='active')throw E.notFound('المشروع غير موجود.');
 const images=getDB().prepare(`SELECT id,project_id,uploaded_by,original_name,mime_type,size_bytes,sha256,caption,captured_at,is_cover,created_at FROM ai_project_images WHERE project_id=? ORDER BY is_cover DESC,COALESCE(captured_at,'' ) DESC,created_at DESC`).all(req.params.projectId);
 res.setHeader('Cache-Control','private, no-store');
 res.json({images});
}));
router.post('/projects/:projectId/images',upload.single('file'),wrap(async(req,res)=>{
 const projectId=req.params.projectId,db=getDB();
 const m=membership(projectId,req.user.id);
 if(!m||m.status!=='active')throw E.notFound('المشروع غير موجود.');
 if(!canUpload(m.role))throw E.forbidden('لا تملك صلاحية إضافة صور لهذا المشروع.');
 if(!req.file)throw E.validation('اختر صورة للمشروع.');
 const file=req.file,ext=path.extname(file.originalname||'').toLowerCase();
 if(file.size<1||!validImage(file,ext))throw E.validation('محتوى الصورة لا يطابق نوع الملف.');
 const caption=String(req.body?.caption||'').trim().slice(0,240)||null;
 const capturedAt=String(req.body?.capturedAt||'').trim();
 if(capturedAt&&!/^\\d{4}-\\d{2}-\\d{2}$/.test(capturedAt))throw E.validation('تاريخ التقاط الصورة يجب أن يكون YYYY-MM-DD.');
 const isCover=['true','1','yes'].includes(String(req.body?.isCover||'').toLowerCase());
 const id=uid('aiimg_'),key=['mmc-ai','projects',projectId,'images',crypto.randomBytes(18).toString('hex')+ext].join('/');
 const checksum=crypto.createHash('sha256').update(file.buffer).digest('hex');
 const store=storage.getStorage();
 await store.put(key,file.buffer,{mime:TYPES[ext],originalName:path.basename(file.originalname).slice(0,180)});
 try{
  db.transaction(()=>{
   if(isCover)db.prepare('UPDATE ai_project_images SET is_cover=0 WHERE project_id=?').run(projectId);
   db.prepare(`INSERT INTO ai_project_images(id,project_id,uploaded_by,original_name,mime_type,size_bytes,sha256,storage_key,caption,captured_at,is_cover) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,projectId,req.user.id,path.basename(file.originalname).slice(0,180),TYPES[ext],file.size,checksum,key,caption,capturedAt||null,isCover?1:0);
   db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)`)
    .run(uid('aial_'),projectId,req.user.id,'project_image_uploaded','project_image',id,JSON.stringify({sha256:checksum,isCover}));
  })();
 }catch(err){await store.delete(key).catch(()=>{});throw err;}
 const image=db.prepare('SELECT id,project_id,uploaded_by,original_name,mime_type,size_bytes,sha256,caption,captured_at,is_cover,created_at FROM ai_project_images WHERE id=?').get(id);
 res.status(201).json({image});
}));
router.get('/projects/:projectId/images/:imageId/download',wrap(async(req,res)=>{
 const m=membership(req.params.projectId,req.user.id);
 if(!m||m.status!=='active')throw E.notFound('المشروع غير موجود.');
 const db=getDB(),img=db.prepare('SELECT * FROM ai_project_images WHERE id=? AND project_id=?').get(req.params.imageId,req.params.projectId);
 if(!img)throw E.notFound('صورة المشروع غير موجودة.');
 const store=storage.getStorage();
 if(!(await store.exists(img.storage_key)))throw E.notFound('الصورة غير موجودة في التخزين.');
 db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)`)
  .run(uid('aial_'),img.project_id,req.user.id,'project_image_viewed','project_image',img.id,JSON.stringify({sha256:img.sha256}));
 res.setHeader('Content-Type',img.mime_type);
 res.setHeader('Content-Length',String(img.size_bytes));
 res.setHeader('Content-Disposition','inline; filename="project-image"');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Cache-Control','private, no-store');
 if(store.DRIVER==='s3'){const result=await store.stream(img.storage_key);result.body.pipe(res);}
 else store.stream(img.storage_key).pipe(res);
}));
module.exports=router;
