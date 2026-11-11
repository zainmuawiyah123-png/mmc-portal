'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverProjectScope } = require('../src/lib/mmc-ai/scope-coverage');

test('discovers multiple disciplines from document evidence without treating missing evidence as absence', () => {
  const result = discoverProjectScope([
    { id: 'A1', fileName: 'S-101 Structural Foundation Plan.pdf', extractedText: 'Reinforcement and concrete foundations' },
    { id: 'M1', title: 'HVAC ductwork layout' },
    { id: 'E1', drawingNumber: 'E-201', description: 'Lighting and cable tray' },
    { id: 'P1', fileName: 'Sanitary drainage layout.pdf' }
  ]);
  const status = Object.fromEntries(result.disciplines.map(item => [item.discipline, item.status]));
  assert.equal(result.status, 'discovery_preliminary');
  assert.equal(status.structural, 'evidence_detected');
  assert.equal(status.mechanical_hvac, 'evidence_detected');
  assert.equal(status.electrical, 'evidence_detected');
  assert.equal(status.plumbing_drainage, 'evidence_detected');
  assert.equal(status.architectural, 'not_evidenced');
  assert.match(result.limitations[1], /لا يعني/);
});

test('handles empty and invalid document collections conservatively', () => {
  assert.equal(discoverProjectScope([]).disciplines.every(x => x.status === 'not_evidenced'), true);
  assert.throws(() => discoverProjectScope({}), /array/);
});
