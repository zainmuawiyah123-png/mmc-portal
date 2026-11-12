'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { measureSvgPathData, calibrateSvgPage, applySvgCalibration, tokenizePathData } = require('../src/lib/mmc-ai/pdf-vector-geometry');

test('measures a closed rectangular vector outline without guessing its engineering type', () => {
  const result = measureSvgPathData('M 10 20 L 70 20 L 70 60 L 10 60 Z');
  assert.equal(result.pathCount, 1);
  assert.equal(result.paths[0].closed, true);
  assert.equal(result.paths[0].lengthUnits, 200);
  assert.equal(result.paths[0].areaSquareUnits, 2400);
  assert.equal(result.paths[0].vertexCount, 4);
});

test('supports relative and horizontal/vertical line commands', () => {
  const result = measureSvgPathData('m 0 0 h 6 v 4 h -6 z');
  assert.equal(result.paths[0].areaSquareUnits, 24);
  assert.equal(result.paths[0].lengthUnits, 20);
});

test('measures open polylines but does not assign area', () => {
  const result = measureSvgPathData('M0 0 L3 4 L6 4');
  assert.equal(result.paths[0].closed, false);
  assert.equal(result.paths[0].lengthUnits, 8);
  assert.equal(result.paths[0].areaSquareUnits, null);
});

test('keeps separate subpaths separate', () => {
  const result = measureSvgPathData('M0 0 L2 0 L2 2 Z M10 10 L12 10');
  assert.equal(result.pathCount, 2);
  assert.equal(result.paths[0].areaSquareUnits, 2);
  assert.equal(result.paths[1].closed, false);
});

test('rejects curves and arcs rather than silently approximating them', () => {
  assert.throws(() => measureSvgPathData('M0 0 C1 2 3 4 5 6'), /Unsupported SVG path command/);
  assert.throws(() => measureSvgPathData('M0 0 A5 5 0 0 1 10 10'), /Unsupported SVG path command/);
});

test('rejects malformed tokens and incomplete commands', () => {
  assert.throws(() => tokenizePathData('M0 0 @ 2'), /invalid tokens/);
  assert.throws(() => measureSvgPathData('M0'), /incomplete coordinates|no coordinates/);
});

test('requires an explicit known dimension for scale calibration', () => {
  const calibration = calibrateSvgPage({
    pointA: { x: 0, y: 0 }, pointB: { x: 60, y: 0 }, knownDistanceMm: 3750
  });
  assert.equal(calibration.source, 'user_or_engineer_confirmed_dimension');
  assert.equal(calibration.mmPerSvgUnit, 62.5);
  assert.equal(calibration.approvalEligible, false);
});

test('converts calibrated rectangle geometry into traceable metric measurements', () => {
  const geometry = measureSvgPathData('M0 0 L60 0 L60 40 L0 40 Z');
  const calibration = calibrateSvgPage({
    pointA: { x: 0, y: 0 }, pointB: { x: 60, y: 0 }, knownDistanceMm: 6000
  });
  const result = applySvgCalibration(geometry, calibration);
  assert.equal(result.paths[0].lengthM, 20);
  assert.equal(result.paths[0].areaM2, 24);
  assert.equal(result.paths[0].reviewState, 'requires_engineering_review');
  assert.equal(result.paths[0].approvalEligible, false);
});
