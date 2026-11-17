'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileBoq } = require('../src/lib/mmc-ai/boq-compiler');
function record(id, overrides = {}) {
  return {
    id, projectId: 'P1', discipline: 'structural', system: 'concrete',
    description: 'C30 reinforced concrete', unit: 'm3', quantity: 2,
    reviewState: 'measured_ready_for_review',
    sources: [{ documentId: 'S1', revision: 'A', sheetOrPage: 'S-101' }],
    derivation: { method: 'rule_based_calculation', ruleId: 'CONC-01', ruleVersion: '1', formula: 'measured solid volume', inputs: [{ element: id }] },
    ...overrides
  };
}
test('compiles compatible quantities and preserves source record traceability', () => {
  const result = compileBoq([record('Q1'), record('Q2', { quantity: 3 })]);
  assert.equal(result.itemCount, 1);
  assert.equal(result.items[0].quantity, 5);
  assert.deepEqual(result.items[0].sourceQuantityRecordIds, ['Q1', 'Q2']);
  assert.equal(result.items[0].approvalState, 'draft_requires_review');
});
test('excludes provisional and missing-information quantities by default', () => {
  const result = compileBoq([record('Q1'), record('Q2', { reviewState: 'provisional_assumption', assumption: 'assumed' })]);
  assert.equal(result.includedRecordCount, 1);
  assert.equal(result.excludedRecordCount, 1);
});
test('does not combine different units or specifications', () => {
  const result = compileBoq([record('Q1'), record('Q2', { unit: 'kg', description: 'Rebar' })]);
  assert.equal(result.itemCount, 2);
});
test('flags duplicate groups without silently deleting or netting quantities', () => {
  const result = compileBoq([record('Q1', { duplicateGroup: 'D1' }), record('Q2', { duplicateGroup: 'D1' })]);
  assert.equal(result.items[0].quantity, 4);
  assert.equal(result.duplicateWarnings.length, 1);
  assert.match(result.duplicateWarnings[0].action, /manual_resolution/);
});
test('rejects untraceable records', () => {
  assert.throws(() => compileBoq([record('Q1', { sources: [] })]), /traceability/);
});
