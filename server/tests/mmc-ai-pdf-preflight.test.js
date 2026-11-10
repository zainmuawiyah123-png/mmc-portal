'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { preflightPdf } = require('../src/lib/mmc-ai/pdf-preflight');

function pdf(body = '1 0 obj << /Type /Pages /Count 2 >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n') {
  return Buffer.from('%PDF-1.7\n' + body + '%%EOF\n', 'latin1');
}

test('accepts a structurally plausible PDF and reports conservative page count', () => {
  const result = preflightPdf(pdf());
  assert.equal(result.format, 'pdf');
  assert.equal(result.version, '1.7');
  assert.equal(result.pageCount, 2);
  assert.equal(result.status, 'preflight_passed');
  assert.equal(result.extractionReady, false);
  assert.equal(result.analysisStatus, 'parser_not_configured');
  assert.ok(result.limitations.some(item => item.includes('does not mean')));
});

test('does not count the /Pages tree as a page object', () => {
  const result = preflightPdf(pdf('1 0 obj << /Type /Pages /Count 4 >> endobj\n'));
  assert.equal(result.pageCount, 4);
});

test('marks encrypted documents for password handling, not extraction', () => {
  const result = preflightPdf(pdf('1 0 obj << /Type /Pages /Count 1 >> endobj\n/Encrypt 8 0 R\n'));
  assert.equal(result.status, 'password_required');
  assert.equal(result.extractionReady, false);
  assert.equal(result.analysisStatus, 'password_required');
});

test('rejects a missing header', () => {
  assert.throws(() => preflightPdf(Buffer.from('this is definitely not a PDF file %%EOF')), { code: 'PDF_HEADER_INVALID' });
});

test('rejects a missing EOF marker', () => {
  assert.throws(() => preflightPdf(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj')), { code: 'PDF_EOF_MISSING' });
});

test('rejects files above the configured size limit', () => {
  assert.throws(() => preflightPdf(pdf(), { maxBytes: 8 }), { code: 'PDF_TOO_LARGE' });
});

test('rejects non-buffer input', () => {
  assert.throws(() => preflightPdf('file.pdf'), { code: 'PDF_INPUT_INVALID' });
});
