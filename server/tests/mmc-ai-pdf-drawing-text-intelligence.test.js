'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {analyzePdfDrawingText,analyzeSpatialPageEvidence,extractExplicitRebarTakeoffCandidates}=require('../src/lib/mmc-ai/pdf-drawing-text-intelligence');

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
 assert.ok(result.dimensions.some(item=>item.kind==='dimension_triplet'));
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

test('calculates only explicit reinforcement callouts with stated count, diameter and cut length',()=>{
 const lines=[
  {page:17,text:'T 10Ø20L=10.0m',confidence:96,box:{left:100,top:200,width:180,height:22}},
  {page:17,text:'T8Ø16L=8.0m',confidence:93,box:{left:300,top:200,width:150,height:22}},
  {page:18,text:'T 8Ø16L=4.0m',confidence:91,box:{left:400,top:200,width:150,height:22}},
  {page:18,text:'10Ø16',confidence:99,box:{left:500,top:200,width:70,height:22}},
  {page:18,text:'T 10Ø16L=10.0',confidence:80,box:{left:600,top:200,width:180,height:22}}
 ];
 const result=extractExplicitRebarTakeoffCandidates(lines);
 assert.equal(result.length,3);
 assert.deepEqual(result.map(x=>x.page),[17,17,18]);
 assert.equal(result[0].barCount,10);
 assert.equal(result[0].diameterMm,20);
 assert.equal(result[0].lengthPerBarM,10);
 assert.equal(result[0].totalLengthM,100);
 assert.equal(result[0].theoreticalMassKg,246.91);
 assert.equal(result[1].theoreticalMassKg,101.14);
 assert.equal(result[2].theoreticalMassKg,50.57);
 assert.equal(result.every(x=>x.measurementEligible===false),true);
});

test('exposes explicit rebar takeoff candidates in page-level engineering evidence',()=>{
 const result=analyzeSpatialPageEvidence([
  {page:12,text:'T 7Ø16L=7.0m',confidence:95,box:{left:100,top:100,width:160,height:20},coordinateSpace:'test'},
  {page:12,text:'T 7Ø14L=5.50m',confidence:95,box:{left:100,top:150,width:170,height:20},coordinateSpace:'test'}
 ]);
 assert.equal(result.explicitRebarTakeoffCandidates.length,2);
 assert.equal(result.explicitRebarTakeoffCandidates[0].theoreticalMassKg,77.43);
 assert.equal(result.explicitRebarTakeoffCandidates[1].theoreticalMassKg,46.58);
 assert.ok(result.limitations.some(item=>item.includes('No quantity')||item.includes('quantity')));
});
