'use strict';

/**
 * Conservative PDF intake preflight.
 * This is NOT a PDF parser and never extracts geometry or quantities.
 * It rejects obviously malformed/unsupported input before a parser job is queued.
 */
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const PDF_HEADER = /%PDF-(1\.[0-7]|2\.0)/;
const PDF_EOF = /%%EOF\s*$/;
const PAGE_OBJECT = /\/Type\s*\/Page(?!s)\b/g;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function preflightPdf(input, options = {}) {
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes : MAX_PDF_BYTES;
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw fail('PDF_INPUT_INVALID', 'PDF input must be a Buffer or Uint8Array.');
  }
  const bytes = Buffer.from(input);
  if (bytes.length < 16) throw fail('PDF_TOO_SMALL', 'PDF file is too small to be valid.');
  if (bytes.length > maxBytes) throw fail('PDF_TOO_LARGE', 'PDF exceeds the configured upload limit.');

  const head = bytes.subarray(0, Math.min(bytes.length, 1024)).toString('latin1');
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1');
  const version = head.match(PDF_HEADER);
  if (!version) throw fail('PDF_HEADER_INVALID', 'PDF header or version is missing or unsupported.');
  if (!PDF_EOF.test(tail.trimEnd())) throw fail('PDF_EOF_MISSING', 'PDF end marker is missing.');

  const body = bytes.toString('latin1');
  const encrypted = /\/Encrypt\b/.test(body);
  const pageObjects = (body.match(PAGE_OBJECT) || []).length;
  const declaredCounts = [...body.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,2048}?\/Count\s+(\d+)/g)]
    .map(match => Number(match[1])).filter(Number.isSafeInteger);
  const pageCount = declaredCounts.length ? Math.max(...declaredCounts) : pageObjects;

  return Object.freeze({
    format: 'pdf',
    version: version[1],
    bytes: bytes.length,
    encrypted,
    pageCount: pageCount > 0 ? pageCount : null,
    pageCountMethod: declaredCounts.length ? 'pages-tree-count' : (pageObjects ? 'page-object-scan' : 'unknown'),
    status: encrypted ? 'password_required' : 'preflight_passed',
    extractionReady: !encrypted && pageCount > 0,
    limitations: [
      'Structural preflight only; no text, vector, image, dimension, or quantity extraction.',
      'Page count is a conservative scan and must be confirmed by a full PDF parser.'
    ]
  });
}

module.exports = { preflightPdf, MAX_PDF_BYTES };
