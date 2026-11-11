'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateMasonryWall, calculateRectangularDuctwork, calculateRoutedServices } = require('../src/lib/mmc-ai/discipline-measurement-kernels');

test('calculates masonry net area and volume after explicit opening deductions', () => {
  const result = calculateMasonryWall({ walls: [
    { wallId: 'W1', lengthM: 6, heightM: 3, thicknessMm: 200, openings: [{ widthM: 1, heightM: 2 }] },
    { wallId: 'W2', lengthM: 4, heightM: 3, thicknessMm: 100, openings: [] }
  ] });
  assert.equal(result.grossAreaM2, 30);
  assert.equal(result.openingDeductionsM2, 2);
  assert.equal(result.netAreaM2, 28);
  assert.equal(result.netVolumeM3, 5.2);
});

test('calculates straight rectangular duct surface and length by segment', () => {
  const result = calculateRectangularDuctwork([
    { segmentId: 'D1', lengthM: 10, widthMm: 500, heightMm: 300 },
    { segmentId: 'D2', lengthM: 5, widthMm: 400, heightMm: 200 }
  ]);
  assert.equal(result.totalLengthM, 15);
  assert.equal(result.externalSurfaceAreaM2, 22);
});

test('calculates pipe, cable or conduit route lengths without invented slack', () => {
  const result = calculateRoutedServices([
    { routeId: 'R1', lengthM: 25, parallelRuns: 3, size: '4C x 16mm2' },
    { routeId: 'R2', lengthM: 10, parallelRuns: 1 }
  ], { serviceType: 'cable' });
  assert.equal(result.baseLengthM, 85);
  assert.equal(result.allowanceM, 0);
  assert.equal(result.totalLengthM, 85);
});

test('adds only an explicitly specified route allowance', () => {
  const result = calculateRoutedServices([{ lengthM: 100 }], { serviceType: 'pipe', explicitAllowancePercent: 5 });
  assert.equal(result.totalLengthM, 105);
  assert.equal(result.allowanceM, 5);
});

test('rejects impossible opening deductions and invalid MEP routes', () => {
  assert.throws(() => calculateMasonryWall({ walls: [{ lengthM: 1, heightM: 1, thicknessMm: 100, openings: [{ widthM: 2, heightM: 2 }] }] }), /cannot exceed/);
  assert.throws(() => calculateRoutedServices([{ lengthM: 10 }], { serviceType: 'unknown' }), /serviceType/);
  assert.throws(() => calculateRoutedServices([{ lengthM: 10 }], { serviceType: 'cable', explicitAllowancePercent: 101 }), /cannot exceed/);
});
