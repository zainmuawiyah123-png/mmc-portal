'use strict';
const zlib=require('node:zlib');
const MAX_INPUT=25*1024*1024;
const MAX_OUTPUT=20*1024*1024;
function decodePdfString(raw){
 if(raw.startsWith('<')&&!raw.startsWith('<<')){
  let hex=raw.slice(1,-1).replace(/\s/g,'');
  if(hex.length%2)hex+='0';
  const b=Buffer.from(hex,'hex');
  if(b.length>=2&&b[0]===0xfe&&b[1]===0xff){let s='';for(let i=2;i+1<b.length;i+=2)s+=String.fromCharCode(b.readUInt16BE(i));return s;}
  return b.toString('latin1');
 }
 let s=raw.slice(1,-1).replace(/\\([nrtbf()\\])/g,(_,c)=>({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f','(':'(',')':')','\\':'\\'}[c]));
 s=s.replace(/\\([0-7]{1,3})/g,(_,o)=>String.fromCharCode(parseInt(o,8))).replace(/\\\r?\n/g,'');
 return s;
}
function extractFromContent(src){
 const out=[];
 const literal=/\((?:\\.|[^\\)])*\)/g;
 const hex=/<(?!<)[0-9a-fA-F\s]+>/g;
 const tokens=[];
 let m;while((m=literal.exec(src)))tokens.push({at:m.index,value:m[0]});
 while((m=hex.exec(src)))tokens.push({at:m.index,value:m[0]});
 tokens.sort((a,b)=>a.at-b.at);
 for(const token of tokens){
  const tail=src.slice(token.at+token.value.length);
  if(/^\s*Tj\b/.test(tail))out.push(decodePdfString(token.value));
  else if(/^\s*(?:[-+]?\d+(?:\.\d+)?\s*)*TJ\b/.test(tail)){
   const arr=src.slice(Math.max(0,src.lastIndexOf('[',token.at)),src.indexOf(']',token.at)+1);
   if(arr.includes(token.value))continue;
  }
 }
 const arrays=/\[([\s\S]*?)\]\s*TJ/g;
 while((m=arrays.exec(src))){const vals=m[1].match(/\((?:\\.|[^\\)])*\)|<(?!<)[0-9a-fA-F\s]+>/g)||[];out.push(vals.map(decodePdfString).join(''));}
 return out;
}
function inspectContentOperators(src){
 const masked=src.replace(/%[^\r\n]*/g,' ').replace(/\((?:\\.|[^\\)])*\)/g,' ').replace(/<(?!<)[0-9a-fA-F\s]+>/g,' ');
 const tokenRe=/[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z*]+/g;
 const tokens=masked.match(tokenRe)||[],counts={},numbers=[];
 const points=[];
 for(const token of tokens){
  if(/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(token)){numbers.push(Number(token));continue;}
  counts[token]=(counts[token]||0)+1;
  const take=(n)=>numbers.splice(Math.max(0,numbers.length-n),n);
  const add=(x,y)=>{if(Number.isFinite(x)&&Number.isFinite(y))points.push([x,y]);};
  if(token==='m'||token==='l'){const a=take(2);if(a.length===2)add(a[0],a[1]);}
  else if(token==='c'){const a=take(6);if(a.length===6){add(a[0],a[1]);add(a[2],a[3]);add(a[4],a[5]);}}
  else if(token==='v'||token==='y'){const a=take(4);if(a.length===4){add(a[0],a[1]);add(a[2],a[3]);}}
  else if(token==='re'){const a=take(4);if(a.length===4){const [x,y,w,h]=a;add(x,y);add(x+w,y+h);}}
  else if(['h','S','s','f','F','f*','B','B*','b','b*','n','Do','BT','ET','Tj','TJ','q','Q','cm','w'].includes(token))numbers.length=0;
 }
 const pathOps=['m','l','c','v','y','h','re','S','s','f','F','f*','B','B*','b','b*','n'];
 const vectorPathOperators=pathOps.reduce((sum,key)=>sum+(counts[key]||0),0);
 const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
 return {vectorPathOperators,moveTo:counts.m||0,lineTo:counts.l||0,curveTo:(counts.c||0)+(counts.v||0)+(counts.y||0),rectangles:counts.re||0,closePath:counts.h||0,paintOperations:['S','s','f','F','f*','B','B*','b','b*'].reduce((sum,key)=>sum+(counts[key]||0),0),imageXObjectCalls:counts.Do||0,textShowingOperations:(counts.Tj||0)+(counts.TJ||0),graphicsStateSaves:counts.q||0,graphicsStateRestores:counts.Q||0,coordinateTransforms:counts.cm||0,lineWidthChanges:counts.w||0,rawCoordinateBounds:points.length?{minX:Math.min(...xs),minY:Math.min(...ys),maxX:Math.max(...xs),maxY:Math.max(...ys)}:null,coordinatePointCount:points.length};
}
function extractPdfText(input){
 const bytes=Buffer.isBuffer(input)?input:Buffer.from(input||'');
 if(bytes.length<5||bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error('Invalid PDF header');
 if(bytes.length>MAX_INPUT)throw new Error('PDF exceeds extraction size limit');
 const source=bytes.toString('latin1');
 if(/\/Encrypt\b/.test(source))throw new Error('Encrypted PDFs are not supported');
 const pageCount=(source.match(/\/Type\s*\/Page\b/g)||[]).length;
 const chunks=[];
 const streamRe=/<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
 let match,decodedBytes=0,streamCount=0,unsupportedFilters=0;
 const diagnostics={vectorPathOperators:0,moveTo:0,lineTo:0,curveTo:0,rectangles:0,closePath:0,paintOperations:0,imageXObjectCalls:0,textShowingOperations:0,graphicsStateSaves:0,graphicsStateRestores:0,coordinateTransforms:0,lineWidthChanges:0,rawCoordinateBounds:null,coordinatePointCount:0};
 while((match=streamRe.exec(source))){
  const dict=match[1],raw=Buffer.from(match[2],'latin1');let data=raw;
  if(/\/FlateDecode\b/.test(dict)){try{data=zlib.inflateSync(raw,{maxOutputLength:MAX_OUTPUT});}catch{continue;}}
  else if(/\/Filter\b/.test(dict)){unsupportedFilters++;continue;}
  decodedBytes+=data.length;if(decodedBytes>MAX_OUTPUT)throw new Error('PDF decoded content exceeds size limit');
  streamCount++;
  const content=data.toString('latin1');
  const metrics=inspectContentOperators(content);
  for(const key of Object.keys(diagnostics)){
   if(key==='rawCoordinateBounds'){
    const b=metrics.rawCoordinateBounds;
    if(b){const old=diagnostics.rawCoordinateBounds;diagnostics.rawCoordinateBounds=old?{minX:Math.min(old.minX,b.minX),minY:Math.min(old.minY,b.minY),maxX:Math.max(old.maxX,b.maxX),maxY:Math.max(old.maxY,b.maxY)}:b;}
   }else diagnostics[key]+=metrics[key]||0;
  }
  chunks.push(...extractFromContent(content));
 }
 const clean=chunks.join('\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'').trim();
 return {engine:'mmc-pdf-text-basic-v1',status:clean?'partial_text_extracted':'no_text_found',pageCount:pageCount||null,streamCount,text:clean.slice(0,250000),characterCount:clean.length,diagnostics,limitations:['استخراج أولي لنصوص Tj/TJ من تدفقات PDF فقط.','الإحداثيات خام ضمن فضاء محتوى PDF؛ لا تُطبق عليها جميع مصفوفات التحويل أو CropBox/Rotate.','لا يستخرج OCR من الصور أو أبعاد CAD أو المقاييس أو الكميات.','لا يضمن ترميز الخطوط أو النصوص العربية في جميع ملفات PDF.','لا يدعم حالياً التشفير أو فلاتر الضغط غير FlateDecode أو object streams المعقدة.'],unsupportedFilters};
}
module.exports={extractPdfText};
