'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTesseractTsv, ocrPdf } = require('../src/lib/mmc-ai/ocr-engine');

test('parses OCR words, bounding boxes, line grouping, and confidence from TSV', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t20\t30\t40\t12\t96.5\tGROUND',
    '5\t1\t1\t1\t1\t2\t65\t30\t35\t12\t91.5\tFLOOR',
    '5\t1\t1\t1\t2\t1\t20\t60\t50\t12\t88\t6000mm',
    '5\t1\t1\t1\t2\t2\t80\t60\t50\t12\t-1\t'
  ].join('\n');
  const result = parseTesseractTsv(tsv);
  assert.equal(result.text, 'GROUND FLOOR\n6000mm');
  assert.equal(result.wordCount, 3);
  assert.equal(result.averageConfidence, 92);
  assert.deepEqual(result.words[0].box, { left: 20, top: 30, width: 40, height: 12 });
});

test('rejects non-PDF input before invoking OCR binaries', async () => {
  await assert.rejects(
    () => ocrPdf(Buffer.from('not a pdf')),
    error => error.code === 'OCR_PDF_INVALID'
  );
});
