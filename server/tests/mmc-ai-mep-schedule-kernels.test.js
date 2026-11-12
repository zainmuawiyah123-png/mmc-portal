'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateElectricalDeviceSchedule, calculatePlumbingFixtureSchedule, calculateFireProtectionSchedule } = require('../src/lib/mmc-ai/mep-schedule-kernels');

test('aggregates electrical devices by type specification size and unit', () => {
  const r = calculateElectricalDeviceSchedule([
    { tag: 'L1', deviceType: 'luminaire', description: 'LED downlight', specification: '12W', size: 'cutout 100mm', unit: 'No.', quantity: 8, sourceId: 'E-101', sheet: 'E-101' },
    { tag: 'L1', deviceType: 'luminaire', description: 'LED downlight', specification: '12W', size: 'cutout 100mm', unit: 'No.', quantity: 4, sourceId: 'E-102', sheet: 'E-102' },
    { tag: 'SO1', deviceType: 'socket_outlet', description: 'Twin socket', specification: '13A', unit: 'No.', quantity: 5 }
  ]);
  assert.equal(r.itemCount, 2);
  assert.equal(r.totalQuantity, 17);
  assert.equal(r.items[0].quantity, 12);
  assert.equal(r.items[0].sourceRows.length, 2);
});

test('counts plumbing fixtures separately by specification and size', () => {
  const r = calculatePlumbingFixtureSchedule([
    { tag: 'WC', fixtureType: 'water_closet', description: 'Wall hung WC', specification: 'dual flush', unit: 'No.', quantity: 6 },
    { tag: 'WB', fixtureType: 'wash_basin', description: 'Wash basin', size: '600mm', unit: 'No.', quantity: 6 }
  ]);
  assert.equal(r.totalQuantity, 12);
  assert.equal(r.items.length, 2);
});

test('counts fire protection devices from explicit schedule rows', () => {
  const r = calculateFireProtectionSchedule([
    { tag: 'SP', fireItemType: 'sprinkler_head', description: 'Pendent sprinkler', specification: 'K80', unit: 'No.', quantity: 120 },
    { tag: 'FHR', fireItemType: 'hose_reel', description: 'Fire hose reel', unit: 'No.', quantity: 4 }
  ]);
  assert.equal(r.totalQuantity, 124);
});

test('rejects unsupported types and incomplete schedule rows', () => {
  assert.throws(() => calculateElectricalDeviceSchedule([{ tag: 'X', deviceType: 'imaginary', description: 'x', unit: 'No.', quantity: 1 }]), /unsupported/);
  assert.throws(() => calculatePlumbingFixtureSchedule([{ tag: 'X', fixtureType: 'sink', description: 'x', unit: 'No.', quantity: 0 }]), /greater than zero/);
  assert.throws(() => calculateFireProtectionSchedule([{ fireItemType: 'sprinkler_head', description: 'x', unit: 'No.', quantity: 1 }]), /tag is required/);
});
