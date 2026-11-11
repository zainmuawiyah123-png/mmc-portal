'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuantityRecord, validateQuantityRecord, summarizeQuantityRecords } = require('../src/lib/mmc-ai/quantity-record');

const source = [{ documentId: 'doc-1', revision: 'C', sheetOrPage: 'S-101 / page 2', detailRef: '4/S-501' }];
const derivation = { method: 'schedule_takeoff', ruleId: 'REBAR-BAR-LENGTH-WEIGHT', ruleVersion: '1.0', formula: 'sum(bar_length × unit_weight_by_diameter)', inputs: [{ scheduleId: 'BBS-01', barMark: 'B1', diameterMm: 16, cutLengthMm: 2400, count: 12 }] };

test('creates a traceable quantity record with discipline-specific derivation', () => {
  const item = createQuantityRecord({
    id: 'Q-001', projectId: 'P-001', discipline: 'structural', system: 'reinforcement',
    description: 'Reinforcement bars, 16 mm diameter', unit: 'kg', quantity: 45.47,
    reviewState: 'measured_ready_for_review', sources: source, derivation
  });
  assert.equal(item.quantity, 45.47);
  assert.equal(validateQuantityRecord(item).valid, true);
});

test('rejects approved quantities without traceable calculation and source', () => {
  const result = validateQuantityRecord({
    id: 'Q-002', projectId: 'P-001', discipline: 'electrical', system: 'cabling',
    description: 'Power cable', unit: 'm', quantity: 120, reviewState: 'approved',
    sources: source
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('derivation')));
});

test('requires explicit assumptions and missing-information explanations', () => {
  const base = { id: 'Q-003', projectId: 'P-001', discipline: 'mechanical_hvac', system: 'ductwork', description: 'Supply duct', unit: 'm2', sources: source };
  assert.equal(validateQuantityRecord({ ...base, reviewState: 'provisional_assumption', quantity: 12 }).valid, false);
  assert.equal(validateQuantityRecord({ ...base, reviewState: 'not_measurable_missing_information' }).valid, false);
  assert.equal(validateQuantityRecord({ ...base, reviewState: 'not_measurable_missing_information', missingInformation: 'Duct size and route are absent' }).valid, true);
});

test('summarizes workflow states without combining unlike units', () => {
  const a = createQuantityRecord({ id: 'Q-010', projectId: 'P-1', discipline: 'electrical', system: 'cable', description: 'Cable', unit: 'm', quantity: 10, reviewState: 'measured_ready_for_review', sources: source, derivation: { method: 'route_trace', ruleId: 'CABLE-ROUTE', ruleVersion: '1', formula: 'sum(route segments)', inputs: [{ routeId: 'R1' }] } });
  const b = createQuantityRecord({ id: 'Q-011', projectId: 'P-1', discipline: 'structural', system: 'concrete', description: 'Concrete', unit: 'm3', quantity: 2, reviewState: 'measured_ready_for_review', sources: source, derivation: { method: 'bim_element_takeoff', ruleId: 'CONC-VOL', ruleVersion: '1', formula: 'element solid volume minus voids', inputs: [{ elementId: 'C1' }] } });
  const summary = summarizeQuantityRecords([a, b]);
  assert.equal(summary.recordCount, 2);
  assert.equal(summary.countsByDiscipline.electrical, 1);
  assert.match(summary.note, /never added together/);
});
