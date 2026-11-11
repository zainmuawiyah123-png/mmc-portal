'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseTesseractTsv, parsePdfPageCount, ocrPdf, inspectOcrRuntime } = require('../src/lib/mmc-ai/ocr-engine');

test('parses OCR TSV words, boxes, line grouping, and confidence', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t20\t30\t40\t12\t96.5\tGROUND',
    '5\t1\t1\t1\t1\t2\t65\t30\t35\t12\t91.5\tFLOOR',
    '5\t1\t1\t1\t2\t1\t20\t60\t50\t12\t88\t6000mm'
  ].join('\n');
  const result = parseTesseractTsv(tsv);
  assert.equal(result.text, 'GROUND FLOOR\n6000mm');
  assert.equal(result.wordCount, 3);
  assert.equal(result.averageConfidence, 92);
  assert.deepEqual(result.words[0].box, { left: 20, top: 30, width: 40, height: 12 });
});

test('parses Poppler page count and rejects malformed metadata', () => {
  assert.equal(parsePdfPageCount('Title: Drawing\nPages:          7\nPage size: 842 x 595 pts'), 7);
  assert.equal(parsePdfPageCount('Pages: 0'), null);
  assert.equal(parsePdfPageCount('Pages: unknown'), null);
  assert.equal(parsePdfPageCount('no page metadata'), null);
});

test('rejects non-PDF input before invoking OCR binaries', async () => {
  await assert.rejects(() => ocrPdf(Buffer.from('not a pdf')), error => error.code === 'OCR_PDF_INVALID');
});

test('runs OCR against a real image-only engineering PDF fixture', { timeout: 180000 }, async t => {
  const runtime = await inspectOcrRuntime();
  if (!runtime.available) {
    t.skip('Poppler, Tesseract, or eng/ara language data is unavailable.');
    return;
  }
  const pillow = spawnSync('python3', ['-c', 'from PIL import Image, ImageDraw, ImageFont'], { encoding: 'utf8' });
  if (pillow.status !== 0) {
    t.skip('Python Pillow is unavailable for generating the scanned PDF fixture.');
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mmc-ai-ocr-test-'));
  const pdfPath = path.join(directory, 'scanned-drawing.pdf');
  const python = String.raw`
import sys, zlib
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]
w, h = 1600, 1100
im = Image.new("RGB", (w, h), "white")
d = ImageDraw.Draw(im)
regular = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
bold = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def font(size, heavy=False):
    return ImageFont.truetype(bold if heavy else regular, size)
d.rectangle((25,25,w-25,h-25), outline="black", width=5)
d.text((90,70), "MMC AI DRAWING TEST", font=font(44,True), fill="black")
d.text((90,155), "GROUND FLOOR PLAN", font=font(42,True), fill="black")
d.text((420,420), "6000 mm", font=font(42,True), fill="black")
d.text((900,665), "CONCRETE C30", font=font(38,True), fill="black")
d.text((300,760), "BEAM B1 300 x 600", font=font(34,True), fill="black")
d.rectangle((930,90,1450,235), outline="black", width=3)
d.text((960,105), "COLUMN SCHEDULE", font=font(27,True), fill="black")
d.text((960,150), "C1 400 x 400", font=font(28), fill="black")
d.text((960,190), "REBAR 8T16", font=font(28), fill="black")
raw = zlib.compress(im.tobytes(), 9)
objects = []
def obj(number, body):
    objects.append((number, body))
obj(1, b"<< /Type /Catalog /Pages 2 0 R >>")
obj(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
obj(3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 481.25] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>")
stream = b"q 700 0 0 481.25 0 0 cm /Im0 Do Q"
obj(4, b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
obj(5, b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\nstream\n" % (w,h,len(raw)) + raw + b"\nendstream")
pdf = bytearray(b"%PDF-1.4\n")
offsets = [0] * 6
for number, body in objects:
    offsets[number] = len(pdf)
    pdf.extend(("%d 0 obj\n" % number).encode() + body + b"\nendobj\n")
xref = len(pdf)
pdf.extend(b"xref\n0 6\n0000000000 65535 f \n")
for number in range(1,6):
    pdf.extend(("%010d 00000 n \n" % offsets[number]).encode())
pdf.extend(("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % xref).encode())
open(out, "wb").write(pdf)
`;
  try {
    const generated = spawnSync('python3', ['-c', python, pdfPath], { encoding: 'utf8', timeout: 30000 });
    assert.equal(generated.status, 0, generated.stderr || 'PDF fixture generation failed');
    const result = await ocrPdf(await fs.readFile(pdfPath), { maxPages: 1, dpi: 200 });
    assert.equal(result.totalPages, 1);
    assert.equal(result.pagesProcessed, 1);
    assert.equal(result.truncatedAtPageLimit, false);
    const recognized = result.pages.map(page => page.text).join('\n').toUpperCase();
    assert.match(recognized, /GROUND FLOOR PLAN/);
    assert.match(recognized, /6000 MM/);
    assert.match(recognized, /CONCRETE C30/);
    assert.ok(result.pages[0].wordCount >= 8);
    assert.ok(result.pages[0].words.some(word => word.box.width > 0 && word.box.height > 0));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
