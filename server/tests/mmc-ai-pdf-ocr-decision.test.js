'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { countEngineeringSignals, decideEngineeringOcr } = require('../src/lib/mmc-ai/pdf-ocr-decision');

test('does not skip OCR when extracted prose omits drawing dimensions and callouts', () => {
  const result = decideEngineeringOcr({
    nativeText: 'GENERAL NOTES PLAN SECTION C-C CONCRETE AND CIVIL WORKS NOTES ACCOMMODATION CAMP',
    nativeWordCount: 77,
    characterCount: 2004,
    imageXObjectCount: 0
  });
  assert.equal(result.shouldRunOcr, true);
  assert.ok(result.reasons.includes('engineering_dimensions_or_callouts_not_sufficiently_detected'));
});

test('skips OCR only when native extraction includes enough engineering signals', () => {
  const result = decideEngineeringOcr({
    nativeText: 'Wall 5500 mm x 3000 mm. Reinforcement Y16-200 C/C. UPVC DN160.',
    nativeWordCount: 40,
    characterCount: 300,
    imageXObjectCount: 0
  });
  assert.equal(result.shouldRunOcr, false);
  assert.ok(result.engineeringSignalCount >= 2);
});

test('recognizes metric dimensions, reinforcement and service callouts', () => {
  const result = countEngineeringSignals('5500 mm x 3500 mm; Y16-200; UPVC DN160; DUCT');
  assert.ok(result.count >= 4);
});

test('still runs OCR for raster/image pages even when text signals exist', () => {
  const result = decideEngineeringOcr({
    nativeText: '5500 mm x 3500 mm Y16-200',
    nativeWordCount: 40,
    characterCount: 300,
    imageXObjectCount: 2
  });
  assert.equal(result.shouldRunOcr, true);
  assert.ok(result.reasons.includes('page_contains_image_xobjects'));
});
