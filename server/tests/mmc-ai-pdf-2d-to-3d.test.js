'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {reconstructPrismaticModel}=require('../src/lib/mmc-ai/pdf-2d-to-3d');

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
