'use strict';
/* Anonymous, stateless preview only. Never accepts project IDs or persists uploads. */
const express=require('express');
const multer=require('multer');
const path=require('path');
const {ocrPdf,ocrImage}=require('../lib/mmc-ai/ocr-engine');
const {takeoffDxf}=require('../lib/mmc-ai/dxf-takeoff');
const router=express.Router();
const MAX=25*1024*1024;
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX,files:1,fields:0}});
const attempts=new Map();
function valid(file,ext){
 const b=file.buffer;
 if(ext==='.pdf')return b.length>=5&&b.subarray(0,5).toString('ascii')==='%PDF-';
 if(ext==='.png')return b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(ext==='.jpg'||ext==='.jpeg')return b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255;
 if(ext==='.dxf'){const h=b.subarray(0,4096).toString('utf8').replace(/^\uFEFF/,'');return !h.includes('\u0000')&&/(?:^|\r?\n)\s*0\s*\r?\nSECTION\s*\r?\n2\s*\r?\n(?:HEADER|TABLES|BLOCKS|ENTITIES)/i.test(h);}
 return false;
}
router.post('/demo/analyze',(req,res)=>{
 const key=String(req.ip||req.socket?.remoteAddress||'unknown'),now=Date.now();
 let a=attempts.get(key)||{start:now,count:0};
 if(now-a.start>600000)a={start:now,count:0};
 if(++a.count>8){attempts.set(key,a);res.setHeader('Retry-After','600');return res.status(429).json({error:{message:'تم بلوغ حد التجربة المؤقتة. حاول بعد عشر دقائق.'}});}
 attempts.set(key,a);
 upload.single('drawing')(req,res,async err=>{
  try{
   if(err)return res.status(err.code==='LIMIT_FILE_SIZE'?413:400).json({error:{message:err.code==='LIMIT_FILE_SIZE'?'الحد الأقصى 25 ميغابايت.':'تعذر استقبال الملف.'}});
   const f=req.file;if(!f)return res.status(400).json({error:{message:'اختر ملف مخطط أولاً.'}});
   const ext=path.extname(f.originalname||'').toLowerCase();
   if(!['.pdf','.dxf','.png','.jpg','.jpeg'].includes(ext)||!valid(f,ext))return res.status(415).json({error:{message:'ملف غير صالح. الصيغ المدعومة PDF وASCII DXF وPNG وJPG.'}});
   let result;
   if(ext==='.dxf'){
    try{
     const m=takeoffDxf(f.buffer.toString('utf8').replace(/^\uFEFF/,''));
     result={analysisType:'dxf_geometry_measurement',status:'geometry_measured_needs_classification_and_review',sourceFormat:'DXF',engine:m.engine,units:m.units,summary:m.summary,byLayer:m.byLayer,unsupported:m.unsupported,rows:m.rows.slice(0,5000),truncatedRows:m.rows.length>5000,quantitiesAreContractuallyVerified:false,bimModelCreated:false,limitations:[...(m.limitations||[]),'القياسات حسب وحدات DXF فقط؛ لا يوجد تصنيف تلقائي للعناصر الإنشائية أو المعمارية أو MEP.','لا يتم إصدار BOQ دون تصنيف العناصر ومراجعة المهندس.']};
    }catch(e){result={analysisType:'dxf_geometry_measurement',status:'measurement_blocked',sourceFormat:'DXF',reason:e.message,quantities:[],bimModelCreated:false,requiredInformation:['تحديد وحدة الرسم الصحيحة أو تصدير DXF مع INSUNITS موثوق.'],limitations:['لن يتم افتراض المقياس أو تخمين الوحدات.']};}
   }else{
    const o=ext==='.pdf'?await ocrPdf(f.buffer,{maxPages:10,dpi:160}):await ocrImage(f.buffer,{mime:ext==='.png'?'image/png':'image/jpeg',dpi:180});
    result={analysisType:'drawing_text_recognition',status:o.status,sourceFormat:ext.slice(1).toUpperCase(),engine:o.engine,languageModel:o.languageModel,pagesProcessed:o.pagesProcessed,totalPages:o.totalPages,truncatedAtPageLimit:o.truncatedAtPageLimit,characterCount:o.characterCount,pages:o.pages.map(p=>({page:p.page,wordCount:p.wordCount,averageConfidence:p.averageConfidence,text:p.text.slice(0,12000),words:p.words.slice(0,1500)})),geometryExtracted:false,quantities:[],bimModelCreated:false,limitations:[...(o.limitations||[]),'OCR يتعرف على النصوص ومواقع الكلمات فقط؛ لا يستخرج هندسة CAD أو كميات أو BIM.']};
   }
   res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');res.setHeader('X-Content-Type-Options','nosniff');
   res.json({ok:true,filename:path.basename(f.originalname||'drawing'),sizeBytes:f.size,persisted:false,projectCreated:false,result,notice:'معالجة مؤقتة فقط؛ لم يتم حفظ الملف أو اعتماد كميات.'});
  }catch(e){res.setHeader('Cache-Control','no-store');res.status(e.code==='OCR_BUSY'?503:422).json({error:{code:e.code||'DEMO_ANALYSIS_FAILED',message:e.message||'تعذر تحليل الملف.'}});}
 });
});
module.exports=router;
