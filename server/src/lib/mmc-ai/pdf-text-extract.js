'use strict';
const zlib=require('node:zlib');
const MAX_INPUT=25*1024*1024;
const MAX_OUTPUT=20*1024*1024;
function decodePdfString(raw){
 let bytes;
 if(raw.startsWith('<')&&!raw.startsWith('<<')){
  let hex=raw.slice(1,-1).replace(/\s/g,'');
  if(hex.length%2)hex+='0';
  bytes=Buffer.from(hex,'hex');
 }else{
  const body=raw.slice(1,-1),out=[];
  for(let i=0;i<body.length;i++){
   const ch=body[i];
   if(ch!=='\\'){out.push(body.charCodeAt(i)&255);continue;}
   if(i+1>=body.length)continue;
   const next=body[++i];
   const simple={n:10,r:13,t:9,b:8,f:12,'(':40,')':41,'\\':92};
   if(Object.prototype.hasOwnProperty.call(simple,next)){out.push(simple[next]);continue;}
   if(/[0-7]/.test(next)){
    let oct=next;
    while(oct.length<3&&i+1<body.length&&/[0-7]/.test(body[i+1]))oct+=body[++i];
    out.push(parseInt(oct,8)&255);continue;
   }
   if(next==='\r'||next==='\n'){
    if(next==='\r'&&body[i+1]==='\n')i++;
    continue;
   }
   out.push(next.charCodeAt(0)&255);
  }
  bytes=Buffer.from(out);
 }
 if(bytes.length>=2&&bytes[0]===0xfe&&bytes[1]===0xff){
  let s='';for(let i=2;i+1<bytes.length;i+=2)s+=String.fromCharCode(bytes.readUInt16BE(i));return s;
 }
 if(bytes.length>=2&&bytes[0]===0xff&&bytes[1]===0xfe){
  let s='';for(let i=2;i+1<bytes.length;i+=2)s+=String.fromCharCode(bytes.readUInt16LE(i));return s;
 }
 return bytes.toString('latin1');
}
function stripPdfComments(src){
 let out='',inLiteral=false,depth=0,escaped=false,inHex=false;
 for(let i=0;i<src.length;i++){
  const ch=src[i],next=src[i+1];
  if(inLiteral){
   out+=ch;
   if(escaped){escaped=false;continue;}
   if(ch==='\\'){escaped=true;continue;}
   if(ch==='(')depth++;
   else if(ch===')'&&--depth===0)inLiteral=false;
   continue;
  }
  if(inHex){
   out+=ch;if(ch==='>')inHex=false;continue;
  }
  if(ch==='('){inLiteral=true;depth=1;out+=ch;continue;}
  if(ch==='<'&&next!=='<'){inHex=true;out+=ch;continue;}
  if(ch==='%' ){while(i<src.length&&src[i]!=='\n'&&src[i]!=='\r'){out+=' ';i++;}if(i<src.length)out+=src[i];continue;}
  out+=ch;
 }
 return out;
}
function extractFromContent(src){
 const out=[];
 src=stripPdfComments(src);
 const re=/\[(?:\s*(?:\((?:\\[\s\S]|[^\\)])*\)|<(?!<)[0-9a-fA-F\s]+>|[-+]?(?:\d+\.?\d*|\.\d+))\s*)*\]\s*TJ|\((?:\\[\s\S]|[^\\)])*\)|<(?!<)[0-9a-fA-F\s]+>/g;
 let m;
 while((m=re.exec(src))){
  const token=m[0];
  if(token[0]==='['){
   const vals=token.slice(1,token.lastIndexOf(']')).match(/\((?:\\[\s\S]|[^\\)])*\)|<(?!<)[0-9a-fA-F\s]+>/g)||[];
   out.push(vals.map(decodePdfString).join(''));
   continue;
  }
  const tail=src.slice(re.lastIndex);
  if(/^\s*Tj\b/.test(tail)||/^\s*['"]/.test(tail))out.push(decodePdfString(token));
 }
 return out;
}
function tokenizeContentStream(src){
 const tokens=[];
 const re=/%[^\r\n]*|\((?:\\[\s\S]|[^\\)])*\)|<(?!<)[0-9a-fA-F\s]*>|\/[^\s<>()\[\]{}%]+|[-+]?(?:\d+\.?\d*|\.\d+)|['"]|[A-Za-z][A-Za-z0-9*']*/g;
 let match;
 while((match=re.exec(src))){
  const value=match[0];
  if(value[0]==='%')continue;
  if(value[0]==='('||value[0]==='<'||value[0]==='/')continue;
  tokens.push(value);
 }
 return tokens;
}
function inspectContentOperators(src){
 const tokens=tokenizeContentStream(src),counts={},numbers=[],points=[],transformedPoints=[];
 const operators=new Set(['m','l','c','v','y','h','re','S','s','f','F','f*','B','B*','b','b*','n','Do','BT','ET','Tj','TJ',"'",'"','q','Q','cm','w','Tc','Tw','Tz','TL','Tf','Tr','Ts','Td','TD','Tm','T*','W','W*','J','j','M','d','ri','i','gs','sh','CS','cs','SC','SCN','sc','scn','G','g','RG','rg','K','k']);
 const identity=[1,0,0,1,0,0],stack=[];
 let ctm=identity.slice();
 const transform=(x,y)=>[ctm[0]*x+ctm[2]*y+ctm[4],ctm[1]*x+ctm[3]*y+ctm[5]];
 const add=(x,y)=>{if(Number.isFinite(x)&&Number.isFinite(y)){points.push([x,y]);transformedPoints.push(transform(x,y));}};
 const concat=(m)=>{const [a,b,c,d,e,f]=m,[A,B,C,D,E,F]=ctm;ctm=[a*A+c*B,b*A+d*B,a*C+c*D,b*C+d*D,a*E+c*F+e,b*E+d*F+f];};
 for(const token of tokens){
  if(/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(token)){numbers.push(Number(token));continue;}
  if(!operators.has(token))continue;
  counts[token]=(counts[token]||0)+1;
  const take=n=>numbers.splice(Math.max(0,numbers.length-n),n);
  if(token==='q'){stack.push(ctm.slice());}
  else if(token==='Q'){if(stack.length)ctm=stack.pop();}
  else if(token==='cm'){const a=take(6);if(a.length===6)concat(a);}
  else if(token==='m'||token==='l'){const a=take(2);if(a.length===2)add(a[0],a[1]);}
  else if(token==='c'){const a=take(6);if(a.length===6){add(a[0],a[1]);add(a[2],a[3]);add(a[4],a[5]);}}
  else if(token==='v'||token==='y'){const a=take(4);if(a.length===4){add(a[0],a[1]);add(a[2],a[3]);}}
  else if(token==='re'){const a=take(4);if(a.length===4){const [x,y,w,h]=a;add(x,y);add(x+w,y+h);}}
  numbers.length=0;
 }
 const pathOps=['m','l','c','v','y','h','re','S','s','f','F','f*','B','B*','b','b*','n'];
 const vectorPathOperators=pathOps.reduce((sum,key)=>sum+(counts[key]||0),0);
 const bounds=list=>{if(!list.length)return null;const xs=list.map(p=>p[0]),ys=list.map(p=>p[1]);return {minX:Math.min(...xs),minY:Math.min(...ys),maxX:Math.max(...xs),maxY:Math.max(...ys)};};
 return {vectorPathOperators,moveTo:counts.m||0,lineTo:counts.l||0,curveTo:(counts.c||0)+(counts.v||0)+(counts.y||0),rectangles:counts.re||0,closePath:counts.h||0,paintOperations:['S','s','f','F','f*','B','B*','b','b*'].reduce((sum,key)=>sum+(counts[key]||0),0),imageXObjectCalls:counts.Do||0,textShowingOperations:(counts.Tj||0)+(counts.TJ||0)+(counts["'"]||0)+(counts['"']||0),graphicsStateSaves:counts.q||0,graphicsStateRestores:counts.Q||0,coordinateTransforms:counts.cm||0,lineWidthChanges:counts.w||0,rawCoordinateBounds:bounds(points),coordinatePointCount:points.length,transformedCoordinateBounds:bounds(transformedPoints),transformedCoordinatePointCount:transformedPoints.length,transformationCoverage:'partial_path_points_q_Q_cm_only'};
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
 const diagnostics={vectorPathOperators:0,moveTo:0,lineTo:0,curveTo:0,rectangles:0,closePath:0,paintOperations:0,imageXObjectCalls:0,textShowingOperations:0,graphicsStateSaves:0,graphicsStateRestores:0,coordinateTransforms:0,lineWidthChanges:0,rawCoordinateBounds:null,coordinatePointCount:0,transformedCoordinateBounds:null,transformedCoordinatePointCount:0,transformationCoverage:'partial_path_points_q_Q_cm_only'};
 while((match=streamRe.exec(source))){
  const dict=match[1],raw=Buffer.from(match[2],'latin1');let data=raw;
  if(/\/FlateDecode\b/.test(dict)){try{data=zlib.inflateSync(raw,{maxOutputLength:MAX_OUTPUT});}catch{continue;}}
  else if(/\/Filter\b/.test(dict)){unsupportedFilters++;continue;}
  decodedBytes+=data.length;if(decodedBytes>MAX_OUTPUT)throw new Error('PDF decoded content exceeds size limit');
  streamCount++;
  const content=data.toString('latin1');
  const metrics=inspectContentOperators(content);
  for(const key of Object.keys(diagnostics)){
   if(key==='transformationCoverage')continue;
   if(key==='rawCoordinateBounds'||key==='transformedCoordinateBounds'){
    const b=metrics[key];
    if(b){const old=diagnostics[key];diagnostics[key]=old?{minX:Math.min(old.minX,b.minX),minY:Math.min(old.minY,b.minY),maxX:Math.max(old.maxX,b.maxX),maxY:Math.max(old.maxY,b.maxY)}:b;}
   }else diagnostics[key]+=metrics[key]||0;
  }
  chunks.push(...extractFromContent(content));
 }
 const clean=chunks.join('\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'').trim();
 return {engine:'mmc-pdf-text-basic-v1',status:clean?'partial_text_extracted':'no_text_found',pageCount:pageCount||null,streamCount,text:clean.slice(0,250000),characterCount:clean.length,diagnostics,limitations:['استخراج أولي لنصوص Tj/TJ من تدفقات PDF فقط.','rawCoordinateBounds تبقى خاماً؛ transformedCoordinateBounds يطبق فقط q/Q/cm على نقاط المسارات المعروفة، ولا يغطي text matrices أو clipping أو CropBox/Rotate أو جميع دلالات PDF.','لا يستخرج OCR من الصور أو أبعاد CAD أو المقاييس أو الكميات.','يدعم BOM للنصوص UTF-16BE/LE فقط؛ لا يطبق PDFDocEncoding أو خرائط ToUnicode/CMap الخاصة بالخطوط، وقد تظهر العربية المشكّلة أو بعض الخطوط بترميز غير صحيح.','لا يدعم حالياً التشفير أو فلاتر الضغط غير FlateDecode أو object streams المعقدة.'],unsupportedFilters};
}
module.exports={extractPdfText};
