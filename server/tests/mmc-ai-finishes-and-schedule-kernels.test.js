'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateFinishAreas, countScheduledItems } = require('../src/lib/mmc-ai/finishes-and-schedule-kernels');

test('calculates net finish surfaces by finish code and separates paint coats where requested', () => {
  const result = calculateFinishAreas([
    { surfaceId: 'F1', finishCode: 'T-01', finishType: 'floor tile', grossAreaM2: 30, deductionsM2: [2, 1] },
    { surfaceId: 'W1', finishCode: 'P-02', finishType: 'paint', grossAreaM2: 40, deductionsM2: [4], coats: 2, measureByCoats: true }
  ]);
  assert.equal(result.rows[0].netAreaM2, 27);
  assert.equal(result.rows[1].netAreaM2, 36);
  assert.equal(result.rows[1].measuredAreaM2, 72);
  assert.equal(result.totalsByFinish.length, 2);
});

test('rejects finish deductions larger than the measured surface', () => {
  assert.throws(() => calculateFinishAreas([{ finishCode: 'T1', grossAreaM2: 10, deductionsM2: [11] }]), /cannot exceed/);
});

test('counts scheduled equipment and electrical devices by item code and specification', () => {
  const result = countScheduledItems([
    { itemCode: 'L-01', specification: 'LED 600x600', count: 20, scheduleRef: 'LS-01' },
    { itemCode: 'L-01', specification: 'LED 600x600', count: 5, scheduleRef: 'LS-02' },
    { itemCode: 'DB-01', specification: '12-way panel', count: 2 }
  ], { category: 'electrical fixtures and panels' });
  assert.equal(result.totalsByItem.find(item => item.key.startsWith('L-01')).count, 25);
  assert.equal(result.totalsByItem.find(item => item.key.startsWith('DB-01')).count, 2);
});

test('rejects invalid schedule counts', () => {
  assert.throws(() => countScheduledItems([{ itemCode: 'P-01', count: 1.5 }], { category: 'plumbing' }), /non-negative integer/);
});
