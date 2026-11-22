'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveScaleCandidates, applyConfirmedPageScale } = require('../src/lib/mmc-ai/pdf-quantity-candidates');

function fixture({ secondDimension = 12000 } = {}) {
  const geometry = { paths: [
    { closed: false, lengthUnits: 100, areaSquareUnits: null },
    { closed: false, lengthUnits: 200, areaSquareUnits: null },
    { closed: true, lengthUnits: 60, areaSquareUnits: 200 }
  ] };
  const dimensions = [
    { page: 1, raw: '6000 mm', kind: 'explicit_length', normalizedValuesMm: [6000] },
    { page: 1, raw: secondDimension + ' mm', kind: 'explicit_length', normalizedValuesMm: [secondDimension] }
  ];
  const associations = [
    { text: 'GRID A 6000 mm', nearbyVectorPaths: [{ pathIndex: 1, distancePx: 3 }] },
    { text: 'GRID B ' + secondDimension + ' mm', nearbyVectorPaths: [{ pathIndex: 2, distancePx: 4 }] }
  ];
  return { geometry, dimensions, associations };
}

test('derives a page scale candidate only from explicit unit dimensions matched to vector paths', () => {
  const result = deriveScaleCandidates(fixture());
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].status, 'consistent_multi_dimension_scale_candidate_requires_confirmation');
  assert.equal(result.pages[0].independentDimensionCount, 2);
  assert.equal(result.pages[0].candidateMmPerDrawingUnit, 30);
  assert.equal(result.pages[0].calibrated, false);
});

test('withholds scale when independent dimension/path ratios conflict', () => {
  const result = deriveScaleCandidates(fixture({ secondDimension: 9000 }));
  assert.equal(result.pages[0].status, 'conflicting_scale_candidates_do_not_calibrate');
  assert.equal(result.pages[0].calibrated, false);
});

test('one dimension match is insufficient for page calibration', () => {
  const data = fixture();
  data.dimensions = data.dimensions.slice(0, 1);
  data.associations = data.associations.slice(0, 1);
  const result = deriveScaleCandidates(data);
  assert.equal(result.pages[0].status, 'single_dimension_scale_candidate_requires_confirmation');
  assert.equal(result.pages[0].candidateMmPerDrawingUnit, 60);
});

test('ignores dimensions without explicit units and paths without measurable length', () => {
  const data = fixture();
  data.dimensions.push({ page: 1, raw: '3 x 4', kind: 'dimension_pair', normalizedValuesMm: null });
  data.associations.push({ text: '3 x 4', nearbyVectorPaths: [{ pathIndex: 3, distancePx: 2 }] });
  data.geometry.paths[2].lengthUnits = 0;
  const result = deriveScaleCandidates(data);
  assert.equal(result.pages[0].independentDimensionCount, 2);
});

test('applies only an explicit confirmed scale and returns traceable geometry, not BOQ items', () => {
  const result = applyConfirmedPageScale({
    geometry: { paths: [
      { closed: false, lengthUnits: 100, areaSquareUnits: null },
      { closed: true, lengthUnits: 60, areaSquareUnits: 200 }
    ] },
    mmPerDrawingUnit: 10,
    confirmedBy: 'engineer',
    confirmationNote: 'Confirmed against dimension string on sheet'
  });
  assert.equal(result.paths[0].lengthM, 1);
  assert.equal(result.paths[1].areaM2, 0.02);
  assert.equal(result.paths[1].boqEligible, false);
  assert.equal(result.status, 'metric_geometry_measured_unclassified');
  assert.throws(() => applyConfirmedPageScale({
    geometry: { paths: [] }, mmPerDrawingUnit: 10, confirmedBy: 'automatic'
  }), /confirmation/);
});
