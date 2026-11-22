'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDrawingIntelligenceModel, classifyAnnotation, normalizeTag } = require('../src/lib/mmc-ai/drawing-intelligence-graph');

test('classifies engineering annotation candidates without asserting quantities', () => {
  assert.ok(classifyAnnotation('Y16-200 C/C').includes('reinforcement_callout'));
  assert.equal(normalizeTag('C1 COLUMN'), 'C1');
});
test('links nearby dimensions, reinforcement notes and vector paths as candidates', () => {
  const result = buildDrawingIntelligenceModel({
    textLines: [
      { id: 'tag', page: 1, text: 'C1 COLUMN', box: { left: 100, top: 100, width: 40, height: 12 } },
      { id: 'dim', page: 1, text: '300 mm', box: { left: 130, top: 120, width: 45, height: 12 } },
      { id: 'bar', page: 1, text: 'Y16-200 C/C', box: { left: 140, top: 90, width: 70, height: 12 } }
    ],
    vectorPaths: [{ id: 'outline', page: 1, points: [{x:110,y:110},{x:150,y:110},{x:150,y:150},{x:110,y:150}], closed: true, areaSquareUnits: 1600 }]
  });
  assert.equal(result.counts.elementCandidates, 1);
  assert.equal(result.elements[0].dimensionCandidates[0].evidenceId, 'dim');
  assert.equal(result.elements[0].reinforcementCandidates[0].evidenceId, 'bar');
  assert.equal(result.elements[0].geometryCandidates[0].pathId, 'outline');
  assert.equal(result.boq.rows.length, 0);
  assert.equal(result.counts.quantityEligibleElements, 0);
});
test('does not associate evidence across pages or infer a BOQ', () => {
  const result = buildDrawingIntelligenceModel({
    textLines: [
      { id: 'tag', page: 1, text: 'B1 BEAM', box: { left: 10, top: 10, width: 30, height: 10 } },
      { id: 'dim-p2', page: 2, text: '600 mm', box: { left: 10, top: 10, width: 40, height: 10 } }
    ],
    vectorPaths: [{ id: 'p2', page: 2, points: [{x:10,y:10},{x:20,y:10}], lengthUnits: 10 }]
  });
  assert.equal(result.elements[0].dimensionCandidates.length, 0);
  assert.equal(result.elements[0].geometryCandidates.length, 0);
  assert.equal(result.boq.status, 'withheld_no_verified_element_geometry');
});
