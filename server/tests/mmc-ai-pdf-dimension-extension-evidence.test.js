'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildPdfDimensionExtensionEvidence}=require('../src/lib/mmc-ai/pdf-dimension-extension-evidence');
test('finds perpendicular extension candidates at both ends of a dimension line',()=>{
 const vectorPaths=[
  {id:'dim',points:[{x:400,y:205},{x:600,y:205}]},
  {id:'ext-a',points:[{x:400,y:160},{x:400,y:230}]},
  {id:'ext-b',points:[{x:600,y:160},{x:600,y:230}]}
 ];
 const result=buildPdfDimensionExtensionEvidence({
  dimensionLineEvidence:{candidates:[{page:1,rawCallout:'5500',vectorLineCandidates:[{pathId:'dim',segmentIndex:1,orientation:'horizontal'}]}]},
  vectorPaths,svgViewBox:[0,0,1000,500],pageWidthPt:1000,pageHeightPt:500
 });
 assert.equal(result.counts.calloutsWithTwoExtensionCandidates,1);
 assert.equal(result.candidates[0].quantityEligible,false);
});
test('does not claim an extension pair when only one endpoint is supported',()=>{
 const vectorPaths=[{id:'dim',points:[{x:400,y:205},{x:600,y:205}]},{id:'ext-a',points:[{x:400,y:160},{x:400,y:230}]}];
 const result=buildPdfDimensionExtensionEvidence({
  dimensionLineEvidence:{candidates:[{page:1,rawCallout:'5500',vectorLineCandidates:[{pathId:'dim',segmentIndex:1,orientation:'horizontal'}]}]},
  vectorPaths,svgViewBox:[0,0,1000,500],pageWidthPt:1000,pageHeightPt:500
 });
 assert.equal(result.counts.calloutsWithTwoExtensionCandidates,0);
});
