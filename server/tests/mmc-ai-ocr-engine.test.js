'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseTesseractTsv, ocrPdf, inspectOcrRuntime } = require('../src/lib/mmc-ai/ocr-engine');

test('parses OCR words, bounding boxes, line grouping, and confidence from TSV', () => {
  const tsv = [
    'level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext',
    '5\\t1\\t1\\t1\\t1\\t1\\t20\\t30\\t40\\t12\\t96.5\\tGROUND',
    '5\\t1\\t1\\t1\\t1\\t2\\t65\\t30\\t35\\t12\\t91.5\\tFLOOR',
    '5\\t1\\t1\\t1\\t2\\t1\\t20\\t60\\t50\\t12\\t88\\t6000mm',
    '5\\t1\\t1\\t1\\t2\\t2\\t80\\t60\\t50\\t12\\t-1\\t'
  ].join('\\n');
  const result = parseTesseractTsv(tsv);
  assert.equal(result.text, 'GROUND FLOOR\\n6000mm');
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

test('runs OCR against an actual scanned engineering-sheet PDF fixture', async t => {
  const runtime = await inspectOcrRuntime();
  if (!runtime.available) {
    t.skip('Poppler, Tesseract, or eng/ara language data is unavailable in this environment.');
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mmc-ai-ocr-test-'));
  const pdfPath = path.join(directory, 'scanned-drawing.pdf');
  try {
    const generator = path.join(__dirname, 'fixtures', 'create-scanned-drawing-pdf.py');
    const generated = spawnSync('python3', [generator, pdfPath], { encoding: 'utf8', timeout: 20000 });
    assert.equal(generated.status, 0, generated.stderr || 'PDF fixture generation failed');
    const result = await ocrPdf(await fs.readFile(pdfPath), { maxPages: 2, dpi: 200 });
    assert.equal(result.pagesProcessed, 1);
    assert.equal(result.totalPages, 1);
    assert.equal(result.truncatedAtPageLimit, false);
    const recognized = result.pages.map(page => page.text).join('\\n').toUpperCase();
    assert.match(recognized, /GROUND/);
    assert.match(recognized, /FLOOR/);
    assert.match(recognized, /6000/);
    assert.match(recognized, /CONCRETE/);
    assert.ok(result.pages[0].words.some(word => word.box.width > 0 && word.box.height > 0));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
