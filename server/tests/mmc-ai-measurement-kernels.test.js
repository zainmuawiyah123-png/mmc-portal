'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateEarthworkAverageEndArea,
  calculatePrismoidalVolume,
  calculateRectangularConcrete,
  calculateRebarScheduleWeight
} = require('../src/lib/mmc-ai/measurement-kernels');

test('calculates cut and fill independently using average end area', () => {
  const result = calculateEarthworkAverageEndArea([
    { chainageM: 0, cutAreaM2: 10, fillAreaM2: 2 },
    { chainageM: 20, cutAreaM2: 14, fillAreaM2: 4 },
    { chainageM: 50, cutAreaM2: 8, fillAreaM2: 6 }
  ]);
  assert.equal(result.cutM3, 490);
  assert.equal(result.fillM3, 170);
  assert.equal(result.intervals.length, 2);
});

test('uses prismoidal rule when a measured mid-section is supplied', () => {
  const result = calculatePrismoidalVolume({ endArea1M2: 10, midAreaM2: 14, endArea2M2: 12, lengthM: 30 });
  assert.equal(result.volumeM3, 390);
});

test('calculates net rectangular concrete volume with explicit void deductions', () => {
  const result = calculateRectangularConcrete({ lengthMm: 6000, widthMm: 4000, depthMm: 300, voidsM3: [0.6, 0.2] });
  assert.equal(result.grossM3, 7.2);
  assert.equal(result.voidDeductionsM3, 0.8);
  assert.equal(result.netM3, 6.4);
});

test('calculates reinforcement weight by schedule row and bar diameter', () => {
  const result = calculateRebarScheduleWeight([
    { barMark: 'B1', diameterMm: 16, cutLengthMm: 2400, count: 12 },
    { barMark: 'B2', diameterMm: 12, cutLengthMm: 1800, count: 8 }
  ]);
  assert.equal(result.totalLengthM, 43.2);
  assert.equal(result.totalWeightKg, 67.2);
});

test('rejects missing, negative and inconsistent engineering inputs', () => {
  assert.throws(() => calculateEarthworkAverageEndArea([{ chainageM: 0, cutAreaM2: 1, fillAreaM2: 0 }]), /two cross-section/);
  assert.throws(() => calculateEarthworkAverageEndArea([{ chainageM: 0, cutAreaM2: 1, fillAreaM2: 0 }, { chainageM: 0, cutAreaM2: 1, fillAreaM2: 0 }]), /greater than zero/);
  assert.throws(() => calculateRectangularConcrete({ lengthMm: 1000, widthMm: 1000, depthMm: 1000, voidsM3: [2] }), /cannot exceed/);
  assert.throws(() => calculateRebarScheduleWeight([{ diameterMm: 16, cutLengthMm: 0, count: 3 }]), /greater than zero/);
});
