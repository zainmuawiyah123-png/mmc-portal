'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {inspectPdfPageEvidence}=require('../src/lib/mmc-ai/pdf-page-evidence');
const {createTwoPageArchitecturalFixture}=require('./fixtures/mmc-ai-pdf-fixtures');
const hasPoppler=spawnSync('pdfinfo',['-v'],{stdio:'ignore'}).status===0;
const {parsePdfInfo,parseBboxXhtml,normalizePageBox}=require('../src/lib/mmc-ai/pdf-page-evidence');
test('parses page count, dimensions, rotation and page boxes',()=>{
 const x=parsePdfInfo(['Pages: 2','Page 1 size: 595.28 x 841.89 pts (A4)','Page 1 rot: 0','Page 1 MediaBox: 0 0 595.28 841.89','Page 1 CropBox: 10 10 585.28 831.89','Page 2 size: 841.89 x 595.28 pts (A4)','Page 2 rot: 90'].join('\n'));
 assert.equal(x.pageCount,2); assert.equal(x.pages[0].mediaWidthPt,595.28); assert.equal(x.pages[0].cropbox.xMin,10); assert.equal(x.pages[1].rotationDegrees,90);
});
test('parses native text words and bounding boxes',()=>{
 const x=parseBboxXhtml('<html><page width="600" height="800"><word xMin="10" yMin="20" xMax="55" yMax="32">FOUNDATION</word><word xMin="60" yMin="20" xMax="80" yMax="32">PLAN</word></page></html>');
 assert.equal(x.length,1); assert.equal(x[0].widthPt,600); assert.equal(x[0].words.length,2);
 assert.deepEqual(x[0].words[0].box,{xMin:10,yMin:20,xMax:55,yMax:32}); assert.equal(x[0].words[1].text,'PLAN');
});
test('decodes XML entities',()=>{
 const x=parseBboxXhtml('<page width="100" height="100"><word xMin="1" yMin="2" xMax="8" yMax="9">A&amp;B &lt;C&gt;</word></page>');
 assert.equal(x[0].words[0].text,'A&B <C>');
});

test('normalizes native PDF text boxes to page-relative fractions without clamping',()=>{
 const box=normalizePageBox({xMin:60,yMin:80,xMax:180,yMax:200},600,800,0);
 assert.deepEqual(box,{left:0.1,top:0.1,right:0.3,bottom:0.25,width:0.2,height:0.15,rotationDegrees:0,coordinateSpace:'display_page_fraction_unclamped'});
});
test('rejects invalid page dimensions and degenerate text boxes during normalization',()=>{
 assert.equal(normalizePageBox({xMin:1,yMin:1,xMax:2,yMax:2},0,100,0),null);
 assert.equal(normalizePageBox({xMin:1,yMin:1,xMax:1,yMax:2},100,100,0),null);
 assert.equal(normalizePageBox(null,100,100,0),null);
});
test('preserves out-of-page fractions for explicit clipping decisions by the viewer',()=>{
 const box=normalizePageBox({xMin:-5,yMin:10,xMax:105,yMax:30},100,100,0);
 assert.equal(box.left,-0.05);
 assert.equal(box.right,1.05);
 assert.equal(box.coordinateSpace,'display_page_fraction_unclamped');
});

test('rotates page-relative text evidence for 90, 180 and 270 degree PDF pages',()=>{
 const source={xMin:10,yMin:20,xMax:30,yMax:40};
 assert.deepEqual(normalizePageBox(source,100,200,90),{
  left:0.8,top:0.1,right:0.9,bottom:0.3,width:0.1,height:0.2,
  rotationDegrees:90,coordinateSpace:'display_page_fraction_unclamped'
 });
 assert.deepEqual(normalizePageBox(source,100,200,180),{
  left:0.7,top:0.8,right:0.9,bottom:0.9,width:0.2,height:0.1,
  rotationDegrees:180,coordinateSpace:'display_page_fraction_unclamped'
 });
 assert.deepEqual(normalizePageBox(source,100,200,270),{
  left:0.1,top:0.7,right:0.2,bottom:0.9,width:0.1,height:0.2,
  rotationDegrees:270,coordinateSpace:'display_page_fraction_unclamped'
 });
});
test('rejects unsupported PDF rotation values',()=>{
 assert.equal(normalizePageBox({xMin:1,yMin:1,xMax:2,yMax:2},100,100,45),null);
});

test('runs Poppler end-to-end against a generated two-page engineering PDF', {skip:!hasPoppler}, async()=>{
 const result=await inspectPdfPageEvidence(createTwoPageArchitecturalFixture(),{documentId:'acceptance-fixture'});
 assert.equal(result.totalPageCount,2);
 assert.equal(result.pagesProcessed,2);
 assert.equal(result.pages[0].nativeTextWordCount>0,true);
 assert.match(result.pages[0].nativeText,/MMC AI SYNTHETIC ACCEPTANCE PLAN/);
 assert.match(result.pages[1].nativeText,/GROUND FLOOR/);
 const word=result.pages[0].nativeTextEvidence.find(x=>x.text==='MMC');
 assert.ok(word);
 assert.ok(word.normalizedBox);
 assert.equal(word.normalizedBox.rotationDegrees,0);
 assert.equal(word.normalizedBox.coordinateSpace,'display_page_fraction_unclamped');
 assert.ok(Number.isFinite(word.normalizedBox.left));
 assert.equal(result.pages[0].evidenceStatus,'native_text_with_page_coordinates');
});
test('honors the configured page processing limit in Poppler inspection', {skip:!hasPoppler}, async()=>{
 const result=await inspectPdfPageEvidence(createTwoPageArchitecturalFixture(),{maxPages:1});
 assert.equal(result.totalPageCount,2);
 assert.equal(result.pagesProcessed,1);
 assert.equal(result.truncatedAtPageLimit,true);
});
