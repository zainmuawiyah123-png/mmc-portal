'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { inspectPdfVectorPage, parseSvgVectorPaths, parseSvgMatrix } = require('../src/lib/mmc-ai/pdf-pdf-vector-extract');
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

test('rejects unsupported SVG transform forms', () => {
  assert.throws(() => parseSvgMatrix('translate(10 20)'), /Unsupported SVG transform/);
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
