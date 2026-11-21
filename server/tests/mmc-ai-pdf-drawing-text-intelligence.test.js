'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {analyzePdfDrawingText}=require('../src/lib/mmc-ai/pdf-drawing-text-intelligence');

test('extracts drawing text clues without turning them into quantities',()=>{
 const result=analyzePdfDrawingText({
  engine:'test-text-layer',pageCount:1,characterCount:180,ocrPerformed:false,
  text:'STRUCTURAL FOUNDATION PLAN\nDRAWING NO: S-101\nREV: B\nSCALE: 1:100\nFOOTING F1 2000 x 2000 x 500 mm\nSECTION A-A'
 },{documentId:'doc-test',sheetOrPage:'S-101'});
 assert.ok(result.metadata.sheetNumbers.includes('S-101'));
 assert.ok(result.metadata.revisions.includes('B'));
 assert.ok(result.metadata.scales.includes('1:100'));
 assert.ok(result.metadata.dimensions.length>0);
 assert.ok(result.unresolved.some(x=>x.includes('No engineering element classification')));
 assert.equal(result.quantities,undefined);
});

test('does not invent scale or quantities when the drawing has no explicit scale',()=>{
 const result=analyzePdfDrawingText({engine:'test',pageCount:1,characterCount:45,text:'GROUND FLOOR PLAN\nFOUNDATION LAYOUT'}, {});
 assert.deepEqual(result.metadata.scales,[]);
 assert.equal(result.status,'insufficient_text_clues');
 assert.ok(result.unresolved.some(x=>x.includes('No engineering element classification')));
});
