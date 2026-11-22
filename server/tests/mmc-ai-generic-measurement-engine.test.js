'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { measureConfirmedElement, buildMeasuredBoq } = require('../src/lib/mmc-ai/generic-measurement-engine');

const evidence = { page: 2, sourceIds: ['dimension:2:17', 'geometry:2:path:4'] };
const confirmed = { label: 'concrete wall', status: 'confirmed', confirmedBy: 'engineer' };

test('measures generic linear, area, prismatic, cylindrical and count elements', () => {
  const elements = [
    { id: 'L1', measurement: 'linear', geometry: { lengthMm: 2500 }, classification: confirmed, evidence },
    { id: 'A1', measurement: 'rectangular_area', geometry: { lengthMm: 5000, widthMm: 3000 }, classification: confirmed, evidence },
    { id: 'V1', measurement: 'prismatic_volume', geometry: { lengthMm: 5000, widthMm: 3000, heightMm: 250, deductionsM3: 0.1 }, classification: confirmed, evidence },
    { id: 'C1', measurement: 'cylindrical_volume', geometry: { diameterMm: 160, lengthMm: 10000 }, classification: confirmed, evidence },
    { id: 'N1', measurement: 'count', count: 4, classification: confirmed, evidence }
  ];
  const result = buildMeasuredBoq({ documentId: 'doc-1', elements });
  assert.equal(result.items[0].quantity, 2.5);
  assert.equal(result.items[1].quantity, 15);
  assert.equal(result.items[2].quantity, 3.65);
  assert.equal(result.items[3].quantity, 0.2011);
  assert.equal(result.items[4].quantity, 4);
  assert.equal(result.status, 'measured_draft_requires_engineering_review');
  assert.equal(result.approvalEligible, false);
});

test('does not measure an unconfirmed classification or missing source evidence', () => {
  assert.throws(() => measureConfirmedElement({
    id: 'x', measurement: 'linear', geometry: { lengthMm: 1000 },
    classification: { ...confirmed, status: 'candidate' }, evidence
  }), /classification must be confirmed/);
  assert.throws(() => measureConfirmedElement({
    id: 'x', measurement: 'linear', geometry: { lengthMm: 1000 },
    classification: confirmed, evidence: { page: 1, sourceIds: [] }
  }), /sourceIds evidence/);
});

test('rejects missing dimensions, unsupported kernels, duplicate IDs and unsafe deductions', () => {
  assert.throws(() => measureConfirmedElement({
    id: 'x', measurement: 'rectangular_area', geometry: { lengthMm: 1000 },
    classification: confirmed, evidence
  }), /widthMm/);
  assert.throws(() => measureConfirmedElement({
    id: 'x', measurement: 'unknown', geometry: {},
    classification: confirmed, evidence
  }), /unsupported measurement kernel/);
  assert.throws(() => measureConfirmedElement({
    id: 'x', measurement: 'prismatic_volume',
    geometry: { lengthMm: 1000, widthMm: 1000, heightMm: 1000, deductionsM3: 1 },
    classification: confirmed, evidence
  }), /deductionsM3/);
  assert.throws(() => buildMeasuredBoq({ documentId: 'doc-1', elements: [
    { id: 'dup', measurement: 'count', classification: confirmed, evidence },
    { id: 'dup', measurement: 'count', classification: confirmed, evidence }
  ] }), /Duplicate element id/);
});
