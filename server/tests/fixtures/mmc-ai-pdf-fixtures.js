'use strict';

// Deterministic, dependency-free PDF fixtures for MMC AI acceptance tests.
// These are generated in-memory: no owner upload or production file is required.
function buildPdf(objects) {
  const chunks = [Buffer.from('%PDF-1.7\n%MMC-AI-TEST\n', 'latin1')];
  const offsets = [0];
  let length = chunks[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(length);
    const object = Buffer.isBuffer(objects[i]) ? objects[i] : Buffer.from(objects[i], 'latin1');
    const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    chunks.push(head, object, tail);
    length += head.length + object.length + tail.length;
  }
  const xrefOffset = length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, 'latin1'));
  return Buffer.concat(chunks);
}

function streamObject(content, extra = '') {
  const data = Buffer.from(content, 'latin1');
  return Buffer.concat([
    Buffer.from(`<< /Length ${data.length} ${extra} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1')
  ]);
}

function createTwoPageArchitecturalFixture() {
  const first = streamObject([
    'q 1 w',
    '0 0 m 600 0 l 600 400 l 0 400 l h S',\n    '0 0 600 400 re S',
    'Q',
    'BT /F1 12 Tf 40 760 Td (MMC AI SYNTHETIC ACCEPTANCE PLAN) Tj',
    '(GROUND FLOOR SLAB S1) Tj',
    '(OVERALL DIMENSIONS 6000 mm x 4000 mm) Tj ET'
  ].join('\\n'));
  const second = streamObject([
    'q 1 w',
    '100 100 m 500 100 l 500 300 l 100 300 l h S',\n    '100 100 400 200 re S',
    'Q',
    'BT /F1 10 Tf 40 760 Td (STRUCTURAL SECTION S1) Tj',
    '(SLAB S1 THICKNESS 200 mm) Tj ET'
  ].join('\\n'));
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    first,
    second
  ]);
}

module.exports = { buildPdf, streamObject, createTwoPageArchitecturalFixture };
