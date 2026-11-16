'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { parseSvgRootDimensions, inspectPdfVectorPage, parseSvgVectorPaths, parseSvgMatrix } = require('../src/lib/mmc-ai/pdf-pdf-vector-extract');
const { createTwoPageArchitecturalFixture } = require('./fixtures/mmc-ai-pdf-fixtures');
const hasPoppler = spawnSync('pdftocairo', ['-v'], { stdio: 'ignore' }).status === 0;

test('parses vector paths and applies the page coordinate matrix', () => {
  const svg = '<svg width="612pt" height="792pt" viewBox="0 0 612 792"><defs><path d="M0 0 L9 0 L9 9 Z"/></defs><path d="M0 0 L6 0 L6 4 L0 4 Z" transform="matrix(1 0 0 -1 0 792)"/></svg>';
  const result = parseSvgVectorPaths(svg);
  assert.equal(result.pathCount, 1);
  assert.equal(result.paths[0].areaSquareUnits, 24);
  assert.equal(result.paths[0].lengthUnits, 20);
  assert.deepEqual(result.paths[0].points[0], { x: 0, y: 792 });
});

test('supports common SVG transforms and composes them in order', () => {
  assert.deepEqual(parseSvgMatrix('translate(10 20) scale(2)'), [2, 0, 0, 2, 10, 20]);
  assert.deepEqual(parseSvgMatrix('matrix(1 0 0 1 5 6)'), [1, 0, 0, 1, 5, 6]);
});

test('applies nested group transforms and excludes paths inside defs', () => {
  const svg = '<svg><defs><path d="M0 0 L99 0 L99 99 Z"/></defs><g transform="translate(10 20)"><g transform="scale(2)"><path d="M0 0 L5 0 L5 4 L0 4 Z"/></g></g></svg>';
  const result = parseSvgVectorPaths(svg);
  assert.equal(result.pathCount, 1);
  assert.equal(result.paths[0].areaSquareUnits, 80);
  assert.deepEqual(result.paths[0].points[0], { x: 10, y: 20 });
});

test('extracts sampled Bezier and arc paths through the PDF SVG adapter', () => {
  const svg = '<svg><path d="M0 0 C0 10 10 10 10 0"/><path d="M20 0 A10 10 0 0 1 10 10"/></svg>';
  const result = parseSvgVectorPaths(svg);
  assert.equal(result.pathCount, 2);
  assert.ok(result.paths[0].points.length > 2);
  assert.ok(result.paths[1].lengthUnits > 15.6 && result.paths[1].lengthUnits < 15.8);
  assert.equal(result.unsupportedPathCount, 0);
  assert.match(result.limitations[0], /approximations/);
});

test('reads SVG viewBox and dimensions regardless of root attribute order', () => {
  const parsed = parseSvgRootDimensions('<svg viewBox="0, 0, 1000, 500" height="500pt" preserveAspectRatio="none" width="1000pt">');
  assert.deepEqual(parsed.viewBox, [0, 0, 1000, 500]);
  assert.equal(parsed.width, 1000);
  assert.equal(parsed.height, 500);
  assert.equal(parsed.viewBoxStatus, 'valid');
  assert.equal(parsed.preserveAspectRatio, 'none');
  const invalid = parseSvgRootDimensions('<svg viewBox="0 0 -1 20">');
  assert.equal(invalid.viewBox, null);
  assert.equal(invalid.viewBoxStatus, 'invalid');
});

test('rejects malformed SVG transform syntax', () => {
  assert.throws(() => parseSvgMatrix('translate(10 20) broken'), /Unsupported|malformed/);
});

test('converts a real synthetic PDF page into vector geometry using Poppler', { skip: !hasPoppler }, async () => {
  const result = await inspectPdfVectorPage(createTwoPageArchitecturalFixture(), { pageNumber: 2 });
  assert.equal(result.pageNumber, 2);
  assert.equal(result.status, 'vector_geometry_extracted_requires_engineering_review');
  assert.ok(result.geometry.pathCount >= 2);
  const areas = result.geometry.paths.filter(path => path.closed).map(path => path.areaSquareUnits).sort((a,b)=>a-b);
  assert.deepEqual(areas.slice(0,2), [80000, 240000]);
  assert.equal(result.approvalEligible, false);
});

test('calibrates a synthetic PDF vector page only when explicit points and known dimension are supplied', { skip: !hasPoppler }, async () => {
  const result = await inspectPdfVectorPage(createTwoPageArchitecturalFixture(), {
    pageNumber: 2,
    knownDistanceMm: 6000,
    calibrationPointA: { x: 0, y: 792 },
    calibrationPointB: { x: 600, y: 792 }
  });
  assert.ok(result.calibrated);
  const areas = result.calibrated.measurements.paths.map(path => path.areaM2).filter(Number.isFinite).sort((a,b)=>a-b);
  assert.deepEqual(areas.slice(0,2), [8, 24]);
});
