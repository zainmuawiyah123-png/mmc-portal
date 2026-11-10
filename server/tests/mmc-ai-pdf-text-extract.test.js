'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const zlib=require('node:zlib');
const {extractPdfText}=require('../src/lib/mmc-ai/pdf-text-extract');
function pdf(stream,dict=''){
 return Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< '+dict+' /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'\nendstream\nendobj\n%%EOF','latin1');
}
test('extracts literal PDF text from Tj and TJ operators',()=>{
 const r=extractPdfText(pdf('BT (Hello MMC) Tj [(Quantity ) -120 (Takeoff)] TJ ET'));
 assert.equal(r.status,'partial_text_extracted');
 assert.equal(r.pageCount,1);
 assert.match(r.text,/Hello MMC/);
 assert.match(r.text,/Quantity Takeoff/);
 assert.ok(r.limitations.some(x=>x.includes('لا يستخرج OCR')));
});
test('extracts FlateDecode text streams',()=>{
 const compressed=zlib.deflateSync(Buffer.from('BT (Compressed PDF text) Tj ET','latin1'));
 const head=Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< /Filter /FlateDecode >>\nstream\n','latin1');
 const tail=Buffer.from('\nendstream\nendobj\n%%EOF','latin1');
 const r=extractPdfText(Buffer.concat([head,compressed,tail]));
 assert.match(r.text,/Compressed PDF text/);
});
test('reports no text for scanned-image-like empty content',()=>{
 const r=extractPdfText(pdf('q 0 0 100 100 re f Q'));
 assert.equal(r.status,'no_text_found');
 assert.equal(r.characterCount,0);
});
test('rejects invalid and encrypted PDF input',()=>{
 assert.throws(()=>extractPdfText(Buffer.from('not pdf')),/Invalid PDF/);
 assert.throws(()=>extractPdfText(Buffer.from('%PDF-1.7\n/Encrypt 4 0 R')),/Encrypted/);
});
