'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePipework, calculateCableSchedule, calculateCableTray } = require('../src/lib/mmc-ai/mep-system-kernels');

test('calculates pipe length, external surface and insulation volume from actual outside diameter', () => {
  const r = calculatePipework([{ segmentId: 'P1', lengthM: 10, outsideDiameterMm: 100, parallelRuns: 2 }], { insulationThicknessMm: 25 });
  assert.equal(r.totalLengthM, 20);
  assert.equal(r.externalAreaM2, Number((Math.PI * 0.15 * 20).toFixed(6)));
  assert.equal(r.insulationVolumeM3, Number((Math.PI / 4 * (0.15 ** 2 - 0.1 ** 2) * 20).toFixed(6)));
});

test('keeps cable BOQ length distinct from aggregate conductor length', () => {
  const r = calculateCableSchedule([
    { cableTag: 'C1', routeLengthM: 30, parallelRuns: 2, cores: 4, cableType: 'XLPE', sizeMm2: 16 },
    { cableTag: 'C2', routeLengthM: 10, cores: 3 }
  ]);
  assert.equal(r.totalCableLengthM, 70);
  assert.equal(r.totalConductorLengthM, 270);
});

test('calculates tray lengths and plan cover area without pretending it is fabrication area', () => {
  const r = calculateCableTray([{ lengthM: 12, widthMm: 300, parallelRuns: 2 }]);
  assert.equal(r.totalLengthM, 24);
  assert.equal(r.planCoverAreaM2, 7.2);
});

test('rejects missing geometry and invalid counts', () => {
  assert.throws(() => calculatePipework([{ lengthM: 2 }]), /outsideDiameterMm/);
  assert.throws(() => calculateCableSchedule([{ routeLengthM: 5, cores: 0 }]), /cores/);
  assert.throws(() => calculateCableTray([{ lengthM: 5, widthMm: 100, parallelRuns: 0 }]), /parallelRuns/);
});
