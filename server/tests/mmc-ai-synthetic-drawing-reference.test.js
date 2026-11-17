'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { takeoffDxf } = require('../src/lib/mmc-ai/dxf-takeoff');

const fixturePath = path.join(__dirname, 'fixtures', 'synthetic-structural-sample.dxf');
const closeTo = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);

test('synthetic structural DXF fixture produces independently known reference quantities', () => {
  const source = fs.readFileSync(fixturePath, 'utf8');
  const result = takeoffDxf(source);

  assert.equal(result.units.insunits, 6);
  assert.equal(result.summary.supportedEntities, 8);
  assert.equal(result.summary.unsupportedEntities, 0);

  // Four 250 mm-radius columns: four circles, total plan area = 4 * pi * r^2.
  const columns = result.rows.filter(row => row.layer === 'S-COLUMNS');
  assert.equal(columns.length, 4);
  closeTo(columns.reduce((sum, row) => sum + row.area_m2, 0), Math.PI * 0.25);

  // Two beam centre-lines: lengths 3-4-5 m and 6-8-10 m.
  const beams = result.rows.filter(row => row.layer === 'S-BEAMS');
  assert.equal(beams.length, 2);
  closeTo(beams.reduce((sum, row) => sum + row.quantity, 0), 15);

  // Slab outline: 6 m x 4 m; footing outline: 2 m x 2 m.
  const slab = result.rows.find(row => row.layer === 'S-SLAB');
  const footing = result.rows.find(row => row.layer === 'S-FOOTINGS');
  assert.ok(slab && footing);
  closeTo(slab.area_m2, 24);
  closeTo(slab.length_m, 20);
  closeTo(footing.area_m2, 4);
  closeTo(footing.length_m, 8);

  closeTo(result.summary.totalClosedArea_m2, 24 + 4 + Math.PI * 0.25);
  closeTo(result.summary.totalLength_m,
    columns.reduce((sum, row) => sum + row.quantity, 0) + 15 + 20 + 8);
});
