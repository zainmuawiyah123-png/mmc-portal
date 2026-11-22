'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildPdfElementCandidates,semantic}=require('../src/lib/mmc-ai/pdf-semantic-vector-linker');

test('recognizes explicit structural and MEP labels without guessing from dimensions',()=>{
  assert.deepEqual(semantic('R.C. WALL'),['reinforced_concrete_wall']);
  assert.deepEqual(semantic('UPVC PIPE 160mm'),['pipe']);
  assert.deepEqual(semantic('Y16-200 C/C'),[]);
});

test('links an explicit element label to nearby vector geometry as a candidate only',()=>{
  const result=buildPdfElementCandidates({
    textLines:[{id:'txt-1',page:1,text:'R.C. WALL',box:{left:10,top:10,width:12,height:4}}],
    vectorPaths:[{id:'vec-1',closed:true,points:[{x:0,y:0},{x:40,y:0},{x:40,y:30},{x:0,y:30}],areaSquareUnits:1200}]
  });
  assert.equal(result.counts.linkedLabels,1);
  assert.equal(result.candidates[0].semanticTypes[0],'reinforced_concrete_wall');
  assert.equal(result.candidates[0].geometryCandidates[0].pathId,'vec-1');
  assert.equal(result.candidates[0].quantityEligible,false);
  assert.equal(result.candidates[0].evidenceOnly,true);
});

test('does not emit geometry or quantity when the drawing has no semantic element label',()=>{
  const result=buildPdfElementCandidates({
    textLines:[{id:'txt-1',text:'5000 mm',box:{left:10,top:10,width:12,height:4}}],
    vectorPaths:[{id:'vec-1',closed:true,points:[{x:0,y:0},{x:40,y:0},{x:40,y:30}]}]
  });
  assert.equal(result.candidates.length,0);
  assert.equal(result.status,'no_semantic_labels_found');
});

test('maps normalized page text coordinates into SVG page coordinates',()=>{
  const result=buildPdfElementCandidates({
    svgViewBox:[0,0,1000,500],
    textLines:[{id:'txt-2',text:'COLUMN',box:{left:.1,top:.2,width:.1,height:.1,coordinateSpace:'display_page_fraction_unclamped'}}],
    vectorPaths:[{id:'vec-2',points:[{x:80,y:80},{x:240,y:80},{x:240,y:180},{x:80,y:180}],closed:true}]
  });
  assert.equal(result.counts.linkedLabels,1);
});
