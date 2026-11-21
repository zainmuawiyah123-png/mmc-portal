'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {analyzePdfDrawingText,analyzeSpatialPageEvidence}=require('../src/lib/mmc-ai/pdf-drawing-text-intelligence');

test('extracts drawing text clues without turning them into quantities',()=>{
 const result=analyzePdfDrawingText({
  engine:'test-text-layer',pageCount:1,characterCount:180,ocrPerformed:false,
  text:'STRUCTURAL FOUNDATION PLAN\nDRAWING NO: S-101\nREV: B\nSCALE: 1:100\nFOOTING F1 2000 mm x 2000 mm x 500 mm\nSECTION A-A'
 },{documentId:'doc-test',sheetOrPage:'S-101'});
 assert.ok(result.metadata.textualSheetNumberCandidates.includes('S-101'));
 assert.ok(result.metadata.textualRevisionCandidates.includes('B'));
 assert.ok(result.metadata.textualScaleCandidates.includes('1:100'));
 assert.ok(result.metadata.explicitDimensionCallouts.length>0);
 assert.ok(result.unresolved.some(x=>x.includes('No engineering element classification')));
 assert.equal(result.quantities,undefined);
});

test('does not invent scale or quantities when the drawing has no explicit scale',()=>{
 const result=analyzePdfDrawingText({engine:'test',pageCount:1,characterCount:45,text:'GROUND FLOOR PLAN\nFOUNDATION LAYOUT'}, {});
 assert.deepEqual(result.metadata.textualScaleCandidates,[]);
 assert.ok(['text_clues_found','insufficient_text_clues'].includes(result.status));
 assert.ok(result.unresolved.some(x=>x.includes('No engineering element classification')));
});

test('creates page-level engineering candidates while refusing unverified quantities',()=>{
 const lines=[
  {page:1,text:'FOOTING F1',confidence:96,box:{left:900,top:500,width:180,height:28},coordinateSpace:'aligned_svg_page_normalized_2000px'},
  {page:1,text:'2000 x 2000 x 500 mm',confidence:94,box:{left:905,top:545,width:240,height:26},coordinateSpace:'aligned_svg_page_normalized_2000px'},
  {page:1,text:'SCALE 1:100',confidence:98,box:{left:1500,top:1750,width:140,height:24},coordinateSpace:'aligned_svg_page_normalized_2000px'},
  {page:1,text:'DRAWING NO S-101 REV B',confidence:97,box:{left:1450,top:1800,width:360,height:30},coordinateSpace:'aligned_svg_page_normalized_2000px'},
  {page:1,text:'DETAIL 3/S-501',confidence:93,box:{left:1200,top:700,width:180,height:25},coordinateSpace:'aligned_svg_page_normalized_2000px'}
 ];
 const result=analyzeSpatialPageEvidence(lines,{maxDistancePx:160,pageBounds:{width:2000,height:2000}});
 assert.ok(result.elements.some(item=>item.elementFamilyCandidate==='footing'));
 assert.ok(result.dimensions.some(item=>item.kind==='dimension_pair'));
 const triplet=result.dimensions.find(item=>item.kind==='dimension_triplet');
 assert.deepEqual(triplet.values,[2000,2000,500]);
 assert.deepEqual(triplet.units,['mm','mm','mm']);
 assert.deepEqual(triplet.normalizedValuesMm,[2000,2000,500]);
 assert.equal(result.dimensions.filter(item=>item.kind==='dimension_pair').length,0);
 assert.ok(result.scaleCandidates.some(item=>item.raw.includes('1:100')));
 assert.ok(result.titleBlockCandidates.length>0);
 assert.ok(result.detailReferenceCandidates.some(item=>item.raw.includes('DETAIL')));
 assert.equal(result.elements[0].measurementEligible,false);
 assert.ok(result.limitations.some(item=>item.includes('No quantity')));
});
