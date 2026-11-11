'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDxfDrawing } = require('../src/lib/mmc-ai/drawing-element-normalizer');

const document = { documentId: 'DEMO-STR-01', revision: 'A', sheetOrPage: 'S-101' };
const takeoff = {
  engine: 'mmc-dxf-geometry-0.1',
  units: { insunits: 6, metresPerUnit: 1 },
  rows: [
    { entity: 'LINE', entityIndex: 0, layer: 'STR-BEAM', quantity: 5, unit: 'm' },
    { entity: 'LWPOLYLINE', entityIndex: 1, layer: 'STR-SLAB', length_m: 20, area_m2: 24, quantity: 20, unit: 'm' },
    { entity: 'LINE', entityIndex: 2, layer: 'UNKNOWN', quantity: 3, unit: 'm' }
  ]
};
const layerMap = {
  'STR-BEAM': { discipline: 'structural', system: 'frame', elementType: 'beam centreline', measurements: ['length_m'] },
  'STR-SLAB': { discipline: 'structural', system: 'floor', elementType: 'slab outline', measurements: ['area_m2'] }
};

test('normalizes explicitly mapped DXF geometry with document provenance', () => {
  const result = normalizeDxfDrawing({ content: 'synthetic dxf bytes', takeoff, document, layerMap });
  assert.equal(result.elementCount, 2);
  assert.equal(result.unresolvedCount, 1);
  assert.equal(result.elements[0].measurements[0].quantity, 5);
  assert.equal(result.elements[1].measurements[0].measurement, 'area_m2');
  assert.equal(result.elements[0].source.documentId, document.documentId);
  assert.equal(result.elements[0].source.revision, 'A');
  assert.match(result.elements[0].source.documentSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.elements[0].approvalEligible, false);
  assert.equal(result.unresolved[0].reason, 'layer_classification_missing_or_incomplete');
});

test('does not infer a BOQ quantity from an unmapped layer', () => {
  const result = normalizeDxfDrawing({ content: 'synthetic dxf bytes', takeoff, document, layerMap: {} });
  assert.equal(result.elementCount, 0);
  assert.equal(result.unresolvedCount, 3);
});

test('rejects duplicate source entity identities', () => {
  const duplicate = { ...takeoff, rows: [takeoff.rows[0], takeoff.rows[0]] };
  assert.throws(() => normalizeDxfDrawing({ content: 'synthetic dxf bytes', takeoff: duplicate, document, layerMap }), /Duplicate source entity/);
});

test('requires revision and sheet identity to keep quantities auditable', () => {
  assert.throws(() => normalizeDxfDrawing({
    content: 'synthetic dxf bytes', takeoff, document: { documentId: 'D1', revision: '', sheetOrPage: 'A1' }, layerMap
  }), /document.revision is required/);
});

const { takeoffDxf } = require('../src/lib/mmc-ai/dxf-takeoff');

test('runs real DXF geometry extraction into traceable classified candidates', () => {
  const dxf = [
    '0','SECTION','2','HEADER','9','$INSUNITS','70','6','0','ENDSEC',
    '0','SECTION','2','ENTITIES',
    '0','LINE','8','STR-BEAM','10','0','20','0','11','6','21','8',
    '0','LWPOLYLINE','8','STR-SLAB','70','1','10','0','20','0','10','5','20','0','10','5','20','4','10','0','20','4',
    '0','ENDSEC','0','EOF'
  ].join('\\n');
  const measured = takeoffDxf(dxf);
  const result = normalizeDxfDrawing({
    content: dxf,
    takeoff: measured,
    document: { documentId: 'SYNTH-01', revision: 'B', sheetOrPage: 'S-101' },
    layerMap: {
      'STR-BEAM': { discipline: 'structural', system: 'frame', elementType: 'beam reference line', measurements: ['length_m'] },
      'STR-SLAB': { discipline: 'structural', system: 'floor', elementType: 'slab boundary', measurements: ['area_m2'] }
    }
  });
  assert.equal(measured.rows.length, 2);
  assert.equal(result.elementCount, 2);
  assert.equal(result.unresolvedCount, 0);
  assert.equal(result.elements[0].measurements[0].quantity, 10);
  assert.equal(result.elements[1].measurements[0].quantity, 20);
  assert.ok(result.elements.every(item => item.reviewState === 'requires_engineering_review'));
});
