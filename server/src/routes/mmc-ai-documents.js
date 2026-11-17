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
const {extractPdfText}=require('../lib/mmc-ai/pdf-text-extract');
const {inspectPdfVectorPage}=require('../lib/mmc-ai/pdf-pdf-vector-extract');
const {detectRectangularFootprints}=require('../lib/mmc-ai/pdf-2d-to-3d');
const {analyzePdfDrawingText}=require('../lib/mmc-ai/pdf-drawing-text-intelligence');
const {ocrPdf,ocrImage}=require('../lib/mmc-ai/ocr-engine');
const router=express.Router();
const MAX_BYTES=25*1024*1024;
const EXT_MIME={'.pdf':'application/pdf','.dxf':'application/dxf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.glb':'model/gltf-binary'};
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_BYTES,files:1,fields:4},fileFilter(req,file,cb){
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
const DISCIPLINES=['structural','architectural','electrical','mechanical','plumbing_fire'];
function cleanText(value,max=80){const s=String(value??'').trim();return s?s.slice(0,max):null;}
function packageSummary(db,projectId){
 const packages=db.prepare('SELECT * FROM ai_discipline_packages WHERE project_id=? ORDER BY discipline').all(projectId);
 const docs=db.prepare("SELECT id,discipline,sheet_number,revision,drawing_title,original_name,processing_status FROM ai_documents WHERE project_id=?").all(projectId);
 return DISCIPLINES.map(discipline=>{
  const pkg=packages.find(x=>x.discipline===discipline)||{discipline,applicability:'required',expected_sheets_json:'[]',updated_at:null};
  let expected=[];try{expected=JSON.parse(pkg.expected_sheets_json||'[]')}catch(_){}
  const selected=docs.filter(d=>d.discipline===discipline);
  const received=new Set(selected.map(d=>d.sheet_number).filter(Boolean));
  const missing=expected.filter(s=>!received.has(s));
  const revisions=selected.filter(d=>d.sheet_number).reduce((a,d)=>{(a[d.sheet_number]??=[]).push(d);return a;},{});
  const duplicateSheets=Object.entries(revisions).flatMap(([sheetNumber,items])=>{
   const byRevision=items.reduce((a,d)=>{const key=d.revision||'(no revision)';(a[key]??=[]).push(d);return a;},{});
   return Object.entries(byRevision).filter(([,same])=>same.length>1).map(([revision,same])=>({sheetNumber,revision,documents:same.map(d=>({id:d.id,filename:d.original_name}))}));
  });
  const unnumbered=selected.filter(d=>!d.sheet_number).map(d=>({id:d.id,filename:d.original_name}));
  const revisionSets=Object.entries(revisions).map(([sheetNumber,items])=>({sheetNumber,revisions:[...new Set(items.map(d=>d.revision).filter(Boolean))]}));
  const revisionConflicts=revisionSets.filter(x=>x.revisions.length>1);
  const status=pkg.applicability==='not_required'?'not_required':(!selected.length?'awaiting_upload':(missing.length||unnumbered.length||duplicateSheets.length||revisionConflicts.length?'incomplete':'ready_for_review'));
  return {discipline,applicability:pkg.applicability,expectedSheets:expected,receivedSheets:[...received].sort(),missingSheets:missing,unnumberedDocuments:unnumbered,duplicateSheetNumbers:duplicateSheets,revisionConflicts,revisionSets,documents:selected,status,updatedAt:pkg.updated_at};
 });
}
router.get('/projects/:projectId/documents',wrap(async(req,res)=>{
 const m=member(req.params.projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 const rows=getDB().prepare(`SELECT id,project_id,uploaded_by,original_name,file_ext,mime_type,size_bytes,sha256,discipline,sheet_number,revision,drawing_title,processing_status,created_at
 FROM ai_documents WHERE project_id=? ORDER BY discipline,created_at DESC`).all(req.params.projectId);
 res.setHeader('Cache-Control','no-store');res.json({documents:rows});
}));
router.get('/projects/:projectId/drawing-packages',wrap(async(req,res)=>{
 const m=member(req.params.projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 res.setHeader('Cache-Control','no-store');
 res.json({packages:packageSummary(getDB(),req.params.projectId)});
}));
router.put('/projects/:projectId/drawing-packages/:discipline',wrap(async(req,res)=>{
 const projectId=req.params.projectId,discipline=String(req.params.discipline||'');
 const m=member(projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 if(!canUpload(m.role)) throw E.forbidden('لا تملك صلاحية تعديل سجل المخططات.');
 if(!DISCIPLINES.includes(discipline)) throw E.validation('تخصص المخطط غير صالح.');
 const applicability=req.body?.applicability==='not_required'?'not_required':'required';
 const raw=req.body?.expectedSheets;
 if(raw!==undefined&&!Array.isArray(raw)) throw E.validation('قائمة أرقام اللوحات يجب أن تكون قائمة.');
 const expected=[...new Set((raw||[]).map(x=>cleanText(x,40)).filter(Boolean))].slice(0,500);
 const db=getDB();
 db.prepare(`INSERT INTO ai_discipline_packages(project_id,discipline,applicability,expected_sheets_json,updated_by,updated_at)
 VALUES(?,?,?,?,?,unixepoch()) ON CONFLICT(project_id,discipline) DO UPDATE SET
 applicability=excluded.applicability,expected_sheets_json=excluded.expected_sheets_json,updated_by=excluded.updated_by,updated_at=unixepoch()`)
 .run(projectId,discipline,applicability,JSON.stringify(expected),req.user.id);
 res.setHeader('Cache-Control','no-store');
 res.json({packages:packageSummary(db,projectId)});
}));

router.get('/projects/:projectId/documents/:documentId/analysis/latest',wrap(async(req,res)=>{
 const m=member(req.params.projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 const row=getDB().prepare(`SELECT id,analysis_type,result_json,created_at FROM ai_document_analyses WHERE project_id=? AND document_id=? ORDER BY created_at DESC LIMIT 1`).get(req.params.projectId,req.params.documentId);
 if(!row) throw E.notFound('لا توجد قراءة محفوظة لهذا المخطط بعد.');
 res.setHeader('Cache-Control','no-store');
 res.json({analysisId:row.id,analysisType:row.analysis_type,createdAt:row.created_at,result:JSON.parse(row.result_json)});
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
router.post('/projects/:projectId/documents/:documentId/extract/text',wrap(async(req,res)=>{
 const m=member(req.params.projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 const db=getDB(),doc=db.prepare('SELECT * FROM ai_documents WHERE id=? AND project_id=?').get(req.params.documentId,req.params.projectId);
 if(!doc) throw E.notFound('المستند غير موجود.');
 if(doc.file_ext!=='.pdf') throw E.validation('استخراج النص متاح لملفات PDF فقط.');
 const store=storage.getStorage();
 if(!(await store.exists(doc.storage_key))) throw E.notFound('الملف غير موجود في التخزين.');
 const bytes=await store.get(doc.storage_key);
 if(!Buffer.isBuffer(bytes)||bytes.length!==Number(doc.size_bytes)) throw E.validation('فشل التحقق من حجم المستند المخزن.');
 const actualHash=crypto.createHash('sha256').update(bytes).digest(),expectedHash=Buffer.from(String(doc.sha256||''),'hex');
 if(expectedHash.length!==actualHash.length||!crypto.timingSafeEqual(expectedHash,actualHash)) throw E.validation('فشل التحقق من بصمة SHA-256 للمستند.');
 let result;try{result=extractPdfText(bytes);}catch(err){throw E.validation(err.message||'تعذر استخراج النص من PDF.');}
 db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json)
 VALUES(?,?,?,?,?,?,?)`).run(uid('aial_'),doc.project_id,req.user.id,'pdf_text_extraction_completed','document',doc.id,JSON.stringify({engine:result.engine,status:result.status,characterCount:result.characterCount,pageCount:result.pageCount}));
 res.setHeader('Cache-Control','no-store');
 res.json({documentId:doc.id,result,notice:'استخراج نصي أولي فقط؛ لا يمثل OCR أو تحليلاً هندسياً أو حصر كميات.'});
}));
router.post('/projects/:projectId/documents/:documentId/extract/vector-geometry',wrap(async(req,res)=>{
 const m=member(req.params.projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 const db=getDB(),doc=db.prepare('SELECT * FROM ai_documents WHERE id=? AND project_id=?').get(req.params.documentId,req.params.projectId);
 if(!doc) throw E.notFound('المستند غير موجود.');
 if(doc.file_ext!=='.pdf') throw E.validation('استخراج هندسة PDF متاح لملفات PDF فقط.');
 const store=storage.getStorage();
 if(!(await store.exists(doc.storage_key))) throw E.notFound('الملف غير موجود في التخزين.');
 const bytes=await store.get(doc.storage_key);
 if(!Buffer.isBuffer(bytes)||bytes.length!==Number(doc.size_bytes)) throw E.validation('فشل التحقق من حجم المستند المخزن.');
 const actualHash=crypto.createHash('sha256').update(bytes).digest(),expectedHash=Buffer.from(String(doc.sha256||''),'hex');
 if(expectedHash.length!==actualHash.length||!crypto.timingSafeEqual(expectedHash,actualHash)) throw E.validation('فشل التحقق من بصمة SHA-256 للمستند.');
 const pageNumber=Number(req.body?.pageNumber||1);
 const knownDistanceMm=req.body?.knownDistanceMm===undefined?null:Number(req.body.knownDistanceMm);
 const calibrationPointA=req.body?.calibrationPointA??null;
 const calibrationPointB=req.body?.calibrationPointB??null;
 if(knownDistanceMm!==null){
  if(!Number.isFinite(knownDistanceMm)||knownDistanceMm<=0||!calibrationPointA||!calibrationPointB||
   !Number.isFinite(Number(calibrationPointA.x))||!Number.isFinite(Number(calibrationPointA.y))||
   !Number.isFinite(Number(calibrationPointB.x))||!Number.isFinite(Number(calibrationPointB.y)))
   throw E.validation('للمعايرة أدخل بُعداً حقيقياً موجباً ونقطتين واضحتين من صفحة الرسم.');
 }
 let result;
 try{
  result=await inspectPdfVectorPage(bytes,{pageNumber,knownDistanceMm,calibrationPointA:calibrationPointA?{x:Number(calibrationPointA.x),y:Number(calibrationPointA.y)}:null,calibrationPointB:calibrationPointB?{x:Number(calibrationPointB.x),y:Number(calibrationPointB.y)}:null});
 }catch(error){
  if(error.code==='PDF_VECTOR_INVALID'||error.code==='PDF_VECTOR_TOO_LARGE'||error.code==='PDF_VECTOR_SVG_MISSING') throw E.validation(error.message);
  if(error.code==='ENOENT') throw E.validation('محرك تحويل PDF إلى SVG غير متوفر في بيئة التشغيل؛ يلزم تثبيت Poppler pdftocairo.');
  throw error;
 }
 const analysisId=uid('aidan_');
 db.prepare('INSERT INTO ai_document_analyses(id,project_id,document_id,created_by,analysis_type,result_json) VALUES(?,?,?,?,?,?)')
  .run(analysisId,doc.project_id,doc.id,req.user.id,'pdf_vector_geometry',JSON.stringify(result));
 db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)')
  .run(uid('aial_'),doc.project_id,req.user.id,'pdf_vector_geometry_extracted','document',doc.id,JSON.stringify({pageNumber,pathCount:result.geometry.pathCount,unsupportedPathCount:result.geometry.unsupportedPathCount,status:result.status}));
 res.setHeader('Cache-Control','no-store');
 res.json({analysisId,documentId:doc.id,result,notice:result.notice});
}));
router.post('/projects/:projectId/documents/:documentId/extract/3d-candidates',wrap(async(req,res)=>{
 const m=member(req.params.projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 const db=getDB(),doc=db.prepare('SELECT * FROM ai_documents WHERE id=? AND project_id=?').get(req.params.documentId,req.params.projectId);
 if(!doc) throw E.notFound('المستند غير موجود.');
 if(doc.file_ext!=='.pdf') throw E.validation('استخراج مرشحات 3D متاح لملفات PDF فقط.');
 const store=storage.getStorage();
 if(!(await store.exists(doc.storage_key))) throw E.notFound('الملف غير موجود في التخزين.');
 const bytes=await store.get(doc.storage_key);
 if(!Buffer.isBuffer(bytes)||bytes.length!==Number(doc.size_bytes)) throw E.validation('فشل التحقق من حجم المستند المخزن.');
 const actualHash=crypto.createHash('sha256').update(bytes).digest(),expectedHash=Buffer.from(String(doc.sha256||''),'hex');
 if(expectedHash.length!==actualHash.length||!crypto.timingSafeEqual(expectedHash,actualHash)) throw E.validation('فشل التحقق من بصمة SHA-256 للمستند.');
 const pageNumber=Number(req.body?.pageNumber||1);
 let vectorResult;
 try{vectorResult=await inspectPdfVectorPage(bytes,{pageNumber});}
 catch(error){
  if(error.code==='PDF_VECTOR_INVALID'||error.code==='PDF_VECTOR_TOO_LARGE'||error.code==='PDF_VECTOR_SVG_MISSING') throw E.validation(error.message);
  if(error.code==='ENOENT') throw E.validation('محرك تحويل PDF إلى SVG غير متوفر في بيئة التشغيل؛ يلزم تثبيت Poppler pdftocairo.');
  throw error;
 }
 const candidates=detectRectangularFootprints(vectorResult.geometry);
 const result={engine:'mmc-ai-automatic-2d-to-3d-candidate-pipeline-v1',documentId:doc.id,pageNumber,sourceEngine:vectorResult.engine,...candidates,modelCreated:false,reason:'لا يتم إنشاء مجسم أو حساب حجم قبل التحقق الآلي من المقياس والارتفاعات وربط المساقط بالقطاعات؛ لا يُسمح بالإدخال اليدوي أو التخمين.',approvalEligible:false};
 const analysisId=uid('aidan_');
 db.prepare('INSERT INTO ai_document_analyses(id,project_id,document_id,created_by,analysis_type,result_json) VALUES(?,?,?,?,?,?)')
  .run(analysisId,doc.project_id,doc.id,req.user.id,'pdf_3d_candidates',JSON.stringify(result));
 db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)')
  .run(uid('aial_'),doc.project_id,req.user.id,'pdf_3d_candidates_extracted','document',doc.id,JSON.stringify({pageNumber,detectedCount:result.detectedCount,rejectedCount:result.rejectedCount}));
 res.setHeader('Cache-Control','no-store');
 res.json({analysisId,documentId:doc.id,result});
}));
router.post('/projects/:projectId/documents/:documentId/analyze/drawing-text',wrap(async(req,res)=>{
 const m=member(req.params.projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 const db=getDB(),doc=db.prepare('SELECT * FROM ai_documents WHERE id=? AND project_id=?').get(req.params.documentId,req.params.projectId);
 if(!doc) throw E.notFound('المستند غير موجود.');
 if(doc.file_ext!=='.pdf') throw E.validation('تحليل بيانات لوحة الرسم النصية متاح لملفات PDF فقط.');
 const store=storage.getStorage();
 if(!(await store.exists(doc.storage_key))) throw E.notFound('الملف غير موجود في التخزين.');
 const bytes=await store.get(doc.storage_key);
 if(!Buffer.isBuffer(bytes)||bytes.length!==Number(doc.size_bytes)) throw E.validation('فشل التحقق من حجم المستند المخزن.');
 const actualHash=crypto.createHash('sha256').update(bytes).digest(),expectedHash=Buffer.from(String(doc.sha256||''),'hex');
 if(expectedHash.length!==actualHash.length||!crypto.timingSafeEqual(expectedHash,actualHash)) throw E.validation('فشل التحقق من بصمة SHA-256 للمستند.');
 let extraction;
 try{extraction=extractPdfText(bytes);}catch(err){throw E.validation(err.message||'تعذر استخراج النص من PDF.');}
 let ocr=null;
 const shouldOcr=extraction.characterCount<40||(extraction.diagnostics?.imageXObjectCalls||0)>0;
 if(shouldOcr){
  try{
   ocr=await ocrPdf(bytes,{maxPages:req.body?.maxPages,dpi:req.body?.dpi});
   const recognized=ocr.pages.map(page=>'[OCR PAGE '+page.page+']\n'+page.text).join('\n');
   extraction={...extraction,text:[extraction.text,recognized].filter(Boolean).join('\n'),characterCount:extraction.characterCount+recognized.length,ocrEngine:ocr.engine,ocrPerformed:true,ocrPageCount:ocr.pagesProcessed,ocrAverageConfidence:ocr.pages.filter(page=>Number.isFinite(page.averageConfidence)).length?Number((ocr.pages.reduce((sum,page)=>sum+(page.averageConfidence||0),0)/ocr.pages.filter(page=>Number.isFinite(page.averageConfidence)).length).toFixed(2)):null,ocrWords:ocr.pages.flatMap(page=>page.words.map(word=>({page:page.page,block:word.block,paragraph:word.paragraph,line:word.line,text:word.text,confidence:word.confidence,box:word.box}))).slice(0,20000)};
  }catch(error){
   ocr={status:error.code==='OCR_RUNTIME_UNAVAILABLE'?'runtime_unavailable':'failed',code:error.code||'OCR_FAILED',message:error.message,details:error.details||null};
  }
 }
 const analysis=analyzePdfDrawingText(extraction,{documentId:doc.id,revision:req.body?.revision||null,sheetOrPage:req.body?.sheetOrPage||doc.original_name});
 const analysisId=uid('aidan_');
 const persisted={analysis,ocr,extractionSummary:{engine:extraction.engine||null,pageCount:extraction.pageCount??null,characterCount:extraction.characterCount??0,ocrPerformed:extraction.ocrPerformed===true}};
 db.prepare(`INSERT INTO ai_document_analyses(id,project_id,document_id,created_by,analysis_type,result_json) VALUES(?,?,?,?,?,?)`).run(analysisId,doc.project_id,doc.id,req.user.id,'pdf_drawing_text',JSON.stringify(persisted));
 db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)')
  .run(uid('aial_'),doc.project_id,req.user.id,'pdf_drawing_text_analysis_completed','document',doc.id,JSON.stringify({status:analysis.status,evidenceCount:analysis.evidence.evidenceCount,conflictCount:analysis.conflicts.length,ocrStatus:ocr?.status||'not_needed'}));
 res.setHeader('Cache-Control','no-store');
 res.json({analysisId,documentId:doc.id,analysis,ocr,notice:'تم حفظ قراءة النص والأبعاد المرشحة. هذه ليست كميات هندسية معتمدة؛ يلزم ربطها بهندسة الرسم ومقياسه.'});
}));

async function automaticPdfReading(bytes,doc){
 const extraction=extractPdfText(bytes);
 let ocr=null,combined=extraction;
 const shouldOcr=extraction.characterCount<40||(extraction.diagnostics?.imageXObjectCalls||0)>0;
 if(shouldOcr){
  try{
   ocr=await ocrPdf(bytes,{maxPages:20,dpi:180});
   const recognized=ocr.pages.map(page=>'[OCR PAGE '+page.page+']\\n'+page.text).join('\\n');
   combined={...extraction,text:[extraction.text,recognized].filter(Boolean).join('\\n'),
    characterCount:extraction.characterCount+recognized.length,ocrPerformed:true,ocrPageCount:ocr.pagesProcessed,
    ocrAverageConfidence:ocr.pages.filter(p=>Number.isFinite(p.averageConfidence)).length?
     Number((ocr.pages.reduce((sum,p)=>sum+(p.averageConfidence||0),0)/ocr.pages.filter(p=>Number.isFinite(p.averageConfidence)).length).toFixed(2)):null,
    ocrWords:ocr.pages.flatMap(page=>page.words.map(word=>({page:page.page,block:word.block,paragraph:word.paragraph,line:word.line,text:word.text,confidence:word.confidence,box:word.box}))).slice(0,20000)};
  }catch(error){ocr={status:error.code==='OCR_RUNTIME_UNAVAILABLE'?'runtime_unavailable':'failed',code:error.code||'OCR_FAILED',message:error.message};}
 }
 const textAnalysis=analyzePdfDrawingText(combined,{documentId:doc.id,sheetOrPage:doc.original_name});
 const pageCount=Math.max(1,Math.min(20,Number(extraction.pageCount)||1));
 const vectorPages=[],vectorFailures=[];
 for(let pageNumber=1;pageNumber<=pageCount;pageNumber++){
  try{
   const vector=await inspectPdfVectorPage(bytes,{pageNumber});
   const footprints=detectRectangularFootprints(vector.geometry);
   vectorPages.push({pageNumber,status:vector.status,pathCount:vector.geometry.pathCount,
    unsupportedPathCount:vector.geometry.unsupportedPathCount??0,
    detectedFootprints:footprints.detected.slice(0,1000),detectedCount:footprints.detectedCount,rejectedCount:footprints.rejectedCount});
  }catch(error){vectorFailures.push({pageNumber,code:error.code||'VECTOR_ANALYSIS_FAILED',message:error.message});}
 }
 const detectedCount=vectorPages.reduce((sum,p)=>sum+p.detectedCount,0);
 return {engine:'mmc-ai-automatic-pdf-reading-v1',documentId:doc.id,
  status:vectorPages.length||textAnalysis.evidence.evidenceCount?'reading_evidence_collected_requires_engineering_resolution':'insufficient_reading_evidence',
  pageCount:extraction.pageCount??null,pagesVectorProcessed:vectorPages.length,truncatedAtPageLimit:(Number(extraction.pageCount)||0)>20,
  extractionSummary:{engine:extraction.engine,status:extraction.status,characterCount:extraction.characterCount,
   imageXObjectCalls:extraction.diagnostics?.imageXObjectCalls??0,vectorPathOperators:extraction.diagnostics?.vectorPathOperators??0},
  textAnalysis,ocr,vectorPages,vectorFailures,detectedFootprintCount:detectedCount,
  quantities:[],threeDModelCreated:false,approvalEligible:false,
  unresolved:['المسارات والأشكال المكتشفة أدلة هندسية مرشحة وليست عناصر إنشائية مصنفة.','لم يُثبت مقياس الرسم تلقائياً؛ لذلك لم تُحوّل وحدات الصفحة إلى أمتار.','لم تُربط المساقط بالقطاعات والتفاصيل للتحقق من الارتفاعات.','لم تصدر كميات أو أحجام ثلاثية الأبعاد لتجنب التخمين.',
   ...(Number(extraction.pageCount)>20?['اقتصر التحليل الهندسي على أول 20 صفحة في هذه المرحلة.']:[])]};
}

router.post('/projects/:projectId/documents',upload.single('file'),wrap(async(req,res)=>{
 const projectId=req.params.projectId,db=getDB();
 const m=member(projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 if(!canUpload(m.role)) throw E.forbidden('لا تملك صلاحية رفع الملفات إلى هذا المشروع.');
 if(!req.file) throw E.validation('اختر ملفاً للرفع.');
 const file=req.file,ext=path.extname(file.originalname||'').toLowerCase();
 const allowedDisciplines=new Set(['structural','architectural','electrical','mechanical','plumbing_fire','unclassified']);
 const discipline=String(req.body?.discipline||'unclassified').trim().toLowerCase();
 if(!allowedDisciplines.has(discipline)) throw E.validation('تخصص المخطط غير صالح. اختر تخصصاً من القائمة.');
 const sheetNumber=cleanText(req.body?.sheetNumber,40),revision=cleanText(req.body?.revision,40),drawingTitle=cleanText(req.body?.drawingTitle,160);
 if(discipline==='unclassified'&&(sheetNumber||revision||drawingTitle)) throw E.validation('اختر تخصصاً قبل إضافة بيانات اللوحة.');
 if(file.size<1||!validContent(file,ext)) throw E.validation('محتوى الملف لا يطابق نوعه المعلن؛ لم يتم حفظه.');
 const id=uid('aidoc_'),stored=crypto.randomBytes(18).toString('hex')+ext;
 const key=['mmc-ai','projects',projectId,'documents',stored].join('/');
 const checksum=crypto.createHash('sha256').update(file.buffer).digest('hex');
 await storage.getStorage().put(key,file.buffer,{mime:EXT_MIME[ext],originalName:path.basename(file.originalname).slice(0,180)});
 try{
  db.prepare(`INSERT INTO ai_documents(id,project_id,uploaded_by,original_name,file_ext,mime_type,size_bytes,sha256,storage_key,discipline,sheet_number,revision,drawing_title)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,projectId,req.user.id,path.basename(file.originalname).slice(0,180),ext,EXT_MIME[ext],file.size,checksum,key,discipline,sheetNumber,revision,drawingTitle);
 }catch(err){await storage.getStorage().delete(key).catch(()=>{});throw err;}
 const doc=db.prepare(`SELECT id,project_id,uploaded_by,original_name,file_ext,mime_type,size_bytes,sha256,discipline,sheet_number,revision,drawing_title,processing_status,created_at
 FROM ai_documents WHERE id=?`).get(id);

 let automaticAnalysis=null,automaticAnalysisError=null;
 if(ext==='.pdf'){
  try{
   automaticAnalysis=await automaticPdfReading(file.buffer,doc);
   const analysisId=uid('aidan_');
   db.prepare('INSERT INTO ai_document_analyses(id,project_id,document_id,created_by,analysis_type,result_json) VALUES(?,?,?,?,?,?)')
    .run(analysisId,doc.project_id,doc.id,req.user.id,'pdf_automatic_reading',JSON.stringify(automaticAnalysis));
   db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)')
    .run(uid('aial_'),doc.project_id,req.user.id,'pdf_automatic_reading_completed','document',doc.id,
     JSON.stringify({status:automaticAnalysis.status,pagesVectorProcessed:automaticAnalysis.pagesVectorProcessed,detectedFootprintCount:automaticAnalysis.detectedFootprintCount,ocrStatus:automaticAnalysis.ocr?.status||'not_needed'}));
  }catch(error){automaticAnalysisError={code:error.code||'AUTOMATIC_READING_FAILED',message:error.message};}

 } else if(ext==='.png'||ext==='.jpg'||ext==='.jpeg'){
  try{
   const mime=ext==='.png'?'image/png':'image/jpeg';
   const ocr=await ocrImage(file.buffer,{mime,dpi:200});
   const recognized=ocr.pages.map(page=>'[IMAGE PAGE '+page.page+']\\n'+page.text).join('\\n');
   const extraction={engine:ocr.engine,text:recognized,characterCount:recognized.length,ocrPerformed:true,
    ocrPageCount:ocr.pagesProcessed,ocrAverageConfidence:ocr.pages[0]?.averageConfidence??null,
    ocrWords:ocr.pages.flatMap(page=>page.words.map(word=>({page:1,block:word.block,paragraph:word.paragraph,line:word.line,text:word.text,confidence:word.confidence,box:word.box}))).slice(0,20000)};
   const textAnalysis=analyzePdfDrawingText(extraction,{documentId:doc.id,sheetOrPage:doc.original_name});
   automaticAnalysis={engine:'mmc-ai-automatic-image-reading-v1',documentId:doc.id,
    status:ocr.status==='ocr_text_extracted'?'image_text_evidence_collected_requires_geometric_interpretation':'insufficient_image_text_evidence',
    sourceFormat:ext.slice(1).toUpperCase(),ocr,textAnalysis,scaleCalibrated:false,geometryExtracted:false,
    quantities:[],threeDModelCreated:false,approvalEligible:false,
    unresolved:['تم استخراج النصوص ومواقع الكلمات من الصورة فقط.','لم تُستخرج هندسة العناصر أو يُعاير مقياس الرسم من الصورة بعد.','لم تُنشأ عناصر BIM أو كميات؛ لن يتم تخمينها.']};
   const analysisId=uid('aidan_');
   db.prepare('INSERT INTO ai_document_analyses(id,project_id,document_id,created_by,analysis_type,result_json) VALUES(?,?,?,?,?,?)')
    .run(analysisId,doc.project_id,doc.id,req.user.id,'image_automatic_reading',JSON.stringify(automaticAnalysis));
   db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)')
    .run(uid('aial_'),doc.project_id,req.user.id,'image_automatic_reading_completed','document',doc.id,
     JSON.stringify({status:automaticAnalysis.status,ocrStatus:ocr.status,wordCount:ocr.pages[0]?.wordCount||0}));
  }catch(error){automaticAnalysisError={code:error.code||'AUTOMATIC_IMAGE_READING_FAILED',message:error.message,details:error.details||null};}
 }
 res.status(201).json({document:doc,automaticAnalysis,automaticAnalysisError});
}));
module.exports=router;
