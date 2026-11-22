'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseSpatialTextEvidence } = require('../src/lib/mmc-ai/pdf-spatial-text-selection');

test('prefers OCR callouts over native title-block prose despite native word count', () => {
  const nativeLines = [{ text: 'Arab Potash Company Projects Development Directorate Drawing issued for bids' }];
  const ocrLines = [{ text: '5500 x 3500 Y16-200 UPVC 160 mm' }];
  const result = chooseSpatialTextEvidence({ nativeLines, ocrLines });
  assert.equal(result.source, 'tesseract_ocr_word_boxes');
  assert.equal(result.decision, 'ocr_has_more_engineering_signals');
  assert.equal(result.lines, ocrLines);
});

test('retains native spatial evidence when it has equal or better engineering signals', () => {
  const nativeLines = [{ text: '5500 x 3500 Y16-200' }];
  const ocrLines = [{ text: 'Drawing title and revision information' }];
  const result = chooseSpatialTextEvidence({ nativeLines, ocrLines });
  assert.equal(result.source, 'native_pdf_text_bbox');
  assert.equal(result.lines, nativeLines);
});

test('uses OCR when no native spatial lines exist', () => {
  const ocrLines = [{ text: 'Y16-200' }];
  const result = chooseSpatialTextEvidence({ nativeLines: [], ocrLines });
  assert.equal(result.source, 'tesseract_ocr_word_boxes');
  assert.equal(result.decision, 'ocr_fallback_no_native_lines');
});
