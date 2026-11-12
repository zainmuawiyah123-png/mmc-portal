'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { quantityRecordFromMeasurement } = require('../src/lib/mmc-ai/quantity-record-adapter');

test('converts a measured result into a traceable quantity record', () => {
  const record = quantityRecordFromMeasurement({
    id: 'Q-100', projectId: 'P-100', discipline: 'earthworks', system: 'bulk excavation',
    description: 'Cut volume', unit: 'm3', quantity: 570,
    measurement: {
      method: 'average_end_area', ruleId: 'EARTHWORK-AVERAGE-END-AREA', ruleVersion: '1.0',
      formula: 'V = ((A1 + A2) / 2) × L',
      inputs: [{ chainageM: 0, cutAreaM2: 10 }, { chainageM: 20, cutAreaM2: 14 }]
    },
    sources: [{ documentId: 'CIV-01', revision: 'B', sheetOrPage: 'C-101' }]
  });
  assert.equal(record.quantity, 570);
  assert.equal(record.derivation.method, 'rule_based_calculation');
  assert.equal(record.derivation.ruleId, 'EARTHWORK-AVERAGE-END-AREA');
});

test('refuses to create quantity record without formula inputs or source evidence', () => {
  const base = {
    id: 'Q-101', projectId: 'P-100', discipline: 'electrical', system: 'cable',
    description: 'Cable run', unit: 'm', quantity: 20,
    measurement: { method: 'measured_route_segments_with_explicit_allowance', ruleId: 'CABLE-ROUTE-LENGTH', ruleVersion: '1.0', formula: 'sum route lengths', inputs: [] },
    sources: [{ documentId: 'E-01', revision: 'A', sheetOrPage: 'E-101' }]
  };
  assert.throws(() => quantityRecordFromMeasurement(base), /explicit calculation inputs/);
  assert.throws(() => quantityRecordFromMeasurement({ ...base, measurement: { ...base.measurement, inputs: [{ routeId: 'R1' }] }, sources: [] }), /at least one source/);
});


test('preserves structured kernel inputs and keeps ineligible estimates out of approval', () => {
  const measurement = {
    method: 'rectangular_column_explicit_schedule_estimate',
    ruleId: 'COLUMN-CONCRETE-FORMWORK-LONGITUDINAL-REBAR-TIES',
    ruleVersion: '1.0',
    formula: 'Concrete = width × depth × height',
    inputs: {
      heightMm: 3000,
      section: { widthMm: 400, depthMm: 400 },
      longitudinalBars: [{ diameterMm: 20, count: 8 }]
    },
    measurementEligible: false
  };
  const record = quantityRecordFromMeasurement({
    id: 'Q-EST-1', projectId: 'P-100', discipline: 'structural',
    system: 'column concrete', description: 'Column C1 concrete',
    unit: 'm3', quantity: 0.48, measurement,
    sources: [{ documentId: 'S-01', revision: 'A', sheetOrPage: 'S-101' }]
  });
  assert.equal(record.reviewState, 'measured_incomplete_evidence');
  assert.deepEqual(record.derivation.inputs[1], {
    field: 'section', value: { widthMm: 400, depthMm: 400 }
  });
  assert.throws(() => quantityRecordFromMeasurement({
    id: 'Q-EST-2', projectId: 'P-100', discipline: 'structural',
    system: 'column concrete', description: 'Column C1 concrete',
    unit: 'm3', quantity: 0.48, measurement, reviewState: 'approved',
    sources: [{ documentId: 'S-01', revision: 'A', sheetOrPage: 'S-101' }]
  }), /not eligible for approval/);
});
