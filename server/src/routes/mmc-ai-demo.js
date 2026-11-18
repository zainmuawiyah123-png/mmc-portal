'use strict';
/* Anonymous, stateless preview only. Never accepts project IDs or persists uploads. */
const express=require('express');
const multer=require('multer');
const path=require('path');
const {ocrPdf,ocrImage}=require('../lib/mmc-ai/ocr-engine');
const {takeoffDxf}=require('../lib/mmc-ai/dxf-takeoff');
const {extractPdfText}=require('../lib/mmc-ai/pdf-text-extract');
const {extractPdfTextSpatial}=require('../lib/mmc-ai/pdf-text-spatial-extract');
const {inspectPdfVectorPage}=require('../lib/mmc-ai/pdf-pdf-vector-extract');
const {analyzePdfDrawingText}=require('../lib/mmc-ai/pdf-drawing-text-intelligence');
const {clusterVectorPaths}=require('../lib/mmc-ai/pdf-vector-clustering');
const router=express.Router();
const MAX=25*1024*1024;
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX,files:1,fields:0}});
const attempts=new Map();
function summarizeVectorLayout(paths,viewBox){
 const bounds=paths.map(p=>p.bounds).filter(Boolean);
 if(!bounds.length)return {status:'no_bounds',grid:[],overallBounds:null};
 const overallBounds={minX:Math.min(...bounds.map(b=>b.minX)),minY:Math.min(...bounds.map(b=>b.minY)),maxX:Math.max(...bounds.map(b=>b.maxX)),maxY:Math.max(...bounds.map(b=>b.maxY))};
 const vb=Array.isArray(viewBox)&&viewBox.length===4&&viewBox.every(Number.isFinite)&&viewBox[2]>0&&viewBox[3]>0
  ?{minX:viewBox[0],minY:viewBox[1],maxX:viewBox[0]+viewBox[2],maxY:viewBox[1]+viewBox[3]}:overallBounds;
 const cols=6,rows=6,cells=Array.from({length:rows*cols},(_,i)=>({row:Math.floor(i/cols)+1,column:i%cols+1,total:0,closed:0,open:0}));
 for(const p of paths){const b=p.bounds;if(!b)continue;const x=Math.max(0,Math.min(cols-1,Math.floor((((b.minX+b.maxX)/2-vb.minX)/(vb.maxX-vb.minX))*cols)));const y=Math.max(0,Math.min(rows-1,Math.floor((((b.minY+b.maxY)/2-vb.minY)/(vb.maxY-vb.minY))*rows)));const cell=cells[y*cols+x];cell.total++;if(p.closed)cell.closed++;else cell.open++;}
 const occupied=cells.filter(x=>x.total).sort((a,b)=>b.total-a.total);
 const pageWidth=vb.maxX-vb.minX,pageHeight=vb.maxY-vb.minY,edgeX=pageWidth*0.015,edgeY=pageHeight*0.015;
 const edgeCandidates=[],interiorCandidates=[];
 for(let i=0;i<paths.length;i++){
  const b=paths[i].bounds;if(!b)continue;
  const onEdge=b.minX<=vb.minX+edgeX||b.maxX>=vb.maxX-edgeX||b.minY<=vb.minY+edgeY||b.maxY>=vb.maxY-edgeY;
  const item={pathIndex:i+1,closed:!!paths[i].closed,vertexCount:paths[i].vertexCount,bounds:b};
  (onEdge?edgeCandidates:interiorCandidates).push(item);
 }
 const largest=bounds.map((b,i)=>({pathIndex:i+1,bounds:b,width:b.maxX-b.minX,height:b.maxY-b.minY,closed:!!paths[i].closed,vertexCount:paths[i].vertexCount})).sort((a,b)=>(b.width*b.height)-(a.width*a.height)).slice(0,12);
 const profile={closed:0,open:0,triangles:0,quadrilaterals:0,polygons5Plus:0,rectilinearCandidates:0,roundShapeCandidates:0};
 const sizeFrequency=new Map();
 for(const p of paths){
  if(p.closed)profile.closed++;else profile.open++;
  const pts=p.points||[],n=pts.length;
  if(p.closed&&n>=3){
   if(n===3)profile.triangles++;else if(n===4)profile.quadrilaterals++;else profile.polygons5Plus++;
   let right=0,valid=0;
   for(let i=0;i<n;i++){
    const prev=pts[(i+n-1)%n],cur=pts[i],next=pts[(i+1)%n];
    const ax=prev.x-cur.x,ay=prev.y-cur.y,bx=next.x-cur.x,by=next.y-cur.y;
    const denom=Math.hypot(ax,ay)*Math.hypot(bx,by);
    if(denom>0){valid++;if(Math.abs((ax*bx+ay*by)/denom)<0.12)right++;}
   }
   const b=p.bounds,w=b.maxX-b.minX,h=b.maxY-b.minY,aspect=Math.max(w,h)/Math.max(1e-9,Math.min(w,h));
   const compactness=p.areaPageUnits2>0?4*Math.PI*p.areaPageUnits2/(p.lengthPageUnits*p.lengthPageUnits):0;
   if(valid>=3&&n<=10&&right/valid>=0.8)profile.rectilinearCandidates++;
   if(aspect<=1.18&&compactness>=0.78&&compactness<=1.15)profile.roundShapeCandidates++;
  }
  const b=p.bounds;if(b){const w=(b.maxX-b.minX).toFixed(3),h=(b.maxY-b.minY).toFixed(3),key=[w,h].sort().join('×');sizeFrequency.set(key,(sizeFrequency.get(key)||0)+1);}
 }
 const repeatedBoundingBoxSizes=[...sizeFrequency].filter(([,count])=>count>=3).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([size,count])=>({pageUnits:size,count}));
 return {status:'spatial_distribution_only_not_semantic_classification',coordinateSystem:'PDF/SVG page units; not millimetres or metres',overallBounds,pageBounds:vb,gridSize:{rows,columns:cols},occupiedCells:occupied.length,occupiedCellSummaries:occupied.slice(0,12),edgeBandAnalysis:{edgeBandPercent:1.5,edgeBandPathCount:edgeCandidates.length,interiorPathCount:interiorCandidates.length,edgeBandExamples:edgeCandidates.slice(0,20),notice:'Edge-band candidates may be page frames, crop marks, border decorations or drawing content; they are flagged for review, not deleted.'},shapeProfile:profile,repeatedBoundingBoxSizes,largestBoundingBoxes:largest,notice:'Shape counts are geometric pattern candidates only. They do not identify walls, slabs, footings, openings, rebar, title blocks or disciplines.'};
}
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
   }else if(ext==='.pdf'){
    let nativeText=null,vector=null,ocr=null,textIntelligence=null,spatialText=null;
    const diagnostics=[];
    try{nativeText=extractPdfText(f.buffer);}catch(e){diagnostics.push({stage:'native_pdf_text',error:e.message});}
    try{spatialText=await extractPdfTextSpatial(f.buffer,{pageNumber:1});}catch(e){diagnostics.push({stage:'spatial_pdf_text',error:e.message});}
    try{vector=await inspectPdfVectorPage(f.buffer,{pageNumber:1});}catch(e){diagnostics.push({stage:'pdf_vector_geometry',error:e.message});}
    const nativeChars=nativeText?.characterCount||0;
    // A vector frame or a few native labels do not prove that the drawing annotations are readable.
    // Run OCR when native text is absent or too sparse; keep vector extraction independent.
    const MIN_NATIVE_TEXT_CHARS=80;
    const ocrRequired=nativeChars<MIN_NATIVE_TEXT_CHARS;
    if(ocrRequired){
      try{ocr=await ocrPdf(f.buffer,{maxPages:1,dpi:140});}catch(e){diagnostics.push({stage:'pdf_ocr_fallback',error:e.message,reason:'native_text_below_threshold',nativeCharacterCount:nativeChars,minimumNativeCharacters:MIN_NATIVE_TEXT_CHARS});}
    }
    const ocrPages=Array.isArray(ocr?.pages)?ocr.pages:[];
    const ocrWords=ocrPages.flatMap(page=>(Array.isArray(page.words)?page.words:[]).map(word=>({...word,page:page.page})));
    const ocrText=ocrPages.map(page=>page.text||'').filter(Boolean).join('\\n');
    const textForIntelligence=(nativeText||ocrText)?{
      ...(nativeText||{}),
      text:[nativeText?.text||'',ocrText].filter(Boolean).join('\\n'),
      characterCount:(nativeText?.text||'').length+ocrText.length,
      ocrPerformed:ocrWords.length>0,
      ocrPageCount:ocrPages.filter(page=>page.wordCount>0).length,
      ocrWords
    }:null;
    if(textForIntelligence){
      try{textIntelligence=analyzePdfDrawingText(textForIntelligence);}catch(e){diagnostics.push({stage:'drawing_text_intelligence',error:e.message});}
    }
    const paths=(vector?.geometry?.paths||[]).map((path,index)=>{
      const xs=path.points.map(point=>point.x),ys=path.points.map(point=>point.y);
      return {pathIndex:index+1,closed:path.closed,vertexCount:path.vertexCount,points:path.points.map(point=>({x:point.x,y:point.y})),lengthPageUnits:path.lengthUnits,areaPageUnits2:path.areaSquareUnits,bounds:xs.length?{minX:Math.min(...xs),minY:Math.min(...ys),maxX:Math.max(...xs),maxY:Math.max(...ys)}:null};
    });
    const spatialOverview=summarizeVectorLayout(paths,vector?.svgViewBox);
    const spatialClusters=clusterVectorPaths(paths,{pageBounds:spatialOverview.pageBounds||spatialOverview.overallBounds});
    result={
      analysisType:'pdf_native_text_and_vector_geometry',
      status:(nativeChars>0||paths.length>0)?'pdf_evidence_extracted_requires_engineering_review':(ocr?.status||'pdf_no_readable_evidence'),
      sourceFormat:'PDF',
      engine:'mmc-pdf-native-text+poppler-svg-vector-v1',
      pageCount:nativeText?.pageCount||ocr?.totalPages||null,
      nativeText:{status:nativeText?.status||'unavailable',characterCount:nativeChars,text:(nativeText?.text||'').slice(0,20000),diagnostics:nativeText?.diagnostics||null,unsupportedFilters:nativeText?.unsupportedFilters??null},
      spatialText:{status:spatialText?.status||'unavailable',engine:spatialText?.engine||null,pageNumber:spatialText?.pageNumber||1,page:spatialText?.page||null,limitations:spatialText?.limitations||[],diagnostics:spatialText?.diagnostics||[]},
      drawingTextIntelligence:textIntelligence?{status:textIntelligence.status,metadata:textIntelligence.metadata,conflicts:textIntelligence.conflicts,unresolved:textIntelligence.unresolved}:null,
      vectorGeometry:{status:vector?.status||'unavailable',pageNumber:1,viewBox:vector?.svgViewBox||null,svgDimensions:vector?.svgDimensions||null,pathCount:paths.length,closedPathCount:paths.filter(path=>path.closed).length,openPathCount:paths.filter(path=>!path.closed).length,unsupportedPathCount:vector?.geometry?.unsupportedPathCount??null,spatialOverview,spatialClusters,paths:paths.slice(0,3000),limitations:vector?.geometry?.limitations||[]},
      ocrFallback:ocr?{status:ocr.status,pagesProcessed:ocr.pagesProcessed,characterCount:ocr.characterCount,pages:ocr.pages.map(page=>({page:page.page,wordCount:page.wordCount,text:page.text.slice(0,10000),averageConfidence:page.averageConfidence,status:page.status}))}:null,
      diagnostics,geometryExtracted:paths.length>0,scaleCalibrated:false,quantities:[],bimModelCreated:false,quantitiesAreContractuallyVerified:false,
      limitations:[...(nativeText?.limitations||[]),...(vector?.geometry?.limitations||[]),'تم تحليل الصفحة الأولى فقط في المعاينة.','إحداثيات ومساحات المسارات بوحدات صفحة PDF الخام وليست أمتاراً أو كميات تنفيذية.','لا يتم تصنيف المسارات تلقائياً إلى قواعد أو جدران أو بلاطات أو عناصر MEP.','المقياس يحتاج إلى بعد معلوم ومؤكد من اللوحة أو اعتماد المهندس قبل التحويل إلى قياسات فعلية.']
    };
   }else{
    const o=await ocrImage(f.buffer,{mime:ext==='.png'?'image/png':'image/jpeg',dpi:180});
    result={analysisType:'drawing_text_recognition',status:o.status,sourceFormat:ext.slice(1).toUpperCase(),engine:o.engine,languageModel:o.languageModel,pagesProcessed:o.pagesProcessed,totalPages:o.totalPages,truncatedAtPageLimit:o.truncatedAtPageLimit,characterCount:o.characterCount,pages:o.pages.map(p=>({page:p.page,wordCount:p.wordCount,averageConfidence:p.averageConfidence,text:p.text.slice(0,12000),words:p.words.slice(0,1500)})),geometryExtracted:false,quantities:[],bimModelCreated:false,limitations:[...(o.limitations||[]),'OCR يتعرف على النصوص ومواقع الكلمات فقط؛ لا يستخرج هندسة CAD أو كميات أو BIM.']};
   }
   res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');res.setHeader('X-Content-Type-Options','nosniff');
   res.json({ok:true,filename:path.basename(f.originalname||'drawing'),sizeBytes:f.size,persisted:false,projectCreated:false,result,notice:'معالجة مؤقتة فقط؛ لم يتم حفظ الملف أو اعتماد كميات.'});
  }catch(e){res.setHeader('Cache-Control','no-store');res.status(e.code==='OCR_BUSY'?503:422).json({error:{code:e.code||'DEMO_ANALYSIS_FAILED',message:e.message||'تعذر تحليل الملف.'}});}
 });
});
module.exports=router;
