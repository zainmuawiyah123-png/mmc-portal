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

test('reports PDF vector drawing diagnostics without claiming dimensions or quantities',()=>{
 const r=extractPdfText(pdf('q 1 0 0 1 10 20 cm 2 w 0 0 m 100 0 l 100 50 l h S 0 0 100 50 re f Q'));
 assert.ok(r.diagnostics.vectorPathOperators>=5);
 assert.equal(r.diagnostics.moveTo,1);
 assert.equal(r.diagnostics.lineTo,2);
 assert.equal(r.diagnostics.rectangles,1);
 assert.equal(r.diagnostics.paintOperations,2);
 assert.equal(r.diagnostics.coordinatePointCount,5);
 assert.deepEqual(r.diagnostics.rawCoordinateBounds,{minX:0,minY:0,maxX:100,maxY:50});
 assert.ok(r.limitations.some(x=>x.includes('لا يستخرج OCR')));
});
test('does not count operator-like words inside PDF strings as graphics',()=>{
 const r=extractPdfText(pdf('BT (line m l re f) Tj ET'));
 assert.equal(r.diagnostics.moveTo,0);
 assert.equal(r.diagnostics.lineTo,0);
 assert.equal(r.diagnostics.rectangles,0);
 assert.equal(r.diagnostics.paintOperations,0);
});

test('ignores operator-looking tokens inside names, strings, hex strings and comments',()=>{
 const r=extractPdfText(pdf('% l 999 m ignored\n/line /re /f 123\nBT (line m l re f) Tj <6c206d206c> Tj ET'));
 assert.equal(r.diagnostics.moveTo,0);
 assert.equal(r.diagnostics.lineTo,0);
 assert.equal(r.diagnostics.rectangles,0);
 assert.equal(r.diagnostics.paintOperations,0);
});
test('does not treat PDF graphics-state and text operands as drawing coordinates',()=>{
 const r=extractPdfText(pdf('q 1 0 0 1 25 35 cm 0.5 w BT /F1 12 Tf 10 20 Td (Text) Tj ET 0 0 m 80 0 l S Q'));
 assert.equal(r.diagnostics.moveTo,1);
 assert.equal(r.diagnostics.lineTo,1);
 assert.equal(r.diagnostics.rawCoordinateBounds.minX,0);
 assert.equal(r.diagnostics.rawCoordinateBounds.maxX,80);
});

test('parses signed and decimal path coordinates after tokenizer correction',()=>{
 const r=extractPdfText(pdf('q -12.5 4.25 m 0.5 -8.75 l S Q'));
 assert.equal(r.diagnostics.moveTo,1);
 assert.equal(r.diagnostics.lineTo,1);
 assert.deepEqual(r.diagnostics.rawCoordinateBounds,{minX:-12.5,minY:-8.75,maxX:0.5,maxY:4.25});
 assert.equal(r.diagnostics.coordinatePointCount,2);
});

test('decodes UTF-16BE literal and hexadecimal PDF strings when BOM is present',()=>{
 const encoded=Buffer.concat([Buffer.from([0xfe,0xff]),Buffer.from('MMC AI','utf16le')]);
 for(let i=2;i<encoded.length;i+=2){const a=encoded[i];encoded[i]=encoded[i+1];encoded[i+1]=a;}
 const literal='('+encoded.toString('latin1')+') Tj';
 const hex='<'+encoded.toString('hex')+'> Tj';
 assert.match(extractPdfText(pdf('BT '+literal+' ET')).text,/MMC AI/);
 assert.match(extractPdfText(pdf('BT '+hex+' ET')).text,/MMC AI/);
});
test('extracts strings shown with PDF single-quote and double-quote text operators',()=>{
 const r=extractPdfText(pdf('BT (First line) \' 0 0 0 0 (Second line) " ET'));
 assert.match(r.text,/First line/);
 assert.match(r.text,/Second line/);
 assert.equal(r.diagnostics.textShowingOperations,2);
});

test('decodes UTF-16LE PDF strings when little-endian BOM is present',()=>{
 const bytes=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('MMC site plan','utf16le')]);
 const literal='('+bytes.toString('latin1')+') Tj';
 const hex='<'+bytes.toString('hex')+'> Tj';
 assert.match(extractPdfText(pdf('BT '+literal+' ET')).text,/MMC site plan/);
 assert.match(extractPdfText(pdf('BT '+hex+' ET')).text,/MMC site plan/);
});
test('decodes escaped parentheses, octal escapes, and escaped line breaks',()=>{
 const r=extractPdfText(pdf('BT (MMC \\(AI\\) \\101\\nConstruction) Tj (Plan\\\nSet) Tj ET'));
 assert.match(r.text,/MMC \(AI\) A/);
 assert.match(r.text,/Construction/);
 assert.match(r.text,/PlanSet/);
});

test('preserves source order across Tj and TJ text operations',()=>{
 const r=extractPdfText(pdf('BT (First) Tj [(Second) -20 (Third)] TJ (Fourth) Tj ET'));
 assert.equal(r.text,'First\nSecondThird\nFourth');
});
test('does not extract text-looking operators from PDF comments',()=>{
 const r=extractPdfText(pdf('% (fake comment text) Tj\nBT (real text) Tj ET'));
 assert.equal(r.text,'real text');
});

test('analyses a synthetic architectural ground-floor plan PDF fixture',()=>{
 const drawing=[
  'q 1 w',
  '0 0 m 600 0 l 600 400 l 0 400 l h S',
  '100 100 400 200 re S',
  '100 100 m 500 100 l S',
  '100 300 m 500 300 l S',
  'Q',
  'BT (GROUND FLOOR PLAN) Tj (Scale 1:100) Tj (Overall dimension 6000 mm x 4000 mm) Tj ET'
 ].join(' ');
 const r=extractPdfText(pdf(drawing));
 assert.equal(r.pageCount,1);
 assert.match(r.text,/GROUND FLOOR PLAN/);
 assert.match(r.text,/Scale 1:100/);
 assert.match(r.text,/6000 mm x 4000 mm/);
 assert.equal(r.diagnostics.moveTo,3);
 assert.equal(r.diagnostics.lineTo,5);
 assert.equal(r.diagnostics.rectangles,1);
 assert.equal(r.diagnostics.paintOperations,4);
 assert.deepEqual(r.diagnostics.rawCoordinateBounds,{minX:0,minY:0,maxX:600,maxY:400});
 assert.equal(r.diagnostics.coordinatePointCount,10);
 assert.ok(r.limitations.some(x=>x.includes('لا يستخرج OCR')));
});
