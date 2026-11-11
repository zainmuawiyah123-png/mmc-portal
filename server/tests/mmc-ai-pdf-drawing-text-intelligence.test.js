'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzePdfDrawingText } = require('../src/lib/mmc-ai/pdf-drawing-text-intelligence');

test('extracts drawing register clues and explicit callouts without claiming takeoff', () => {
  const result = analyzePdfDrawingText({
    engine: 'mmc-pdf-text-basic-v1',
    pageCount: 2,
    characterCount: 180,
    text: [
      'ARCHITECTURAL GROUND FLOOR PLAN',
      'DRAWING NO: A-101',
      'REVISION: B',
      'SCALE 1:100',
      'Overall dimensions 6000 mm x 4000 mm',
      'SEE DETAIL 05',
      'DOOR SCHEDULE',
      'LIGHTING SCHEDULE'
    ].join('\n')
  }, { documentId: 'PDF-1', revision: 'B', sheetOrPage: 'A-101' });
  assert.equal(result.status, 'text_clues_found');
  assert.deepEqual(result.metadata.textualSheetNumberCandidates, ['A-101']);
  assert.deepEqual(result.metadata.textualRevisionCandidates, ['B']);
  assert.deepEqual(result.metadata.textualScaleCandidates, ['1:100']);
  assert.equal(result.metadata.explicitDimensionCallouts[0].values[0], 6000);
  assert.equal(result.metadata.explicitDimensionCallouts[0].units[0], 'mm');
  assert.ok(result.metadata.disciplineClues.includes('architectural'));
  assert.ok(result.metadata.scheduleTypeMentions.includes('DOOR SCHEDULE'));
  assert.ok(result.metadata.detailAndSectionReferenceCandidates.includes('DETAIL 05'));
  assert.equal(result.metadata.extractedPageCount, 2);
  assert.ok(result.unresolved.some(item => item.includes('No engineering element classification')));
});

test('flags a revision conflict between extracted text and document register', () => {
  const result = analyzePdfDrawingText({
    text: 'DRAWING NO: S-201\nREVISION C\nSCALE 1:50'
  }, { documentId: 'D-2', revision: 'B', sheetOrPage: 'S-201' });
  assert.equal(result.status, 'text_clues_with_register_conflicts');
  assert.equal(result.conflicts[0].field, 'revision');
});

test('does not invent drawing metadata when PDF text is empty', () => {
  const result = analyzePdfDrawingText({ text: '', characterCount: 0 }, {});
  assert.equal(result.status, 'insufficient_text_clues');
  assert.deepEqual(result.metadata.textualSheetNumberCandidates, []);
  assert.deepEqual(result.metadata.explicitDimensionCallouts, []);
  assert.equal(result.evidence.evidenceCount, 0);
});


test('records OCR provenance when raster text was recognized', () => {
  const result = analyzePdfDrawingText({
    text: 'STRUCTURAL FOUNDATION PLAN\\nDRAWING NO: S-101',
    ocrPerformed: true,
    ocrPageCount: 2,
    ocrAverageConfidence: 87.5,
    ocrWords: [{ page: 1, text: 'FOUNDATION', confidence: 91.2, box: { left: 100, top: 200, width: 120, height: 30 } }]
  }, { documentId: 'OCR-1' });
  assert.equal(result.metadata.ocrPerformed, true);
  assert.equal(result.metadata.ocrPageCount, 2);
  assert.equal(result.metadata.ocrAverageConfidence, 87.5);
  assert.equal(result.metadata.ocrWordCount, 1);
  assert.deepEqual(result.metadata.ocrWordEvidence[0].box, { left: 100, top: 200, width: 120, height: 30 });
  assert.equal(result.evidence.source, 'PDF text extractor and OCR output');
  assert.ok(!result.unresolved.some(item => item.includes('OCR was not performed')));
});

test('rejects a missing extraction result', () => {
  assert.throws(() => analyzePdfDrawingText(null), /PDF text extraction result is required/);
});
