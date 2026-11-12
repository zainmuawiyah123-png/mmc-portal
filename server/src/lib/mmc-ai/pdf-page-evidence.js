'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const MAX_BYTES = 25 * 1024 * 1024;

function parsePdfInfo(source) {
  const text = String(source || '');
  const pageCount = Number(text.match(/^Pages:\s*(\d+)/mi)?.[1] || 0);
  const pages = [];
  const re = /^Page\s+(\d+)\s+size:\s*([\d.]+)\s+x\s+([\d.]+)\s+pts/gmi;
  let m;
  while ((m = re.exec(text))) pages.push({ page: Number(m[1]), mediaWidthPt: Number(m[2]), mediaHeightPt: Number(m[3]) });
  const rotations = new Map();
  const rr = /^Page\s+(\d+)\s+rot:\s*(-?\d+)/gmi;
  while ((m = rr.exec(text))) rotations.set(Number(m[1]), Number(m[2]));
  const boxes = new Map();
  const br = /^Page\s+(\d+)\s+(MediaBox|CropBox):\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/gmi;
  while ((m = br.exec(text))) {
    const n = Number(m[1]), key = m[2].toLowerCase();
    if (!boxes.has(n)) boxes.set(n, {});
    boxes.get(n)[key] = { xMin: Number(m[3]), yMin: Number(m[4]), xMax: Number(m[5]), yMax: Number(m[6]) };
  }
  return { pageCount: Number.isInteger(pageCount) && pageCount > 0 ? pageCount : null,
    pages: pages.map(p => ({ ...p, rotationDegrees: rotations.get(p.page) ?? 0, ...(boxes.get(p.page) || {}) })) };
}
function decodeXml(s) {
  return String(s || '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}
function parseBboxXhtml(source) {
  const pages = [];
  const pr = /<page\b([^>]*)>([\s\S]*?)<\/page>/gi;
  let p;
  while ((p = pr.exec(String(source || '')))) {
    const attr = (s, n) => { const m = s.match(new RegExp('\\b' + n + '="([\\d.]+)"','i')); return m ? Number(m[1]) : null; };
    const words = [], wr = /<word\b([^>]*)>([\s\S]*?)<\/word>/gi;
    let w;
    while ((w = wr.exec(p[2]))) {
      const num = n => { const m = w[1].match(new RegExp('\\b' + n + '="([-\\d.]+)"','i')); return m ? Number(m[1]) : null; };
      const box = { xMin:num('xMin'), yMin:num('yMin'), xMax:num('xMax'), yMax:num('yMax') };
      if (Object.values(box).every(Number.isFinite)) {
        const text = decodeXml(w[2].replace(/<[^>]+>/g,'')).trim();
        if (text) words.push({ text, box });
      }
    }
    pages.push({ widthPt:attr(p[1],'width'), heightPt:attr(p[1],'height'), words });
  }
  return pages;
}
async function inspectPdfPageEvidence(input, options = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  if (bytes.length < 5 || bytes.subarray(0,5).toString('ascii') !== '%PDF-') throw Object.assign(new Error('Invalid PDF header'),{code:'PDF_EVIDENCE_INVALID'});
  if (bytes.length > MAX_BYTES) throw Object.assign(new Error('PDF exceeds page-evidence size limit'),{code:'PDF_EVIDENCE_TOO_LARGE'});
  const maxPages = Math.min(100,Math.max(1,Number(options.maxPages)||100));
  const documentId = String(options.documentId || '').slice(0,160) || null;
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let dir;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(),'mmc-ai-page-evidence-'));
    const pdf = path.join(dir,'source.pdf');
    await fs.writeFile(pdf,bytes,{flag:'wx',mode:0o600});
    const infoOut = await run('pdfinfo',['-box',pdf],{timeout:15000,maxBuffer:1024*1024});
    const info = parsePdfInfo(infoOut.stdout);
    if (!info.pageCount) throw Object.assign(new Error('Unable to determine PDF page count'),{code:'PDF_EVIDENCE_PAGE_COUNT_UNKNOWN'});
    const count = Math.min(info.pageCount,maxPages);
    const bboxOut = await run('pdftotext',['-f','1','-l',String(count),'-bbox','-enc','UTF-8',pdf,'-'],{timeout:30000,maxBuffer:16*1024*1024,encoding:'utf8'});
    const bboxPages = parseBboxXhtml(bboxOut.stdout);
    const pages = Array.from({length:count},(_,i) => {
      const n=i+1, meta=info.pages.find(x=>x.page===n)||{}, bbox=bboxPages[i]||{words:[]};
      return { pageId:(documentId||sha256.slice(0,20))+':page:'+String(n).padStart(4,'0'), pageNumber:n,
        mediaWidthPt:meta.mediaWidthPt??null, mediaHeightPt:meta.mediaHeightPt??null,
        mediaBox:meta.mediabox??null, cropBox:meta.cropbox??null, rotationDegrees:meta.rotationDegrees??0,
        bboxWidthPt:bbox.widthPt??null, bboxHeightPt:bbox.heightPt??null,
        coordinateSpace:'pdftotext-bbox-page-space', nativeTextWordCount:bbox.words.length,
        nativeText:bbox.words.map(x=>x.text).join(' '),
        nativeTextEvidence:bbox.words.slice(0,10000).map((x,j)=>({evidenceId:'p'+n+':w'+String(j+1).padStart(5,'0'),text:x.text,box:x.box,source:'pdftotext_bbox'})),
        evidenceStatus:bbox.words.length?'native_text_with_page_coordinates':'no_native_text_detected' };
    });
    return { engine:'mmc-pdf-page-evidence-poppler-v1', documentId, sourceSha256:sha256,
      totalPageCount:info.pageCount,pagesProcessed:pages.length,pageLimit:maxPages,
      truncatedAtPageLimit:info.pageCount>pages.length,pages,
      limitations:['Page inventory and native text bounding boxes only; no engineering geometry or quantities are inferred.','Bounding boxes are in Poppler page space and require coordinate transformation before drawing overlays.','Scanned image text requires the separate OCR pipeline; no native text does not mean the page is blank.','Scale, dimensions, title blocks and drawing elements remain unverified candidates.'] };
  } finally { if(dir) await fs.rm(dir,{recursive:true,force:true}); }
}
module.exports = { inspectPdfPageEvidence, parsePdfInfo, parseBboxXhtml };
