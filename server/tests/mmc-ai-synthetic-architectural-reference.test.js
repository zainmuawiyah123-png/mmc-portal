'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { takeoffDxf } = require('../src/lib/mmc-ai/dxf-takeoff');

const fixturePath = path.join(__dirname, 'fixtures', 'synthetic-architectural-sample.dxf');
const closeTo = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);

test('synthetic architectural DXF fixture matches independently calculated reference dimensions', () => {
  const result = takeoffDxf(fs.readFileSync(fixturePath, 'utf8'));
  assert.equal(result.units.insunits, 6);
  assert.equal(result.summary.supportedEntities, 8);
  assert.equal(result.summary.unsupportedEntities, 0);

  // External wall centre-lines: 8 + 6 + 8 + 6 m; internal partition: 6 m.
  const walls = result.rows.filter(row => row.layer === 'A-WALLS');
  assert.equal(walls.length, 5);
  closeTo(walls.reduce((sum, row) => sum + row.quantity, 0), 34);

  // One 90-degree door swing arc, radius 0.9 m.
  const door = result.rows.find(row => row.layer === 'A-DOORS');
  assert.ok(door);
  closeTo(door.quantity, 0.9 * Math.PI / 2);

  // Window symbol: 1.5 m x 0.1 m; room outline: 8 m x 6 m.
  const window = result.rows.find(row => row.layer === 'A-WINDOWS');
  const room = result.rows.find(row => row.layer === 'A-ROOMS');
  assert.ok(window && room);
  closeTo(window.area_m2, 0.15);
  closeTo(window.length_m, 3.2);
  closeTo(room.area_m2, 48);
  closeTo(room.length_m, 28);

  closeTo(result.summary.totalClosedArea_m2, 48.15);
  closeTo(result.byLayer['A-WALLS'].length_m, 34);
  closeTo(result.byLayer['A-ROOMS'].area_m2, 48);
});
