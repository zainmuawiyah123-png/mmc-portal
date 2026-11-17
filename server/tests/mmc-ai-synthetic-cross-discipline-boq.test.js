'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { takeoffDxf } = require('../src/lib/mmc-ai/dxf-takeoff');
const { quantityRecordFromMeasurement } = require('../src/lib/mmc-ai/quantity-record-adapter');
const { compileBoq } = require('../src/lib/mmc-ai/boq-compiler');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
function recordFromRow({ id, projectId, discipline, system, description, unit, quantity, documentId, layer, entityIndex }) {
  return quantityRecordFromMeasurement({
    id, projectId, discipline, system, description, unit, quantity,
    measurement: {
      method: 'cad_geometry',
      ruleId: 'DXF-GEOMETRY-' + unit.toUpperCase(),
      ruleVersion: '0.1',
      formula: unit === 'm2' ? 'CAD closed geometry area × verified metres-per-unit²' : 'CAD geometry length × verified metres-per-unit',
      inputs: [{ layer, entityIndex, quantity, unit, geometrySource: 'synthetic DXF fixture' }]
    },
    sources: [{ documentId, revision: 'A', sheetOrPage: 'Model space' }],
    elementRefs: [documentId + ':' + layer + ':' + entityIndex]
  });
}

test('combines synthetic structural and architectural takeoffs into a traceable discipline-separated BOQ draft', () => {
  const structural = takeoffDxf(fixture('synthetic-structural-sample.dxf'));
  const architectural = takeoffDxf(fixture('synthetic-architectural-sample.dxf'));

  const slab = structural.rows.find(row => row.layer === 'S-SLAB');
  const room = architectural.rows.find(row => row.layer === 'A-ROOMS');
  const walls = architectural.rows.filter(row => row.layer === 'A-WALLS');
  assert.ok(slab && room && walls.length === 5);

  const records = [
    recordFromRow({
      id: 'S-Q-SLAB-01', projectId: 'SYNTHETIC-PROJECT-01', discipline: 'structural',
      system: 'slab', description: 'Slab plan area', unit: 'm2', quantity: slab.area_m2,
      documentId: 'SYN-STR-01', layer: slab.layer, entityIndex: slab.entityIndex
    }),
    recordFromRow({
      id: 'A-Q-ROOM-01', projectId: 'SYNTHETIC-PROJECT-01', discipline: 'architectural',
      system: 'room', description: 'Room plan area', unit: 'm2', quantity: room.area_m2,
      documentId: 'SYN-ARC-01', layer: room.layer, entityIndex: room.entityIndex
    }),
    ...walls.map(row => recordFromRow({
      id: 'A-Q-WALL-' + row.entityIndex, projectId: 'SYNTHETIC-PROJECT-01',
      discipline: 'architectural', system: 'walls', description: 'Wall centre-line length',
      unit: 'm', quantity: row.quantity, documentId: 'SYN-ARC-01',
      layer: row.layer, entityIndex: row.entityIndex
    }))
  ];

  const boq = compileBoq(records);
  assert.equal(boq.status, 'boq_draft');
  assert.equal(boq.includedRecordCount, 7);
  assert.equal(boq.excludedRecordCount, 0);
  assert.equal(boq.items.length, 3);

  const structuralItem = boq.items.find(item => item.discipline === 'structural');
  const roomItem = boq.items.find(item => item.system === 'room');
  const wallItem = boq.items.find(item => item.system === 'walls');
  assert.equal(structuralItem.quantity, 24);
  assert.equal(structuralItem.unit, 'm2');
  assert.equal(structuralItem.sourceQuantityRecordIds.length, 1);
  assert.equal(roomItem.quantity, 48);
  assert.equal(roomItem.unit, 'm2');
  assert.equal(wallItem.quantity, 34);
  assert.equal(wallItem.unit, 'm');
  assert.equal(wallItem.sourceQuantityRecordIds.length, 5);
  assert.ok(boq.items.every(item => item.approvalState === 'draft_requires_review'));
  for (const item of boq.items) {
    assert.ok(item.sourceReferences.length > 0, 'BOQ row must retain source document and sheet/page');
    assert.ok(item.sourceElementRefs.length > 0, 'BOQ row must retain drawing element references');
    assert.ok(item.derivations.length > 0, 'BOQ row must retain measurement rule and formula');
  }
  assert.equal(structuralItem.sourceReferences[0].documentId, 'SYN-STR-01');
  assert.ok(structuralItem.sourceElementRefs[0].includes('S-SLAB'));
  assert.equal(wallItem.sourceReferences[0].documentId, 'SYN-ARC-01');
  assert.equal(wallItem.derivations.length, 5);
  assert.equal(boq.duplicateWarnings.length, 0);
});
