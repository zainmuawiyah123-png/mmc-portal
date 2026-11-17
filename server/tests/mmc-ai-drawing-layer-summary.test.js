'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {summarizeTakeoffLayers}=require('../src/lib/mmc-ai/drawing-layer-summary');

test('groups DXF takeoff entities by native layer and preserves measurements',()=>{
 const layers=summarizeTakeoffLayers([
  {layer_name:'STR-COLS',entity_type:'LINE',quantity:3,unit:'m',detail:{length_m:3}},
  {layer_name:'STR-COLS',entity_type:'LWPOLYLINE',quantity:2,unit:'m',detail:{length_m:2,area_m2:1.5}},
  {layer_name:'A-WALL',entity_type:'LINE',quantity:4,unit:'m',detail:{length_m:4}}
 ]);
 assert.equal(layers.length,2);
 const structural=layers.find(x=>x.name==='STR-COLS');
 assert.equal(structural.entityCount,2);
 assert.equal(structural.entities.LINE,1);
 assert.equal(structural.lengths_m,5);
 assert.equal(structural.areas_m2,1.5);
 assert.equal(structural.source,'native_dxf_layer');
 assert.equal(structural.classification,null);
 assert.equal(structural.reviewRequired,true);
});

test('uses layer zero when source layer is absent and rejects malformed inputs',()=>{
 const layers=summarizeTakeoffLayers([{entity:'CIRCLE',quantity:2,unit:'m'}]);
 assert.equal(layers[0].name,'0');
 assert.throws(()=>summarizeTakeoffLayers(null),/array/);
});
