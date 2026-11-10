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
 const literal='\\((?:\\\\.|[^\\\\)])*\\)';
 const hex='<(?!<)[0-9a-fA-F\\s]+>';
 const atom='(?:'+literal+'|'+hex+')';
 const tj=new RegExp('('+atom+')\\s*Tj','g');
 let m;while((m=tj.exec(src)))out.push(decodePdfString(m[1]));
 const arrays=/\[([\s\S]*?)\]\s*TJ/g;
 while((m=arrays.exec(src))){const tokens=m[1].match(new RegExp(atom,'g'))||[];out.push(tokens.map(decodePdfString).join(''));}
 return out;
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
 while((match=streamRe.exec(source))){
  const dict=match[1],raw=Buffer.from(match[2],'latin1');let data=raw;
  if(/\/FlateDecode\b/.test(dict)){try{data=zlib.inflateSync(raw,{maxOutputLength:MAX_OUTPUT});}catch{continue;}}
  else if(/\/Filter\b/.test(dict)){unsupportedFilters++;continue;}
  decodedBytes+=data.length;if(decodedBytes>MAX_OUTPUT)throw new Error('PDF decoded content exceeds extraction size limit');
  streamCount++;const extracted=extractFromContent(data.toString('latin1'));chunks.push(...extracted);
 }
 const clean=chunks.join('\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'').trim();
 return {engine:'mmc-pdf-text-basic-v1',status:clean?'partial_text_extracted':'no_text_found',pageCount:pageCount||null,streamCount,text:clean.slice(0,250000),characterCount:clean.length,limitations:['استخراج أولي لنصوص Tj/TJ من تدفقات PDF فقط.','لا يستخرج OCR من الصور أو أبعاد CAD أو المقاييس أو الكميات.','لا يضمن ترميز الخطوط أو النصوص العربية في جميع ملفات PDF.','لا يدعم حالياً التشفير أو فلاتر الضغط غير FlateDecode أو object streams المعقدة.'],unsupportedFilters};
}
module.exports={extractPdfText};
