'use strict';
/**
 * Anonymous MMC AI preview analysis. Files are processed in memory only:
 * no project record, no storage write, no audit record and no public file URL.
 * This endpoint returns conservative text/OCR evidence, never certified quantities.
 */
const express=require('express');
const multer=require('multer');
const path=require('node:path');
const {extractPdfText}=require('../lib/mmc-ai/pdf-text-extract');
const {analyzePdfDrawingText}=require('../lib/mmc-ai/pdf-drawing-text-intelligence');
const {preflightPdf}=require('../lib/mmc-ai/pdf-preflight');
const {ocrPdf,ocrImage}=require('../lib/mmc-ai/ocr-engine');
const router=express.Router();
const MAX_BYTES=25*1024*1024;
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_BYTES,files:1,fields:0}});
const hits=new Map();
let active=0;
function rateLimit(req,res,next){
 const key=String(req.ip||req.socket?.remoteAddress||'unknown');
 const now=Date.now(),entry=hits.get(key)||{start:now,count:0};
 if(now-entry.start>60000){entry.start=now;entry.count=0;}
 entry.count++;hits.set(key,entry);
 if(hits.size>2000)for(const [k,v] of hits)if(now-v.start>60000)hits.delete(k);
 if(entry.count>8)return res.status(429).json({error:{message:'تم بلوغ حد المعاينة المؤقت. حاول بعد دقيقة.'}});
 if(active>=1)return res.status(429).json({error:{message:'هناك عملية تحليل تجريبية أخرى قيد التنفيذ. أعد المحاولة بعد قليل.'}});
 next();
}
function fail(res,status,message,code){return res.status(status).json({error:{message,code}});}
router.post('/analyze',rateLimit,upload.single('drawing'),async(req,res)=>{
 active++;
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Robots-Tag','noindex, nofollow');
 try{
  const file=req.file;
  if(!file)return fail(res,400,'اختر ملف PDF أو PNG أو JPG أولاً.','FILE_REQUIRED');
  const ext=path.extname(file.originalname||'').toLowerCase();
  const bytes=file.buffer;
  let extraction,preflight=null,analysis;
  if(ext==='.pdf'){
   if(bytes.length<5||bytes.subarray(0,5).toString('ascii')!=='%PDF-')return fail(res,400,'محتوى PDF غير صالح.','INVALID_PDF');
   preflight=preflightPdf(bytes);
   if(preflight.encrypted)return fail(res,422,'الملف محمي بكلمة مرور ولا يمكن تحليله في المعاينة.','PDF_ENCRYPTED');
   extraction=extractPdfText(bytes);
   if(!extraction.text){
    try{
     const ocr=await ocrPdf(bytes,{maxPages:3,dpi:120});
     extraction={...extraction,text:ocr.text||'',ocrPerformed:true,ocrPageCount:ocr.pagesProcessed||0,ocrAverageConfidence:ocr.averageConfidence||null,ocrWords:ocr.words||[],engine:ocr.engine||extraction.engine};
    }catch(error){
     extraction.ocrUnavailable=error.code||error.message;
    }
   }
  }else if(ext==='.png'||ext==='.jpg'||ext==='.jpeg'){
   const valid=ext==='.png'?bytes.length>8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
   if(!valid)return fail(res,400,'امتداد الصورة لا يطابق محتواها.','INVALID_IMAGE');
   const ocr=await ocrImage(bytes,{mimeType:ext==='.png'?'image/png':'image/jpeg'});
   extraction={engine:ocr.engine,text:ocr.text||'',characterCount:(ocr.text||'').length,ocrPerformed:true,ocrPageCount:1,ocrAverageConfidence:ocr.averageConfidence||null,ocrWords:ocr.words||[],pageCount:1};
  }else{
   return fail(res,415,'المعاينة التحليلية تدعم حالياً PDF وPNG وJPG فقط. قراءة DXF الهندسية ستضاف بعد اختبار محلل الطبقات.','UNSUPPORTED_FORMAT');
  }
  analysis=analyzePdfDrawingText(extraction,{});
  const dimensions=analysis.metadata.explicitDimensionCallouts||[];
  const spatialDimensions=analysis.metadata.ocrSpatialDimensionCandidates||[];
  res.json({
   file:{name:path.basename(file.originalname||'drawing'),bytes:bytes.length,format:ext.slice(1)},
   preflight,
   extraction:{engine:extraction.engine||null,status:extraction.status|| (extraction.text?'text_extracted':'no_text_found'),pageCount:extraction.pageCount||1,characterCount:extraction.characterCount||0,ocrPerformed:extraction.ocrPerformed===true,ocrPageCount:extraction.ocrPageCount||0,ocrAverageConfidence:extraction.ocrAverageConfidence||null,diagnostics:extraction.diagnostics||null},
   analysis:{status:analysis.status,disciplineClues:analysis.metadata.disciplineClues,titleCandidates:analysis.metadata.titleCandidates,sheetNumbers:analysis.metadata.textualSheetNumberCandidates,revisions:analysis.metadata.textualRevisionCandidates,scaleCandidates:analysis.metadata.textualScaleCandidates,explicitDimensionCallouts:dimensions,ocrDimensionCandidates:spatialDimensions,detailReferences:analysis.metadata.detailAndSectionReferenceCandidates,scheduleMentions:analysis.metadata.scheduleTypeMentions,conflicts:analysis.conflicts,evidence:analysis.evidence,unresolved:analysis.unresolved},
   quantities:[],bim:{created:false,ifcValidated:false},
   notice:'هذه قراءة أولية للأدلة النصية وOCR فقط. لا تمثل حصر كميات أو اعتماداً هندسياً، ولا تستنتج القياس من مقياس الرسم. لم يتم حفظ الملف أو إرساله إلى مساحة مشروع.'
  });
 }catch(error){
  const status=error.code==='OCR_BUSY'?429:error.code==='OCR_RUNTIME_UNAVAILABLE'?503:422;
  fail(res,status,error.message||'تعذر تحليل الملف.',error.code||'PREVIEW_ANALYSIS_FAILED');
 }finally{active--;}
});
module.exports=router;
