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
const {extractPdfTextPoppler}=require('../lib/mmc-ai/pdf-poppler-text');
const {analyzePdfDrawingText}=require('../lib/mmc-ai/pdf-drawing-text-intelligence');
const {ocrPdf}=require('../lib/mmc-ai/ocr-engine');
const {inspectPdfVectorPage}=require('../lib/mmc-ai/pdf-pdf-vector-extract');
const {inspectPdfPageEvidence}=require('../lib/mmc-ai/pdf-page-evidence');
const {correlatePdfTextWithVectorGeometry}=require('../lib/mmc-ai/pdf-evidence-correlation');
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
 let result;
 try{
  const basic=extractPdfText(bytes);
  try{
   const poppler=await extractPdfTextPoppler(bytes);
   result=poppler.status==='partial_text_extracted'?{...basic,...poppler,diagnostics:{...(basic.diagnostics||{}),...(poppler.diagnostics||{})}}:basic;
  }catch(err){
   if(!basic.text)throw err;
   result={...basic,diagnostics:{...(basic.diagnostics||{}),popplerWarning:err.message}};
  }
 }catch(err){throw E.validation(err.message||'تعذر استخراج النص من PDF.');}
 db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json)
 VALUES(?,?,?,?,?,?,?)`).run(uid('aial_'),doc.project_id,req.user.id,'pdf_text_extraction_completed','document',doc.id,JSON.stringify({engine:result.engine,status:result.status,characterCount:result.characterCount,pageCount:result.pageCount}));
 res.setHeader('Cache-Control','no-store');
 res.json({documentId:doc.id,result,notice:'استخراج نصي أولي فقط؛ لا يمثل OCR أو تحليلاً هندسياً أو حصر كميات. لا ينفّذ OCR ولا يثبت المقياس أو الأبعاد. استخدم حصر PDF التجريبي فقط إذا كانت صيغة الجدول مدعومة.'});
}));

/**
 * Explicit drawing-text evidence pass. OCR is used only as text evidence;
 * it never emits engineering quantities or silently assumes scale.
 */
router.post('/projects/:projectId/documents/:documentId/extract/vector-geometry',wrap(async(req,res)=>{
 const m=member(req.params.projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 const db=getDB(),doc=db.prepare('SELECT * FROM ai_documents WHERE id=? AND project_id=?').get(req.params.documentId,req.params.projectId);
 if(!doc) throw E.notFound('المستند غير موجود.');
 if(doc.file_ext!=='.pdf') throw E.validation('استخراج هندسة PDF متاح لملفات PDF فقط.');
 const pageNumber=Number(req.body?.pageNumber||1);
 if(!Number.isInteger(pageNumber)||pageNumber<1||pageNumber>100) throw E.validation('رقم صفحة PDF يجب أن يكون عدداً صحيحاً بين 1 و100.');
 const store=storage.getStorage();
 if(!(await store.exists(doc.storage_key))) throw E.notFound('الملف غير موجود في التخزين.');
 const bytes=await store.get(doc.storage_key);
 if(!Buffer.isBuffer(bytes)||bytes.length!==Number(doc.size_bytes)) throw E.validation('فشل التحقق من حجم المستند المخزن.');
 const actualHash=crypto.createHash('sha256').update(bytes).digest(),expectedHash=Buffer.from(String(doc.sha256||''),'hex');
 if(expectedHash.length!==actualHash.length||!crypto.timingSafeEqual(expectedHash,actualHash)) throw E.validation('فشل التحقق من بصمة SHA-256 للمستند.');
 let result;
 try{result=await inspectPdfVectorPage(bytes,{pageNumber});}
 catch(error){
  if(['PDF_VECTOR_INVALID','PDF_VECTOR_TOO_LARGE','PDF_VECTOR_SVG_MISSING'].includes(error.code)) throw E.validation(error.message);
  if(error.code==='ENOENT') throw E.validation('محرك pdftocairo غير متوفر في بيئة التشغيل.');
  if(error.code==='RangeError'||error instanceof TypeError) throw E.validation(error.message);
  throw error;
 }
 const analysisId=uid('aidan_');
 db.prepare('INSERT INTO ai_document_analyses(id,project_id,document_id,created_by,analysis_type,result_json) VALUES(?,?,?,?,?,?)')
  .run(analysisId,doc.project_id,doc.id,req.user.id,'pdf_vector_geometry',JSON.stringify(result));
 db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)')
  .run(uid('aial_'),doc.project_id,req.user.id,'pdf_vector_geometry_extracted','document',doc.id,JSON.stringify({pageNumber,pathCount:result.geometry.pathCount,closedPathCount:result.geometry.paths.filter(p=>p.closed).length,unsupportedPathCount:result.geometry.unsupportedPathCount,status:result.status}));
 res.setHeader('Cache-Control','no-store');
 res.json({analysisId,documentId:doc.id,result,notice:result.notice});
}));
router.post('/projects/:projectId/documents/:documentId/analyze/drawing-text',wrap(async(req,res)=>{
 const m=member(req.params.projectId,req.user.id);
 if(!m||m.status!=='active') throw E.notFound('المشروع غير موجود.');
 const db=getDB(),doc=db.prepare('SELECT * FROM ai_documents WHERE id=? AND project_id=?').get(req.params.documentId,req.params.projectId);
 if(!doc) throw E.notFound('المستند غير موجود.');
 if(doc.file_ext!=='.pdf') throw E.validation('تحليل النصوص الهندسية متاح حالياً لملفات PDF فقط.');
 const store=storage.getStorage();
 if(!(await store.exists(doc.storage_key))) throw E.notFound('الملف غير موجود في التخزين.');
 const bytes=await store.get(doc.storage_key);
 if(!Buffer.isBuffer(bytes)||bytes.length!==Number(doc.size_bytes)) throw E.validation('فشل التحقق من حجم المستند المخزن.');
 const actualHash=crypto.createHash('sha256').update(bytes).digest(),expectedHash=Buffer.from(String(doc.sha256||''),'hex');
 if(expectedHash.length!==actualHash.length||!crypto.timingSafeEqual(expectedHash,actualHash)) throw E.validation('فشل التحقق من بصمة SHA-256 للمستند.');
 let extraction;
 try{extraction=extractPdfText(bytes);}catch(err){throw E.validation(err.message||'تعذر استخراج النص من PDF.');}
 let pageEvidence=null,pageEvidenceError=null,vectorEvidence=null,vectorEvidenceError=null,correlation=null,correlationSource=null;
 try{
  pageEvidence=await inspectPdfPageEvidence(bytes,{documentId:doc.id,maxPages:Math.min(20,Math.max(1,Number(req.body?.maxPages)||20))});
  const page=pageEvidence.pages[0];
  if(page){
   extraction.nativeSpatialWords=(page.nativeTextEvidence||[]).map(word=>({text:word.text,box:word.box}));
   extraction.nativeSpatialPageNumber=page.pageNumber;
   extraction.nativeSpatialPageWidth=page.bboxWidthPt;
   extraction.nativeSpatialPageHeight=page.bboxHeightPt;
  }
 }catch(error){pageEvidenceError=error.message||'Native page-coordinate extraction failed';}
 try{vectorEvidence=await inspectPdfVectorPage(bytes,{pageNumber:1});}
 catch(error){vectorEvidenceError=error.message||'PDF vector extraction failed';}
 let ocr=null;
 const nativeWordCount=extraction.nativeSpatialWords?.length||0;
 const hasPagesWithoutNativeText=(pageEvidence?.pages||[]).some(page=>(page.nativeTextWordCount||0)<8);
 const shouldOcr=nativeWordCount<8||hasPagesWithoutNativeText||extraction.characterCount<40||(extraction.diagnostics?.imageXObjectCalls||0)>0;
 if(shouldOcr){
  try{
   ocr=await ocrPdf(bytes,{maxPages:req.body?.maxPages||20,dpi:req.body?.dpi||180});
   const recognized=ocr.pages.map(page=>'[OCR PAGE '+page.page+']\n'+page.text).join('\n');
   const confidencePages=ocr.pages.filter(page=>Number.isFinite(page.averageConfidence));
   extraction={...extraction,text:[extraction.text,recognized].filter(Boolean).join('\n'),
    characterCount:extraction.characterCount+recognized.length,ocrEngine:ocr.engine,ocrPerformed:true,
    ocrPageCount:ocr.pagesProcessed,
    ocrAverageConfidence:confidencePages.length?Number((confidencePages.reduce((sum,page)=>sum+page.averageConfidence,0)/confidencePages.length).toFixed(2)):null,
    ocrWords:ocr.pages.flatMap(page=>page.words.map(word=>({page:page.page,block:word.block,paragraph:word.paragraph,line:word.line,text:word.text,confidence:word.confidence,box:word.box}))).slice(0,20000)};
  }catch(error){
   ocr={status:error.code==='OCR_RUNTIME_UNAVAILABLE'?'runtime_unavailable':'failed',code:error.code||'OCR_FAILED',message:error.message,details:error.details||null};
  }
 }
 const page=pageEvidence?.pages?.[0];
 if(page&&vectorEvidence?.svgViewBox){
  try{
   let lines=[];
   if((extraction.nativeSpatialWords||[]).length>=8){
    lines=require('../lib/mmc-ai/pdf-drawing-text-intelligence').spatialNativeLines(extraction.nativeSpatialWords,{
     pageNumber:page.pageNumber,pageWidth:page.bboxWidthPt,pageHeight:page.bboxHeightPt
    });
    correlationSource='native_pdf_text_bbox';
   }else if(ocr?.pages?.[0]?.words?.length){
    lines=require('../lib/mmc-ai/pdf-evidence-correlation').spatialOcrLines(ocr.pages[0].words,{
     pageWidthPt:page.bboxWidthPt,pageHeightPt:page.bboxHeightPt
    });
    correlationSource='tesseract_ocr_word_boxes';
   }
   if(lines.length)correlation=correlatePdfTextWithVectorGeometry({
    textLines:lines,geometry:vectorEvidence.geometry,viewBox:vectorEvidence.svgViewBox,
    pageWidthPt:page.bboxWidthPt,pageHeightPt:page.bboxHeightPt
   });
   else correlation={status:'no_spatial_text_available',textLineCount:0,matchedTextLineCount:0,associations:[],limitations:['Neither native PDF text coordinates nor OCR word boxes were available for spatial matching.']};
  }catch(error){vectorEvidenceError=error.message||'Vector/text spatial matching failed';}
 }else if(!page) correlation={status:'page_evidence_unavailable',textLineCount:0,matchedTextLineCount:0,associations:[],limitations:['PDF page dimensions or native page evidence could not be read.']};
 const pageAnalyses=[];
 if(pageEvidence?.pages?.length){
  const nativeHelper=require('../lib/mmc-ai/pdf-drawing-text-intelligence');
  const correlationHelper=require('../lib/mmc-ai/pdf-evidence-correlation');
  for(const pageRecord of pageEvidence.pages){
   const pageNo=pageRecord.pageNumber;
   let pageVector=pageNo===1?vectorEvidence:null;
   let pageVectorError=pageNo===1?vectorEvidenceError:null;
   if(!pageVector&&!pageVectorError){
    try{pageVector=await inspectPdfVectorPage(bytes,{pageNumber:pageNo});}
    catch(error){pageVectorError=error.message||'PDF vector extraction failed';}
   }
   let pageLines=[];
   let pageTextSource=null;
   if((pageRecord.nativeTextEvidence||[]).length>=8&&pageRecord.bboxWidthPt&&pageRecord.bboxHeightPt){
    pageLines=nativeHelper.spatialNativeLines(pageRecord.nativeTextEvidence.map(word=>({text:word.text,box:word.box})),{
     pageNumber:pageNo,pageWidth:pageRecord.bboxWidthPt,pageHeight:pageRecord.bboxHeightPt
    });
    pageTextSource='native_pdf_text_bbox';
   }else{
    const ocrPage=ocr?.pages?.find(item=>Number(item.page)===pageNo);
    if(ocrPage?.words?.length&&pageRecord.bboxWidthPt&&pageRecord.bboxHeightPt){
     pageLines=correlationHelper.spatialOcrLines(ocrPage.words,{pageWidthPt:pageRecord.bboxWidthPt,pageHeightPt:pageRecord.bboxHeightPt});
     pageTextSource='tesseract_ocr_word_boxes';
    }
   }
   let pageCorrelation=null;
   if(pageVector?.svgViewBox&&pageRecord.bboxWidthPt&&pageRecord.bboxHeightPt&&pageLines.length){
    try{pageCorrelation=correlationHelper.correlatePdfTextWithVectorGeometry({
     textLines:pageLines,geometry:pageVector.geometry,viewBox:pageVector.svgViewBox,
     pageWidthPt:pageRecord.bboxWidthPt,pageHeightPt:pageRecord.bboxHeightPt
    });}catch(error){pageCorrelation={status:'correlation_failed',error:error.message,associations:[],matchedTextLineCount:0};}
   }else{
    pageCorrelation={status:pageLines.length?'vector_geometry_unavailable':'no_spatial_text_available',
     associations:[],textLineCount:pageLines.length,matchedTextLineCount:0,
     limitations:['Page-level text/vector evidence was incomplete; no engineering measurement was inferred.']};
   }
   pageAnalyses.push({
    pageNumber:pageNo,nativeTextWordCount:pageRecord.nativeTextWordCount||0,
    vectorEvidence:pageVector?{pathCount:pageVector.geometry.pathCount,
     closedPathCount:pageVector.geometry.paths.filter(item=>item.closed).length,
     svgViewBox:pageVector.svgViewBox,status:pageVector.status}:null,
    vectorEvidenceError:pageVectorError,textSource:pageTextSource,
    spatialCorrelation:pageCorrelation,
    measurementEligible:false,scaleCalibrated:false,bimGenerated:false
   });
  }
 }
 const analysis=analyzePdfDrawingText(extraction,{documentId:doc.id,revision:doc.revision||null,sheetOrPage:doc.sheet_number||doc.original_name});
 const analysisId=uid('aidan_');
 const persisted={analysis,ocr,pageEvidence:pageEvidence?{engine:pageEvidence.engine,totalPageCount:pageEvidence.totalPageCount,pagesProcessed:pageEvidence.pagesProcessed,pages:pageEvidence.pages}:null,pageAnalyses,pageEvidenceError,vectorEvidence,vectorEvidenceError,spatialCorrelation:correlation,spatialCorrelationSource:correlationSource,extractionSummary:{engine:extraction.engine||null,pageCount:extraction.pageCount??null,characterCount:extraction.characterCount??0,ocrPerformed:extraction.ocrPerformed===true,nativeSpatialWordCount:extraction.nativeSpatialWords?.length||0}};
 db.prepare('INSERT INTO ai_document_analyses(id,project_id,document_id,created_by,analysis_type,result_json) VALUES(?,?,?,?,?,?)')
  .run(analysisId,doc.project_id,doc.id,req.user.id,'pdf_drawing_text',JSON.stringify(persisted));
 db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)')
  .run(uid('aial_'),doc.project_id,req.user.id,'pdf_drawing_text_analysis_completed','document',doc.id,
   JSON.stringify({status:analysis.status,evidenceCount:analysis.evidence.evidenceCount,conflictCount:analysis.conflicts.length,ocrStatus:ocr?.status||'not_needed',nativeSpatialWordCount:extraction.nativeSpatialWords?.length||0,spatialTextSource:correlationSource,spatialMatches:correlation?.matchedTextLineCount||0,spatialStatus:correlation?.status||null,pagesProcessed:pageAnalyses.length,pageVectorPages:pageAnalyses.filter(item=>item.vectorEvidence).length}));
 res.setHeader('Cache-Control','no-store');
 res.json({analysisId,documentId:doc.id,analysis,ocr,pageEvidence:pageEvidence?{totalPageCount:pageEvidence.totalPageCount,pagesProcessed:pageEvidence.pagesProcessed,nativeTextWordCount:pageEvidence.pages?.[0]?.nativeTextWordCount||0}:null,pageEvidenceError,vectorEvidence:vectorEvidence?{pageNumber:vectorEvidence.pageNumber,pathCount:vectorEvidence.geometry.pathCount,closedPathCount:vectorEvidence.geometry.paths.filter(p=>p.closed).length,svgViewBox:vectorEvidence.svgViewBox}:null,vectorEvidenceError,spatialCorrelation:correlation,spatialCorrelationSource:correlationSource,pageAnalyses,pagesProcessed:pageAnalyses.length,notice:'تم فحص الصفحات المعالجة وربط النصوص ذات الإحداثيات مع مسارات كل صفحة كمرشحات مراجعة فقط. لم يتم اعتماد مقياس أو تصنيف العناصر أو إنتاج كميات أو نموذج BIM.'});
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
