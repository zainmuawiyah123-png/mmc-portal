'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {correlatePdfTextWithVectorGeometry}=require('../src/lib/mmc-ai/pdf-evidence-correlation');

test('correlates a text callout with nearby vector paths in a shared normalized page space',()=>{
 const result=correlatePdfTextWithVectorGeometry({
  textLines:[{page:1,text:'B1 300 x 600',box:{left:490,top:245,width:40,height:20}}],
  geometry:{paths:[{points:[{x:24.5,y:12.5},{x:25.5,y:13.5}]},{points:[{x:80,y:30},{x:90,y:30}]}]},
  viewBox:[0,0,100,50],pageWidthPt:200,pageHeightPt:100,maxDistancePx:36
 });
 assert.equal(result.status,'spatial_candidates_generated_requires_visual_confirmation');
 assert.equal(result.matchedTextLineCount,1);
 assert.equal(result.associations[0].nearbyVectorPaths[0].pathIndex,1);
 assert.equal(result.associations[0].measurementEligible,false);
});

test('withholds spatial associations when PDF page and SVG aspect ratios do not align',()=>{
 const result=correlatePdfTextWithVectorGeometry({
  textLines:[{text:'C1',box:{left:1,top:1,width:10,height:10}}],
  geometry:{paths:[{points:[{x:0,y:0},{x:1,y:1}]}]},
  viewBox:[0,0,100,50],pageWidthPt:200,pageHeightPt:150
 });
 assert.equal(result.status,'coordinate_spaces_not_aligned');
 assert.equal(result.associations.length,0);
});

test('normalizes OCR TSV word boxes into the same page coordinate system as PDF vectors',()=>{
 const {spatialOcrLines}=require('../src/lib/mmc-ai/pdf-evidence-correlation');
 const lines=spatialOcrLines([
  {text:'B1',page:1,block:1,paragraph:1,line:1,box:{left:650,top:320,width:50,height:30}},
  {text:'300',page:1,block:1,paragraph:1,line:1,box:{left:710,top:320,width:60,height:30}}
 ],{pageWidthPt:612,pageHeightPt:792});
 assert.equal(lines.length,1);
 assert.equal(lines[0].text,'B1 300');
 assert.ok(lines[0].box.left>0 && lines[0].box.width>0);
 assert.equal(lines[0].source,'tesseract_tsv_normalized_page');
});
