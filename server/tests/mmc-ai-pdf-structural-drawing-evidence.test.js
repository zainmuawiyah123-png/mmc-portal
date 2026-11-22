'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {extractStructuralDrawingEvidence}=require('../src/lib/mmc-ai/pdf-structural-drawing-evidence');

test('extracts explicit drawing title, units, reinforcement and view labels',()=>{
 const r=extractStructuralDrawingEvidence({textLines:[
  'ALL DIMENSIONS ARE IN MM UNLESS OTHERWISE NOTED',
  'Y16-200 C/C','Y8-200 C/C','Y16-10-200 C/C','2 Y16','SECTION C-C','PLAN'
 ]});
 assert.equal(r.drawingTitle,null);
 assert.equal(r.unit,'mm');
 assert.ok(r.reinforcementCallouts.length>=3);
 assert.ok(r.viewLabels.some(x=>x.label==='SECTION C-C'));
 assert.ok(r.reinforcementCallouts.every(x=>x.quantityEligible===false));
});

test('recognizes the septic tank reinforcement drawing title from OCR text',()=>{
 const r=extractStructuralDrawingEvidence({fullText:'ACCOMMODATION CAMP FOR ROYAL ENGINEERING CORPS (SEPTIC TANK REINFORCEMENT DETAILS)'});
 assert.match(r.drawingTitle,/SEPTIC TANK REINFORCEMENT DETAILS/i);
});

test('keeps isolated numbers unassociated rather than treating them as dimensions',()=>{
 const r=extractStructuralDrawingEvidence({textLines:['5500','4900','300']});
 assert.equal(r.unassociatedNumericCandidates.length,3);
 assert.ok(r.unassociatedNumericCandidates.every(x=>x.status==='unassociated_numeric_candidate'&&x.quantityEligible===false));
});
