'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { takeoffDxf } = require('../src/lib/mmc-ai/dxf-takeoff');

function dxf(entities, units = 6) {
  return ['0','SECTION','2','HEADER','9','$INSUNITS','70',String(units),'0','ENDSEC',
    '0','SECTION','2','ENTITIES',entities,'0','ENDSEC','0','EOF'].join('\n');
}
test('measures a 3-4-5 LINE in metres', () => {
  const result = takeoffDxf(dxf(['0','LINE','8','EARTHWORK','10','0','20','0','11','3','21','4'].join('\n')));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].quantity, 5);
  assert.equal(result.byLayer.EARTHWORK.length_m, 5);
});
test('converts millimetre drawing units to metres', () => {
  const result = takeoffDxf(dxf(['0','LINE','10','0','20','0','11','1000','21','0'].join('\n'), 4));
  assert.equal(result.rows[0].quantity, 1);
});
test('computes closed rectangular polyline perimeter and area', () => {
  const ent = ['0','LWPOLYLINE','8','SLAB','70','1','10','0','20','0','10','4','20','0','10','4','20','3','10','0','20','3'].join('\n');
  const result = takeoffDxf(dxf(ent));
  assert.equal(result.rows[0].length_m, 14);
  assert.equal(result.rows[0].area_m2, 12);
});
test('computes circle circumference and area', () => {
  const result = takeoffDxf(dxf(['0','CIRCLE','10','0','20','0','40','2'].join('\n')));
  assert.ok(Math.abs(result.rows[0].area_m2 - 4*Math.PI) < 1e-10);
});
test('refuses drawings with unknown units instead of guessing scale', () => {
  assert.throws(() => takeoffDxf(dxf(['0','LINE','10','0','20','0','11','10','21','0'].join('\n'), 0)), /units are undefined/i);
});
test('reports unsupported geometry instead of silently counting it', () => {
  const result = takeoffDxf(dxf(['0','SPLINE','8','CURVES'].join('\n')));
  assert.equal(result.summary.unsupportedEntities, 1);
  assert.equal(result.rows.length, 0);
});
test('rejects malformed group-code pairs', () => {
  assert.throws(() => takeoffDxf('0\nLINE\n10'), /incomplete group-code pair/i);
});

test('accepts standard DXF files with trailing CRLF newline', () => {
  const content = dxf(['0','LINE','10','0','20','0','11','6','21','8'].join('\n')) + '\r\n';
  const result = takeoffDxf(content);
  assert.equal(result.rows[0].quantity, 10);
});

test('rejects non-numeric LINE coordinates instead of emitting NaN', () => {
  const ent = ['0','LINE','10','not-a-number','20','0','11','6','21','8'].join('\n');
  assert.throws(() => takeoffDxf(dxf(ent)), /non-numeric geometry/i);
});
test('rejects negative ARC radius', () => {
  const ent = ['0','ARC','10','0','20','0','40','-2','50','0','51','90'].join('\n');
  assert.throws(() => takeoffDxf(dxf(ent)), /negative arc radius/i);
});

test('rejects incomplete LINE entities instead of defaulting missing coordinates to zero', () => {
  const ent = ['0','LINE','10','0','20','0','11','6'].join('\n');
  assert.throws(() => takeoffDxf(dxf(ent)), /missing required DXF group code 21/i);
});

test('rejects LWPOLYLINE vertices with missing Y coordinates', () => {
  const ent = ['0','LWPOLYLINE','70','1','10','0','20','0','10','4','10','4','20','3'].join('\n');
  assert.throws(() => takeoffDxf(dxf(ent)), /missing Y coordinate/i);
});
test('computes semicircular bulge length and area on a closed polyline', () => {
  const ent = ['0','LWPOLYLINE','70','1','10','0','20','0','42','1','10','2','20','0'].join('\n');
  const result = takeoffDxf(dxf(ent));
  assert.ok(Math.abs(result.rows[0].length_m - (Math.PI + 2)) < 1e-10);
  assert.ok(Math.abs(result.rows[0].area_m2 - (Math.PI / 2)) < 1e-10);
});

test('computes an ARC crossing zero degrees using the positive sweep', () => {
  const ent = ['0','ARC','10','0','20','0','40','2','50','350','51','10'].join('\n');
  const result = takeoffDxf(dxf(ent));
  assert.equal(result.rows[0].sweep_degrees, 20);
  assert.ok(Math.abs(result.rows[0].quantity - (2 * 20 * Math.PI / 180)) < 1e-10);
});
test('handles negative bulge direction without producing negative area', () => {
  const ent = ['0','LWPOLYLINE','70','1','10','0','20','0','42','-1','10','2','20','0'].join('\n');
  const result = takeoffDxf(dxf(ent));
  assert.ok(Math.abs(result.rows[0].length_m - (Math.PI + 2)) < 1e-10);
  assert.ok(Math.abs(result.rows[0].area_m2 - (Math.PI / 2)) < 1e-10);
});
test('groups measured geometry by CAD layer', () => {
  const ent = [
    '0','LINE','8','EARTHWORK','10','0','20','0','11','3','21','4',
    '0','CIRCLE','8','POND','10','0','20','0','40','1'
  ].join('\n');
  const result = takeoffDxf(dxf(ent));
  assert.equal(result.byLayer.EARTHWORK.entities, 1);
  assert.equal(result.byLayer.EARTHWORK.length_m, 5);
  assert.equal(result.byLayer.POND.entities, 1);
  assert.ok(Math.abs(result.byLayer.POND.area_m2 - Math.PI) < 1e-10);
});


function dxfWithBlock(blockBody, insertBody, units = 6) {
  return [
    '0','SECTION','2','HEADER','9','$INSUNITS','70',String(units),'0','ENDSEC',
    '0','SECTION','2','BLOCKS',
    '0','BLOCK','2','TEST_BLOCK','10','0','20','0',blockBody,'0','ENDBLK',
    '0','ENDSEC',
    '0','SECTION','2','ENTITIES',insertBody,'0','ENDSEC','0','EOF'
  ].join('\n');
}
test('expands a translated, rotated and uniformly scaled block INSERT', () => {
  const block = ['0','LINE','8','0','10','0','20','0','11','2','21','0'].join('\n');
  const insert = ['0','INSERT','2','TEST_BLOCK','8','EARTHWORK','10','10','20','20','41','2','42','2','43','2','50','90'].join('\n');
  const result = takeoffDxf(dxfWithBlock(block, insert));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].entity, 'LINE');
  assert.equal(result.rows[0].quantity, 4);
  assert.equal(result.rows[0].layer, 'EARTHWORK');
  assert.equal(result.rows[0].sourceBlock, 'TEST_BLOCK');
  assert.equal(result.summary.unsupportedEntities, 0);
});
test('reports non-uniform block scaling as unsupported instead of measuring it', () => {
  const block = ['0','LINE','10','0','20','0','11','2','21','0'].join('\n');
  const insert = ['0','INSERT','2','TEST_BLOCK','10','0','20','0','41','2','42','1','43','1'].join('\n');
  const result = takeoffDxf(dxfWithBlock(block, insert));
  assert.equal(result.rows.length, 0);
  assert.equal(result.unsupported.INSERT_UNSUPPORTED_SCALE, 1);
});
test('reports nested block inserts explicitly instead of silently dropping their geometry', () => {
  const nestedBlock = ['0','INSERT','2','INNER','10','0','20','0'].join('\n');
  const insert = ['0','INSERT','2','TEST_BLOCK','10','0','20','0'].join('\n');
  const result = takeoffDxf(dxfWithBlock(nestedBlock, insert));
  assert.equal(result.rows.length, 0);
  assert.equal(result.unsupported.INSERT_NESTED_BLOCK, 1);
});


test('rejects INSERT entities with missing insertion coordinates', () => {
  const block = ['0','LINE','10','0','20','0','11','2','21','0'].join('\n');
  const insert = ['0','INSERT','2','TEST_BLOCK','10','0'].join('\n');
  assert.throws(() => takeoffDxf(dxfWithBlock(block, insert)), /missing required DXF group code 20/i);
});
test('reports block arrays as unsupported instead of counting only one instance', () => {
  const block = ['0','LINE','10','0','20','0','11','2','21','0'].join('\n');
  const insert = ['0','INSERT','2','TEST_BLOCK','10','0','20','0','70','2','71','1','44','5'].join('\n');
  const result = takeoffDxf(dxfWithBlock(block, insert));
  assert.equal(result.rows.length, 0);
  assert.equal(result.unsupported.INSERT_ARRAY_UNSUPPORTED, 1);
});


test('allows 2D block INSERTs with independent Z scale', () => {
  const block = ['0','LINE','10','0','20','0','11','2','21','0'].join('\n');
  const insert = ['0','INSERT','2','TEST_BLOCK','10','0','20','0','41','2','42','2','43','5'].join('\n');
  const result = takeoffDxf(dxfWithBlock(block, insert));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].quantity, 4);
});

test('rejects non-numeric circle center coordinates', () => {
  const ent = ['0','CIRCLE','10','bad','20','0','40','2'].join('\n');
  assert.throws(() => takeoffDxf(dxf(ent)), /non-numeric geometry/i);
});
test('rejects non-numeric arc center coordinates', () => {
  const ent = ['0','ARC','10','0','20','bad','40','2','50','0','51','90'].join('\n');
  assert.throws(() => takeoffDxf(dxf(ent)), /non-numeric geometry/i);
});
test('rejects non-numeric block circle center coordinates', () => {
  const block = ['0','CIRCLE','10','bad','20','0','40','2'].join('\n');
  const insert = ['0','INSERT','2','TEST_BLOCK','10','0','20','0'].join('\n');
  assert.throws(() => takeoffDxf(dxfWithBlock(block, insert)), /non-numeric geometry/i);
});

test('preserves source geometry for drawing preview',()=>{
 const ent=[
  '0','LINE','8','GRID-A','10','1','20','2','11','4','21','6',
  '0','LWPOLYLINE','8','WALLS','70','1','10','0','20','0','10','5','20','0','10','5','20','3',
  '0','CIRCLE','8','COLUMNS','10','2','20','3','40','0.5',
  '0','ARC','8','DETAIL','10','0','20','0','40','2','50','350','51','10'
 ].join('\n');
 const result=takeoffDxf(dxf(ent));
 assert.deepEqual(result.rows.map(x=>x.geometry.type),['LINE','LWPOLYLINE','CIRCLE','ARC']);
 assert.deepEqual(result.rows[0].geometry.start,{x:1,y:2});
 assert.equal(result.rows[1].geometry.closed,true);
 assert.equal(result.rows[2].geometry.radius,0.5);
 assert.equal(result.rows[3].geometry.sweepDegrees,20);
});


test('geometry preview metadata remains separate from measured quantities',()=>{
 const ent=[
  '0','LINE','10','0','20','0','11','3','21','4',
  '0','CIRCLE','10','0','20','0','40','2'
 ].join('\n');
 const rows=takeoffDxf(dxf(ent)).rows;
 assert.equal(rows[0].quantity,5);
 assert.deepEqual(rows[0].geometry,{type:'LINE',start:{x:0,y:0},end:{x:3,y:4}});
 assert.equal(rows[1].quantity,Math.PI*4);
 assert.deepEqual(rows[1].geometry,{type:'CIRCLE',center:{x:0,y:0},radius:2});
});
test('keeps DXF preview coordinates in source drawing units for all preview entities',()=>{
 const ent=[
  '0','LINE','10','10','20','20','11','30','21','40',
  '0','LWPOLYLINE','70','0','10','1','20','2','10','3','20','4',
  '0','CIRCLE','10','5','20','6','40','2',
  '0','ARC','10','7','20','8','40','3','50','90','51','180'
 ].join('\n');
 const rows=takeoffDxf(dxf(ent)).rows;
 assert.deepEqual(rows[0].geometry.end,{x:30,y:40});
 assert.deepEqual(rows[1].geometry.vertices,[{x:1,y:2},{x:3,y:4}]);
 assert.deepEqual(rows[2].geometry.center,{x:5,y:6});
 assert.deepEqual(rows[3].geometry.center,{x:7,y:8});
 assert.equal(rows[3].geometry.startDegrees,90);
 assert.equal(rows[3].geometry.sweepDegrees,90);
});
