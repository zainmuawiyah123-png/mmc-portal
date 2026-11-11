'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDrawingReferences, buildDrawingSheetRegister } = require('../src/lib/mmc-ai/drawing-sheet-reference-resolver');

test('resolves exact unique cross-sheet references', () => {
  const result = resolveDrawingReferences([
    { documentId: 'D-A101', revision: 'B', sheetNumber: 'A-101', references: ['S-201'] },
    { documentId: 'D-S201', revision: 'A', sheetNumber: 'S-201', references: [] }
  ]);
  assert.equal(result.status, 'all_references_resolved');
  assert.equal(result.linkCount, 1);
  assert.equal(result.links[0].to.documentId, 'D-S201');
});

test('does not guess when a referenced sheet is missing', () => {
  const result = resolveDrawingReferences([
    { documentId: 'D-A101', revision: 'B', sheetNumber: 'A-101', references: ['S-999'] }
  ]);
  assert.equal(result.unresolved[0].reason, 'referenced_sheet_not_found');
});

test('reports duplicate sheet numbers as ambiguous', () => {
  const result = resolveDrawingReferences([
    { documentId: 'D-A101', revision: 'B', sheetNumber: 'A-101', references: ['S-201'] },
    { documentId: 'D-S201-1', revision: 'A', sheetNumber: 'S-201' },
    { documentId: 'D-S201-2', revision: 'B', sheetNumber: 'S-201' }
  ]);
  assert.equal(result.unresolved[0].reason, 'referenced_sheet_is_ambiguous');
  assert.deepEqual(result.unresolved[0].candidateDocumentIds, ['D-S201-1', 'D-S201-2']);
});

test('normalizes spaces and letter case in sheet identifiers', () => {
  const result = resolveDrawingReferences([
    { documentId: 'D1', revision: 'A', sheetNumber: 'a - 101', references: [' s - 201 '] },
    { documentId: 'D2', revision: 'A', sheetNumber: 'S-201' }
  ]);
  assert.equal(result.linkCount, 1);
});

test('rejects incomplete drawing register entries', () => {
  assert.throws(() => buildDrawingSheetRegister([{ documentId: 'D1', revision: 'A' }]), /sheetNumber/);
});
