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


test('groups OCR words by page and visual line while retaining bounding boxes', () => {
  const result = analyzePdfDrawingText({
    text: 'DIMENSION 6000 mm',
    ocrPerformed: true,
    ocrWords: [
      { page: 1, block: 1, paragraph: 1, line: 2, text: '6000', confidence: 95, box: { left: 100, top: 200, width: 40, height: 15 } },
      { page: 1, block: 1, paragraph: 1, line: 2, text: 'mm', confidence: 90, box: { left: 145, top: 200, width: 18, height: 15 } },
      { page: 1, block: 1, paragraph: 1, line: 3, text: 'NOTE', confidence: 96, box: { left: 100, top: 240, width: 35, height: 15 } }
    ]
  });
  assert.equal(result.metadata.ocrSpatialLines.length, 2);
  assert.equal(result.metadata.ocrSpatialLines[0].text, '6000 mm');
  assert.deepEqual(result.metadata.ocrSpatialLines[0].box, { left: 100, top: 200, width: 63, height: 15 });
  assert.equal(result.metadata.ocrDimensionCallouts[0].status, 'candidate_requires_drawing_verification');
});


test('classifies spatial OCR callouts as discipline candidates without treating them as measured quantities', () => {
  const result = analyzePdfDrawingText({
    text: 'STRUCTURAL AND MEP NOTES',
    ocrPerformed: true,
    ocrWords: [
      { page: 1, block: 1, paragraph: 1, line: 1, text: 'B1', confidence: 96, box: { left: 100, top: 100, width: 20, height: 12 } },
      { page: 1, block: 1, paragraph: 1, line: 1, text: '300x600', confidence: 96, box: { left: 125, top: 100, width: 55, height: 12 } },
      { page: 1, block: 1, paragraph: 1, line: 2, text: 'AHU-01', confidence: 94, box: { left: 100, top: 130, width: 55, height: 12 } },
      { page: 1, block: 1, paragraph: 1, line: 3, text: 'DN', confidence: 92, box: { left: 100, top: 160, width: 20, height: 12 } },
      { page: 1, block: 1, paragraph: 1, line: 3, text: '100', confidence: 92, box: { left: 125, top: 160, width: 30, height: 12 } },
      { page: 1, block: 1, paragraph: 1, line: 4, text: 'SPRINKLER', confidence: 91, box: { left: 100, top: 190, width: 70, height: 12 } }
    ]
  });
  const candidates = result.metadata.spatialEngineeringAnnotations;
  assert.ok(candidates.some(item => item.candidateTypes.includes('structural')));
  assert.ok(candidates.some(item => item.candidateTypes.includes('mechanical_hvac')));
  assert.ok(candidates.some(item => item.candidateTypes.includes('plumbing_drainage')));
  assert.ok(candidates.some(item => item.candidateTypes.includes('fire_protection')));
  assert.ok(candidates.every(item => item.measurementEligible === false));
  assert.ok(candidates.every(item => item.box && item.page === 1));
});


test('recognizes Arabic engineering discipline terms as non-measured candidates', () => {
  const result = analyzePdfDrawingText({
    text: 'ملاحظات المشروع',
    ocrWords: [
      { page: 1, block: 1, paragraph: 1, line: 1, text: 'خرسانة', confidence: 94, box: { left: 10, top: 10, width: 45, height: 12 } },
      { page: 1, block: 1, paragraph: 1, line: 2, text: 'بلاط', confidence: 93, box: { left: 10, top: 30, width: 30, height: 12 } },
      { page: 1, block: 1, paragraph: 1, line: 3, text: 'تكييف', confidence: 92, box: { left: 10, top: 50, width: 35, height: 12 } },
      { page: 1, block: 1, paragraph: 1, line: 4, text: 'حفر', confidence: 91, box: { left: 10, top: 70, width: 20, height: 12 } }
    ]
  });
  const types = result.metadata.spatialEngineeringAnnotations.flatMap(item => item.candidateTypes);
  assert.ok(types.includes('structural'));
  assert.ok(types.includes('architectural'));
  assert.ok(types.includes('mechanical_hvac'));
  assert.ok(types.includes('earthworks_levels'));
  assert.ok(result.metadata.spatialEngineeringAnnotations.every(item => item.measurementEligible === false));
});

test('rejects a missing extraction result', () => {
  assert.throws(() => analyzePdfDrawingText(null), /PDF text extraction result is required/);
});
