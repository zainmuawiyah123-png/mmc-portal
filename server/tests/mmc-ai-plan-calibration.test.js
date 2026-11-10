'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calibratePlanMeasurements } = require('../src/lib/mmc-ai/plan-calibration');

const bounds = { minX: 0, minY: 0, maxX: 600, maxY: 400 };

test('calibrates metric extents from explicitly user-confirmed dimensions', () => {
  const result = calibratePlanMeasurements({ rawBounds: bounds, knownWidthMm: 6000, knownHeightMm: 4000 });
  assert.equal(result.status, 'calibrated_from_user_confirmed_dimensions');
  assert.equal(result.calibrationSource, 'user_confirmed_dimensions');
  assert.equal(result.scaleMmPerUnit, 10);
  assert.equal(result.widthM, 6);
  assert.equal(result.heightM, 4);
  assert.equal(result.areaM2, 24);
});

test('does not infer calibration from a printed scale note or missing dimensions', () => {
  const result = calibratePlanMeasurements({ rawBounds: bounds });
  assert.equal(result.status, 'needs_manual_calibration');
  assert.match(result.reason, /يلزم إدخال/);
});

test('rejects inconsistent confirmed dimensions rather than producing misleading area', () => {
  const result = calibratePlanMeasurements({ rawBounds: bounds, knownWidthMm: 6000, knownHeightMm: 5000 });
  assert.equal(result.status, 'needs_manual_calibration');
  assert.match(result.reason, /لا تتوافق/);
  assert.equal(result.areaM2, undefined);
});

test('rejects degenerate, incomplete, and invalid raw bounds', () => {
  for (const rawBounds of [
    { minX: 0, minY: 0, maxX: 0, maxY: 400 },
    { minX: 0, minY: 0, maxX: 600, maxY: NaN },
    null
  ]) {
    const result = calibratePlanMeasurements({ rawBounds, knownWidthMm: 6000, knownHeightMm: 4000 });
    assert.equal(result.status, 'needs_manual_calibration');
  }
});

test('rejects invalid tolerance configuration', () => {
  const result = calibratePlanMeasurements({ rawBounds: bounds, knownWidthMm: 6000, knownHeightMm: 4000, tolerance: 0.5 });
  assert.equal(result.status, 'needs_manual_calibration');
  assert.match(result.reason, /السماحية/);
});
