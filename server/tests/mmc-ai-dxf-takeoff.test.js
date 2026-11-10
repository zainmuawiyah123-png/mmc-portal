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
  const result = takeoffDxf(dxf(['0','CIRCLE','40','2'].join('\n')));
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
  const ent = ['0','ARC','40','-2','50','0','51','90'].join('\n');
  assert.throws(() => takeoffDxf(dxf(ent)), /negative arc radius/i);
});

test('rejects incomplete LINE entities instead of defaulting missing coordinates to zero', () => {
  const ent = ['0','LINE','10','0','20','0','11','6'].join('\n');
  assert.throws(() => takeoffDxf(dxf(ent)), /missing required DXF group code 21/i);
});
