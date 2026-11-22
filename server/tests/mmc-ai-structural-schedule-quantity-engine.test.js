'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateFootingConcreteTakeoff } = require('../src/lib/mmc-ai/structural-schedule-quantity-engine');

const evidence = code => ({
  code, count: 2, lengthM: 2.4, widthM: 2.4, depthM: 0.6,
  scheduleEvidence: { page: 6, reference: 'Footing schedule row ' + code },
  planEvidence: { page: 4, reference: 'Plan footing marks ' + code }
});

test('calculates gross footing concrete only from dimension and plan evidence', () => {
  const result = calculateFootingConcreteTakeoff({ footings: [evidence('F1')] });
  assert.equal(result.items[0].unitVolumeM3, 3.456);
  assert.equal(result.items[0].totalVolumeM3, 6.912);
  assert.equal(result.summary.totalM3, 6.912);
  assert.equal(result.status, 'draft_needs_engineer_review');
});

test('refuses missing plan counts or schedule dimensions instead of guessing', () => {
  const row = evidence('F1');
  delete row.count;
  assert.throws(() => calculateFootingConcreteTakeoff({ footings: [row] }), /count/);
  const row2 = evidence('F2');
  delete row2.depthM;
  assert.throws(() => calculateFootingConcreteTakeoff({ footings: [row2] }), /depthM/);
});

test('requires both schedule and plan evidence references', () => {
  const row = evidence('F1');
  delete row.planEvidence;
  assert.throws(() => calculateFootingConcreteTakeoff({ footings: [row] }), /evidence/);
});

test('rejects duplicate footing marks and implicit unit conversion', () => {
  assert.throws(() => calculateFootingConcreteTakeoff({ footings: [evidence('F1'), evidence('F1')] }), /unique/);
  assert.throws(() => calculateFootingConcreteTakeoff({ footings: [evidence('F1')], units: 'mm' }), /metres/);
});
