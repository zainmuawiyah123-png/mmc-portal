'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { calculateIsolatedFootingConcrete } = require('../src/lib/mmc-ai/pdf-structural-quantity-engine');

const reference = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mmc-real-266790015V4C-footing-reference.json'), 'utf8'));

test('real 266790015V4C footing schedule and plan counts produce the verified concrete volume', () => {
  const result = calculateIsolatedFootingConcrete({
    schedule: reference.footingSchedule,
    planMarkCounts: reference.planMarkCounts,
    evidence: { documentId: reference.documentId, schedulePage: 6, planPage: 4, reviewedBy: 'engineering-reference-review' }
  });
  assert.equal(result.status, 'measured_draft_requires_engineering_review');
  assert.equal(result.totalVolumeM3, reference.expectedTotalVolumeM3);
  assert.deepEqual(result.items.map(item => item.mark), ['F1','F2','F3','F4','F5','F6']);
  assert.equal(result.items.find(item => item.mark === 'F3').totalVolumeM3, 50.4);
  assert.equal(result.approvalEligible, false);
});

test('missing footing dimensions or counts fail closed instead of defaulting', () => {
  const schedule = reference.footingSchedule.map(row => ({ ...row }));
  schedule[0].depthM = null;
  assert.throws(() => calculateIsolatedFootingConcrete({
    schedule, planMarkCounts: reference.planMarkCounts,
    evidence: { documentId: reference.documentId, schedulePage: 6, planPage: 4, reviewedBy: 'test' }
  }), /depthM/);
});

test('unmatched plan marks and schedule marks do not produce partial misleading totals', () => {
  const counts = reference.planMarkCounts.filter(row => row.mark !== 'F6');
  const result = calculateIsolatedFootingConcrete({
    schedule: reference.footingSchedule, planMarkCounts: counts,
    evidence: { documentId: reference.documentId, schedulePage: 6, planPage: 4, reviewedBy: 'test' }
  });
  assert.equal(result.status, 'incomplete_schedule_plan_match');
  assert.equal(result.totalVolumeM3, null);
  assert.deepEqual(result.unmatchedScheduleMarks, ['F6']);
});
