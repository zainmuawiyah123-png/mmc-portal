'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process');const {promisify}=require('node:util');
const run=promisify(execFile),MAX=25*1024*1024;
async function extractPdfTextPoppler(input,options={}){
 const bytes=Buffer.isBuffer(input)?input:Buffer.from(input||'');
 if(bytes.length<5||bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error('Invalid PDF header');
 if(bytes.length>MAX)throw new Error('PDF exceeds extraction size limit');
 if(/\/Encrypt\b/.test(bytes.toString('latin1')))throw new Error('Encrypted PDFs are not supported');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mmc-pdf-')),file=path.join(dir,'source.pdf');
 try{
  await fs.writeFile(file,bytes,{mode:0o600});let stdout='';
  try{({stdout}=await run('pdftotext',['-layout','-enc','UTF-8',file,'-'],{encoding:'utf8',timeout:options.timeoutMs||20000,maxBuffer:2*1024*1024,windowsHide:true,env:{...process.env,LC_ALL:'C.UTF-8'}}));}
  catch(e){if(e.code==='ENOENT')throw new Error('Poppler (pdftotext) is not installed.');if(e.killed)throw new Error('PDF text extraction timed out.');throw new Error('Poppler could not read this PDF.');}
  const text=String(stdout||'').replace(/\r\n?/g,'\n').replace(/\u0000/g,'').slice(0,250000).trim();
  return {engine:'poppler-pdftotext-layout-v1',status:text?'partial_text_extracted':'no_text_found',pageCount:text?text.split('\f').filter(x=>x.trim()).length:0,characterCount:text.length,text,diagnostics:{extractionMethod:'pdftotext -layout',ocrPerformed:false},limitations:['Reads the PDF text layer only; OCR is not performed.','Text extraction alone does not establish dimensions or quantities.']};
 }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
module.exports={extractPdfTextPoppler};