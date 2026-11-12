'use strict';
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execFileAsync=promisify(execFile);
const MAX_INPUT=25*1024*1024;
const MAX_OUTPUT=2*1024*1024;

async function extractPdfTextPoppler(input,options={}){
 const bytes=Buffer.isBuffer(input)?input:Buffer.from(input||'');
 if(bytes.length<5||bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error('Invalid PDF header');
 if(bytes.length>MAX_INPUT)throw new Error('PDF exceeds extraction size limit');
 if(/\/Encrypt\b/.test(bytes.toString('latin1')))throw new Error('Encrypted PDFs are not supported');
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'mmc-pdf-text-'));
 const inputPath=path.join(tmp,'source.pdf');
 try{
  await fs.writeFile(inputPath,bytes,{mode:0o600});
  let stdout='';
  try{
   ({stdout}=await execFileAsync('pdftotext',['-layout','-enc','UTF-8',inputPath,'-'],{
    encoding:'utf8',timeout:options.timeoutMs||20000,maxBuffer:MAX_OUTPUT,windowsHide:true,
    env:{...process.env,LC_ALL:'C.UTF-8'}
   }));
  }catch(err){
   if(err&&err.code==='ENOENT')throw new Error('PDF text extraction is unavailable: Poppler (pdftotext) is not installed.');
   if(err&&err.killed)throw new Error('PDF text extraction timed out.');
   throw new Error('Poppler could not read this PDF. Check that it is valid, unencrypted, and not damaged.');
  }
  const text=String(stdout||'').replace(/\r\n?/g,'\n').replace(/\u0000/g,'').slice(0,MAX_OUTPUT).trim();
  const pageCount=text?text.split('\f').filter(page=>page.trim()).length:0;
  return {
   engine:'poppler-pdftotext-layout-v1',
   status:text?'partial_text_extracted':'no_text_found',
   pageCount:pageCount||null,
   characterCount:text.length,
   text:text.slice(0,250000),
   diagnostics:{extractionMethod:'pdftotext -layout',ocrPerformed:false},
   limitations:['Reads the PDF text layer only; OCR is not performed.','Extracted text does not by itself establish drawing scale, dimensions, or quantities.']
  };
 }finally{
  await fs.rm(tmp,{recursive:true,force:true}).catch(()=>{});
 }
}
module.exports={extractPdfTextPoppler};
