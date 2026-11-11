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
    const result = await ocrPdf(await fs.readFile(pdfPath), { maxPages: 1, dpi: 200 });
    assert.equal(result.pagesProcessed, 1);
    assert.equal(result.totalPages, 2);
    assert.equal(result.truncatedAtPageLimit, true);
    const recognized = result.pages.map(page => page.text).join('\n').toUpperCase();
    assert.match(recognized, /GROUND/);
    assert.match(recognized, /FLOOR/);
    assert.match(recognized, /6000/);
    assert.match(recognized, /CONCRETE/);
    assert.ok(result.pages[0].words.some(word => word.box.width > 0 && word.box.height > 0));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test('parses Poppler page count without accepting malformed output', () => {
  assert.equal(parsePdfPageCount('Title: Drawing\\nPages:          7\\nPage size: 842 x 595 pts'), 7);
  assert.equal(parsePdfPageCount('Pages: 0'), null);
  assert.equal(parsePdfPageCount('Pages: unknown'), null);
  assert.equal(parsePdfPageCount('no page metadata'), null);
});

test('runs OCR end-to-end on a generated scanned drawing PDF', { timeout: 180000 }, async t => {
  const runtime = await inspectOcrRuntime();
  if (!runtime.available) {
    t.skip('Poppler, Tesseract, and eng/ara language data are not installed in this test environment.');
    return;
  }
  try {
    await exec('python3', ['-c', 'from PIL import Image, ImageDraw, ImageFont; import zlib']);
  } catch {
    t.skip('Python Pillow is not installed; scanned fixture generation is unavailable.');
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
for x, label in ((250,"A"),(800,"B"),(1350,"C")):
    d.line((x,300,x,900), fill="black", width=5)
    d.ellipse((x-30,245,x+30,305), outline="black", width=4)
    d.text((x-13,255), label, font=font(30,True), fill="black")
for y, label in ((380,"1"),(620,"2"),(850,"3")):
    d.line((150,y,1450,y), fill="black", width=4)
    d.ellipse((80,y-25,130,y+25), outline="black", width=4)
    d.text((95,y-18), label, font=font(26,True), fill="black")
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
content = b"q 700 0 0 481.25 0 0 cm /Im0 Do Q"
obj(4, b"<< /Length %d >>\\nstream\\n" % len(content) + content + b"\\nendstream")
obj(5, b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\\nstream\\n" % (w,h,len(raw)) + raw + b"\\nendstream")
pdf = bytearray(b"%PDF-1.4\\n")
offsets = [0] * 6
for number, body in objects:
    offsets[number] = len(pdf)
    pdf.extend(("%d 0 obj\\n" % number).encode() + body + b"\\nendobj\\n")
xref = len(pdf)
pdf.extend(b"xref\\n0 6\\n0000000000 65535 f \\n")
for number in range(1,6):
    pdf.extend(("%010d 00000 n \\n" % offsets[number]).encode())
pdf.extend(("trailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n%d\\n%%%%EOF\\n" % xref).encode())
open(out, "wb").write(pdf)
`;
  try {
    await exec('python3', ['-c', python, pdfPath], { timeout: 30000, maxBuffer: 1024 * 1024 });
    const bytes = await fs.readFile(pdfPath);
    const result = await ocrPdf(bytes, { maxPages: 2, dpi: 200 });
    assert.equal(result.totalPages, 1);
    assert.equal(result.pagesProcessed, 1);
    assert.equal(result.truncatedAtPageLimit, false);
    const recognized = result.pages.map(page => page.text).join('\\n').toUpperCase();
    assert.match(recognized, /GROUND FLOOR PLAN/);
    assert.match(recognized, /6000 MM/);
    assert.match(recognized, /CONCRETE C30/);
    assert.ok(result.pages[0].wordCount >= 8);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
