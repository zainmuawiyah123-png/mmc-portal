'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {reconstructPrismaticModel,detectRectangularFootprints}=require('../src/lib/mmc-ai/pdf-2d-to-3d');

test('automatically extrudes four machine-detected footing footprints and calculates 8 m3',()=>{
 const candidates=Array.from({length:4},(_,i)=>({
  id:'PDF-PATH-'+i,
  footprint:{closed:true,pageNumber:1,pathIndex:i,points:[{x:i*300,y:0},{x:i*300+100,y:0},{x:i*300+100,y:100},{x:i*300,y:100}]},
  heightEvidence:{heightMm:500,sourceText:'DEPTH 500',pageNumber:2,confidence:0.99}
 }));
 const result=reconstructPrismaticModel({candidates,mmPerDrawingUnit:20});
 assert.equal(result.solidCount,4);
 assert.equal(result.unresolvedCount,0);
 assert.equal(result.totalFootprintAreaM2,16);
 assert.equal(result.totalPrismaticVolumeM3,8);
 assert.equal(result.solids[0].vertices.length,8);
 assert.equal(result.solids[0].faces.length,6);
 assert.equal(result.approvalEligible,false);
});

test('does not invent a 3D height when the drawing evidence is missing or weak',()=>{
 const result=reconstructPrismaticModel({mmPerDrawingUnit:20,candidates:[
  {id:'missing-height',footprint:{closed:true,points:[{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}]}},
  {id:'weak-height',footprint:{closed:true,points:[{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}]},heightEvidence:{heightMm:500,sourceText:'500',pageNumber:1,confidence:0.4}}
 ]});
 assert.equal(result.solidCount,0);
 assert.equal(result.unresolvedCount,2);
 assert.equal(result.totalPrismaticVolumeM3,0);
});

test('rejects non-rectangular footprints rather than silently approximating them',()=>{
 const result=reconstructPrismaticModel({mmPerDrawingUnit:10,candidates:[
  {id:'triangle',footprint:{closed:true,points:[{x:0,y:0},{x:100,y:0},{x:50,y:100}]},heightEvidence:{heightMm:300,sourceText:'H=300',pageNumber:1,confidence:0.99}}
 ]});
 assert.equal(result.solidCount,0);
 assert.equal(result.unresolved[0].reason,'footprint_not_supported_as_rectangle');
});

test('detects rectangular footprints automatically from extracted PDF vector paths without manual tracing',()=>{
 const result=detectRectangularFootprints({paths:[
  {closed:true,points:[{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}]},
  {closed:true,points:[{x:0,y:0},{x:100,y:0},{x:50,y:80}]},
  {closed:false,points:[{x:0,y:0},{x:100,y:0}]}
 ]});
 assert.equal(result.detectedCount,1);
 assert.equal(result.rejectedCount,2);
 assert.equal(result.detected[0].classification,'unclassified_closed_rectangular_footprint');
 assert.equal(result.detected[0].scaleStatus,'unknown_until_automatically_verified_from_drawing_dimensions');
});


const { createTwoPageArchitecturalFixture } = require('./fixtures/mmc-ai-pdf-fixtures');
const { extractPdfText } = require('../src/lib/mmc-ai/pdf-text-extract');
const { inspectPdfVectorPage } = require('../src/lib/mmc-ai/pdf-pdf-vector-extract');

test('multi-sheet PDF evidence links slab plan geometry to printed dimensions and section thickness', async t => {
 const bytes=createTwoPageArchitecturalFixture();
 const textEvidence=extractPdfText(bytes);
 assert.match(textEvidence.text,/OVERALL DIMENSIONS 6000 mm x 4000 mm/);
 assert.match(textEvidence.text,/SLAB S1 THICKNESS 200 mm/);
 const dimension=textEvidence.text.match(/OVERALL DIMENSIONS\\s+(\\d+)\\s*mm\\s*[x×]\\s*(\\d+)\\s*mm/i);
 const section=textEvidence.text.match(/SLAB\\s+S1\\s+THICKNESS\\s+(\\d+)\\s*mm/i);
 assert.ok(dimension,'printed plan dimensions must be extracted from the PDF');
 assert.ok(section,'section thickness must be extracted from the PDF');
 const plan=await inspectPdfVectorPage(bytes,{pageNumber:1});
 if(plan.geometry.pathCount===0){t.skip('Poppler did not expose supported vector paths');return;}
 const rect=plan.geometry.paths.find(path=>path.closed&&path.vertexCount===4);
 assert.ok(rect,'plan footprint must be detected from PDF vector paths');
 const xs=rect.points.map(point=>point.x),ys=rect.points.map(point=>point.y);
 const width=Math.max(...xs)-Math.min(...xs),height=Math.max(...ys)-Math.min(...ys);
 const mmPerUnitX=Number(dimension[1])/width;
 const mmPerUnitY=Number(dimension[2])/height;
 assert.ok(Math.abs(mmPerUnitX-mmPerUnitY)/Math.max(mmPerUnitX,mmPerUnitY)<0.02,
   'independent X/Y printed dimensions must agree on the inferred scale');
 const mmPerUnit=(mmPerUnitX+mmPerUnitY)/2;
 const footprint={closed:true,pageNumber:1,pathIndex:plan.geometry.paths.indexOf(rect),
   points:rect.points.map(point=>({x:point.x,y:point.y}))};
 const model=reconstructPrismaticModel({mmPerDrawingUnit:mmPerUnit,candidates:[{
   id:'S1',footprint,heightEvidence:{heightMm:Number(section[1]),sourceText:section[0],pageNumber:2,confidence:1}
 }]});
 assert.equal(model.solidCount,1);
 assert.equal(model.unresolvedCount,0);
 assert.ok(Math.abs(model.totalFootprintAreaM2-24)<0.5);
 assert.ok(Math.abs(model.totalPrismaticVolumeM3-4.8)<0.1);
 assert.equal(model.solids[0].classification,'unresolved_generic_solid');
 assert.equal(model.approvalEligible,false);
});
