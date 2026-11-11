'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateEarthworkAverageEndArea,
  calculatePrismoidalVolume,
  calculateRectangularConcrete,
  calculateRebarScheduleWeight,
  calculateSlabReinforcementTakeoff,
  calculateIsolatedFootingTakeoff,
  calculateColumnTakeoff,
  calculateBeamTakeoff,
  calculateConcreteWallTakeoff
} = require('../src/lib/mmc-ai/measurement-kernels');

test('calculates cut and fill independently using average end area', () => {
  const result = calculateEarthworkAverageEndArea([
    { chainageM: 0, cutAreaM2: 10, fillAreaM2: 2 },
    { chainageM: 20, cutAreaM2: 14, fillAreaM2: 4 },
    { chainageM: 50, cutAreaM2: 8, fillAreaM2: 6 }
  ]);
  assert.equal(result.cutM3, 570);
  assert.equal(result.fillM3, 210);
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
  assert.equal(result.totalWeightKg, 58.311111);
});

test('rejects missing, negative and inconsistent engineering inputs', () => {
  assert.throws(() => calculateEarthworkAverageEndArea([{ chainageM: 0, cutAreaM2: 1, fillAreaM2: 0 }]), /two cross-section/);
  assert.throws(() => calculateEarthworkAverageEndArea([{ chainageM: 0, cutAreaM2: 1, fillAreaM2: 0 }, { chainageM: 0, cutAreaM2: 1, fillAreaM2: 0 }]), /greater than zero/);
  assert.throws(() => calculateRectangularConcrete({ lengthMm: 1000, widthMm: 1000, depthMm: 1000, voidsM3: [2] }), /cannot exceed/);
  assert.throws(() => calculateRebarScheduleWeight([{ diameterMm: 16, cutLengthMm: 0, count: 3 }]), /greater than zero/);
});


test('estimates rectangular slab reinforcement from explicit spacing, cover and layers', () => {
  const result = calculateSlabReinforcementTakeoff({
    slabLengthMm: 6000, slabWidthMm: 4000, coverMm: 40,
    barsAlongLength: { diameterMm: 12, spacingMm: 150, layers: 2 },
    barsAlongWidth: { diameterMm: 10, spacingMm: 200, layers: 1 }
  });
  assert.equal(result.rows[0].barsPerLayer, 28);
  assert.equal(result.rows[0].cutLengthMm, 5920);
  assert.equal(result.rows[0].totalBars, 56);
  assert.equal(result.rows[1].barsPerLayer, 30);
  assert.equal(result.rows[1].cutLengthMm, 3920);
  assert.equal(result.totalBars, 86);
  assert.equal(result.measurementEligible, false);
});

test('rejects slab reinforcement inputs with impossible cover or missing bar directions', () => {
  assert.throws(() => calculateSlabReinforcementTakeoff({
    slabLengthMm: 1000, slabWidthMm: 800, coverMm: 500,
    barsAlongLength: { diameterMm: 12, spacingMm: 150 }
  }), /cover/);
  assert.throws(() => calculateSlabReinforcementTakeoff({
    slabLengthMm: 6000, slabWidthMm: 4000, coverMm: 40
  }), /at least one reinforcement direction/);
});


test('calculates isolated footing concrete and explicit base reinforcement separately', () => {
  const result = calculateIsolatedFootingTakeoff({
    lengthMm: 2400, widthMm: 2000, thicknessMm: 500, coverMm: 75,
    reinforcementAlongLength: { diameterMm: 16, spacingMm: 150, layers: 1 },
    reinforcementAlongWidth: { diameterMm: 16, spacingMm: 150, layers: 1 },
    pedestal: { lengthMm: 500, widthMm: 500, heightMm: 600 }
  });
  assert.equal(result.footingGrossConcreteM3, 2.4);
  assert.equal(result.pedestalConcreteM3, 0.15);
  assert.equal(result.combinedConcreteM3, 2.55);
  assert.equal(result.reinforcement.totalBars, 56);
  assert.equal(result.measurementEligible, false);
});

test('rejects an isolated footing pedestal larger than the footing plan', () => {
  assert.throws(() => calculateIsolatedFootingTakeoff({
    lengthMm: 2000, widthMm: 1800, thicknessMm: 400, coverMm: 50,
    pedestal: { lengthMm: 2200, widthMm: 500, heightMm: 500 }
  }), /cannot exceed/);
});


test('calculates rectangular column concrete, formwork and scheduled longitudinal bars', () => {
  const result = calculateColumnTakeoff({
    heightMm: 3000, sectionWidthMm: 400, sectionDepthMm: 400, coverMm: 40,
    longitudinalBars: [{ barMark: 'C1-L', diameterMm: 20, count: 8 }],
    ties: { diameterMm: 10, spacingMm: 150, cutLengthMm: 1400 }
  });
  assert.equal(result.concreteM3, 0.48);
  assert.equal(result.formworkM2, 4.8);
  assert.equal(result.longitudinalReinforcement.rows[0].count, 8);
  assert.equal(result.ties.count, 21);
  assert.equal(result.measurementEligible, false);
});

test('calculates rectangular beam concrete and formwork with explicit bar schedule', () => {
  const result = calculateBeamTakeoff({
    lengthMm: 5000, widthMm: 300, overallDepthMm: 600, slabThicknessMm: 150, coverMm: 40,
    longitudinalBars: [{ barMark: 'B1-M', diameterMm: 20, count: 4, cutLengthMm: 5200 }],
    stirrups: { diameterMm: 10, spacingMm: 150, cutLengthMm: 1500 }
  });
  assert.equal(result.concreteM3, 0.675);
  assert.equal(result.formworkM2, 6);
  assert.equal(result.stirrups.count, 35);
  assert.equal(result.measurementEligible, false);
});

test('rejects impossible column and beam geometry', () => {
  assert.throws(() => calculateColumnTakeoff({
    heightMm: 3000, sectionWidthMm: 300, sectionDepthMm: 300, coverMm: 160,
    longitudinalBars: [{ diameterMm: 16, count: 4, cutLengthMm: 3000 }]
  }), /cover/);
  assert.throws(() => calculateBeamTakeoff({
    lengthMm: 5000, widthMm: 300, overallDepthMm: 500, slabThicknessMm: 500,
    longitudinalBars: [{ diameterMm: 16, count: 4, cutLengthMm: 5000 }]
  }), /slabThicknessMm/);
});


test('calculates concrete wall volume and double-face formwork after explicit opening deductions', () => {
  const result = calculateConcreteWallTakeoff({
    lengthMm: 5000, heightMm: 3000, thicknessMm: 200, coverMm: 40,
    verticalBars: { diameterMm: 16, spacingMm: 200 },
    horizontalBars: { diameterMm: 12, spacingMm: 200 },
    openings: [{ mark: 'D1', widthMm: 1000, heightMm: 2100 }]
  });
  assert.equal(result.grossConcreteM3, 3);
  assert.equal(result.openingDeductionsM3, 0.42);
  assert.equal(result.netConcreteM3, 2.58);
  assert.equal(result.grossFormworkBothFacesM2, 30);
  assert.equal(result.netFormworkBothFacesM2, 25.8);
  assert.equal(result.measurementEligible, false);
});

test('rejects wall opening deductions exceeding gross wall face area', () => {
  assert.throws(() => calculateConcreteWallTakeoff({
    lengthMm: 2000, heightMm: 2000, thicknessMm: 200, coverMm: 30,
    openings: [{ widthMm: 2500, heightMm: 2000 }]
  }), /cannot exceed/);
});
